"""The write path — what actually reaches a bulb.

``fade.py`` decides the *shape*; this file checks the writer executes it. Most of what is
tested here is invisible from the outside: a skipped step, a slightly-too-small move, a
catch-up. All of them fail silently on real hardware, which is exactly why they get tests.
"""

from __future__ import annotations

import pytest
from homeassistant.core import HomeAssistant

from custom_components.solace.colour import kelvin_to_mired, mired_to_kelvin
from custom_components.solace.fade import fade_profile
from custom_components.solace.models import Family, LightSettings
from custom_components.solace.writer import LightWriter

ENTITY = "light.test"

SMOOTH = fade_profile(
    Family.AQARA_RGB,
    smooth_step_mired=2,
    stepped_step_mired=5,
    step_transition_s=4.0,
    catch_up_steps=3,
)
STEPPED = fade_profile(
    Family.IKEA,
    smooth_step_mired=2,
    stepped_step_mired=5,
    step_transition_s=4.0,
    catch_up_steps=3,
)


@pytest.fixture
def sent(hass: HomeAssistant):
    """Every `light.turn_on` payload the writer emits."""
    calls: list[dict] = []

    async def _record(call):
        calls.append(dict(call.data))

    hass.services.async_register("light", "turn_on", _record)
    hass.services.async_register("light", "turn_off", _record)
    return calls


def _light(family: Family) -> LightSettings:
    return LightSettings(entity_id=ENTITY, family=family, min_kelvin=2000, max_kelvin=9009)


async def _step(hass, writer, profile, current_k, target_k):
    result = await writer.async_step_colour(
        ENTITY,
        current_k,
        target_k,
        _light(profile.family),
        profile=profile,
        r_crit=0.156,
        safety=1.5,
    )
    await hass.async_block_till_done()
    return result


# ------------------------------------------------------------------ the colour dead zone


async def test_a_move_smaller_than_one_step_is_not_worth_a_radio_write(hass, sent):
    """The colour dead zone. Without it every tick writes to every bulb, forever,
    chattering at a target it has effectively reached."""
    writer = LightWriter(hass)
    current = mired_to_kelvin(300)
    just_under = mired_to_kelvin(300 + SMOOTH.step_mired - 1)
    assert await _step(hass, writer, SMOOTH, current, just_under) is None
    assert sent == []


async def test_a_move_of_exactly_one_step_does_write(hass, sent):
    writer = LightWriter(hass)
    current = mired_to_kelvin(300)
    target = mired_to_kelvin(300 + SMOOTH.step_mired)
    assert await _step(hass, writer, SMOOTH, current, target) is not None
    assert len(sent) == 1


async def test_the_coarse_family_has_a_wider_dead_zone_than_the_fine_one(hass, sent):
    """Same tick, same curve, two families: the fine one moves and the coarse one waits.
    That is the whole mechanism by which one clock serves both."""
    writer = LightWriter(hass)
    current = mired_to_kelvin(300)
    target = mired_to_kelvin(303)  # 3 mired: past the smooth step, short of the stepped
    assert await _step(hass, writer, SMOOTH, current, target) is not None
    assert await _step(hass, writer, STEPPED, current, target) is None
    assert len(sent) == 1


# ------------------------------------------------------------------ step sizing


async def test_a_step_never_overshoots_the_target(hass, sent):
    writer = LightWriter(hass)
    target_mired = 306
    result = await _step(
        hass, writer, SMOOTH, mired_to_kelvin(300), mired_to_kelvin(target_mired)
    )
    assert kelvin_to_mired(result) <= target_mired


async def test_a_single_move_is_capped_at_the_catch_up_ceiling(hass, sent):
    """A bulb 100 mired behind must not lurch there in one 4 s fade."""
    writer = LightWriter(hass)
    result = await _step(hass, writer, SMOOTH, mired_to_kelvin(300), mired_to_kelvin(400))
    moved = kelvin_to_mired(result) - 300
    assert moved == SMOOTH.max_step_mired


async def test_a_move_downward_is_capped_the_same_way(hass, sent):
    writer = LightWriter(hass)
    result = await _step(hass, writer, SMOOTH, mired_to_kelvin(400), mired_to_kelvin(300))
    assert 400 - kelvin_to_mired(result) == SMOOTH.max_step_mired


async def test_the_step_carries_its_own_short_fade_never_the_hold(hass, sent):
    """The single most expensive thing to get wrong in this file: stretching a step's
    transition across its hold interval drops R below the floor and stalls the bulb."""
    writer = LightWriter(hass)
    await _step(hass, writer, SMOOTH, mired_to_kelvin(300), mired_to_kelvin(400))
    assert sent[0]["transition"] == SMOOTH.step_transition_s


# ------------------------------------------------------------------ serialisation


async def test_the_serialised_family_defers_while_a_brightness_fade_runs(hass, sent):
    """Measured: a colour step froze an in-flight brightness fade at 84 for 420 s."""
    writer = LightWriter(hass)
    await writer.async_set_brightness(ENTITY, 200, 600)
    await hass.async_block_till_done()
    sent.clear()

    assert await _step(hass, writer, STEPPED, mired_to_kelvin(300), mired_to_kelvin(400)) is None
    assert sent == []


async def test_the_concurrent_family_glides_through_a_brightness_fade(hass, sent):
    """Verified in both directions on both Aqara families, including a 4-bulb RGB combo
    that hit its brightness target exactly while colour stepped alongside."""
    writer = LightWriter(hass)
    await writer.async_set_brightness(ENTITY, 200, 600)
    await hass.async_block_till_done()
    sent.clear()

    assert await _step(hass, writer, SMOOTH, mired_to_kelvin(300), mired_to_kelvin(400)) is not None
    assert len(sent) == 1


async def test_turning_off_clears_the_busy_window(hass, sent):
    """Otherwise a bulb switched off mid-fade stays 'busy' for the rest of the fade and
    silently refuses its colour steps after it comes back on."""
    writer = LightWriter(hass)
    await writer.async_set_brightness(ENTITY, 200, 600)
    await writer.async_turn_off(ENTITY, 4)
    await hass.async_block_till_done()
    sent.clear()

    assert await _step(hass, writer, STEPPED, mired_to_kelvin(300), mired_to_kelvin(400)) is not None


# ------------------------------------------------------------------ catching up


async def test_a_deferred_family_catches_up_rather_than_falling_behind(hass, sent):
    """The failure this exists to prevent: a family that skips steps while brightness
    runs, then only ever moves one step per tick, drifts away from the curve for the
    rest of the evening. Catch-up is safe — a bigger delta over the same short fade
    raises R, away from the underflow floor."""
    writer = LightWriter(hass)
    behind = STEPPED.step_mired * 3
    result = await _step(
        hass, writer, STEPPED, mired_to_kelvin(300), mired_to_kelvin(300 + behind)
    )
    assert kelvin_to_mired(result) - 300 == behind
    assert behind > STEPPED.step_mired


async def test_the_bulbs_own_kelvin_limits_still_win(hass, sent):
    """Out-of-range is accepted, pinned and logged as a success by the hardware, so the
    clamp has to happen here or it never visibly happens at all."""
    writer = LightWriter(hass)
    light = LightSettings(entity_id=ENTITY, family=Family.IKEA, min_kelvin=2702, max_kelvin=4000)
    await writer.async_step_colour(
        ENTITY,
        4000,
        9009,
        light,
        profile=STEPPED,
        r_crit=0.156,
        safety=1.5,
    )
    await hass.async_block_till_done()
    assert sent[0]["color_temp_kelvin"] <= 4000


async def test_an_unknown_current_colour_writes_nothing(hass, sent):
    """A bulb that has not reported its colour cannot be stepped *relative* to anything.
    Guessing a start point is how a bulb ends up commanded to the wrong rail."""
    writer = LightWriter(hass)
    assert await _step(hass, writer, SMOOTH, None, 3000) is None
    assert sent == []
