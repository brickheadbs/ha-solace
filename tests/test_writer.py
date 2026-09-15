"""The write path — what actually reaches a bulb.

Smooth hardware transitions across macro-intervals (10-15 min) or wake transitions.
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


def _light(family: Family, min_k: int = 2000, max_k: int = 9009) -> LightSettings:
    return LightSettings(entity_id=ENTITY, family=family, min_kelvin=min_k, max_kelvin=max_k)


def _lit(hass, level: int = 120) -> None:
    """Put the bulb in hass.states, on, at a known level.

    A colour step now has to carry a brightness (see the bare-``state: ON`` invariant in
    ``async_step_colour``), and it reads that level from the entity. Without this the
    writer correctly refuses to send anything, so every colour test needs a lit bulb.
    """
    hass.states.async_set(ENTITY, "on", {"brightness": level})


async def _step(hass, writer, profile, current_k, target_k, transition_s=600.0, light=None):
    if light is None:
        light = _light(profile.family)
    result = await writer.async_step_colour(
        ENTITY,
        current_k,
        target_k,
        light,
        profile=profile,
        transition_s=transition_s,
    )
    await hass.async_block_till_done()
    return result


# ------------------------------------------------------------------ dead zone / tolerance


async def test_a_move_smaller_than_tolerance_writes_nothing(hass, sent):
    """Within 25 K tolerance, no write is sent to suppress radio noise."""
    writer = LightWriter(hass)
    assert await _step(hass, writer, SMOOTH, 3000, 3015) is None
    assert sent == []


async def test_a_move_above_tolerance_starts_transition(hass, sent):
    """When target drifts beyond tolerance, a smooth hardware transition begins."""
    writer = LightWriter(hass)
    _lit(hass)
    result = await _step(hass, writer, SMOOTH, 3000, 4500, transition_s=600.0)
    assert result == 4500
    assert len(sent) == 1
    assert sent[0]["color_temp_kelvin"] == 4500
    assert sent[0]["transition"] == 600.0


# ------------------------------------------------------------------ serialisation (IKEA vs Aqara)


async def test_the_serialised_family_defers_while_a_brightness_fade_runs(hass, sent):
    """Measured: a concurrent colour step freezes in-flight brightness on IKEA."""
    writer = LightWriter(hass)
    await writer.async_set_brightness(ENTITY, 200, 600)
    await hass.async_block_till_done()
    sent.clear()

    assert await _step(hass, writer, STEPPED, 3000, 4000) is None
    assert sent == []


async def test_colour_yields_to_brightness_on_every_family(hass, sent):
    """Colour now yields universally, not just on the non-concurrent families.

    Aqara *can* glide colour alongside a brightness fade — that measurement still stands.
    It no longer may, for a different reason: a colour step has to carry a brightness to
    avoid the bare ``state: ON`` fault, and writing that level mid-fade would truncate the
    very fade it rode in on. Brightness is the channel Brandon asked to protect
    (2026-09-13), so colour is the one that waits. Under the tier model brightness writes
    are rare and short, so the deferred step lands on the next heartbeat.
    """
    writer = LightWriter(hass)
    _lit(hass)
    await writer.async_set_brightness(ENTITY, 200, 600)
    await hass.async_block_till_done()
    sent.clear()

    assert await _step(hass, writer, SMOOTH, 3000, 4500) is None
    assert sent == []


async def test_turning_off_clears_the_busy_window(hass, sent):
    """Turning off clears the busy flag, so the fade no longer blocks colour."""
    writer = LightWriter(hass)
    await writer.async_set_brightness(ENTITY, 200, 600)
    await writer.async_turn_off(ENTITY, 4)
    await hass.async_block_till_done()
    sent.clear()

    # The busy window is gone (an in-flight fade would return None for a different
    # reason), so a lit bulb takes the step normally.
    _lit(hass)
    assert await _step(hass, writer, STEPPED, 3000, 4000) == 4000
    assert len(sent) == 1


async def test_an_off_bulb_never_receives_a_colour_step(hass, sent):
    """An off bulb has no level to carry, so it gets nothing.

    This is the guard against the fault reproduced on ``Kitchen Diner East`` 2026-09-13:
    a colour-only payload reaches z2m as a bare genOnOff ``On``, and the bulb jumps to its
    own ``OnLevel`` — off at level 4 to 76 to 152 in four seconds. Skipping costs one
    heartbeat; not skipping is a visible blink.
    """
    writer = LightWriter(hass)
    hass.states.async_set(ENTITY, "off", {"brightness": None})

    assert await _step(hass, writer, SMOOTH, 3000, 4500) is None
    assert sent == []


async def test_every_colour_step_carries_a_brightness(hass, sent):
    """The bare ``state: ON`` invariant, asserted on the payload itself."""
    writer = LightWriter(hass)
    _lit(hass, 137)

    assert await _step(hass, writer, SMOOTH, 3000, 4500) == 4500
    assert len(sent) == 1
    assert sent[0]["brightness"] == 137, "a colour step without brightness becomes a bare On"


# ------------------------------------------------------------------ hardware clamps


async def test_the_bulbs_own_kelvin_limits_still_win(hass, sent):
    """Out-of-range targets are clamped strictly per bulb capability."""
    writer = LightWriter(hass)
    _lit(hass)
    ikea_light = _light(Family.IKEA, min_k=2202, max_k=4000)
    result = await _step(hass, writer, STEPPED, 3000, 5600, light=ikea_light)
    assert result == 4000
    assert sent[0]["color_temp_kelvin"] == 4000


async def test_an_unknown_current_colour_writes_nothing(hass, sent):
    """If current colour is unknown, nothing is sent until wake or report."""
    writer = LightWriter(hass)
    assert await _step(hass, writer, SMOOTH, None, 4000) is None
    assert sent == []


async def test_in_flight_brightness_tracking_and_estimation(hass):
    """Estimated level reflects in-flight hardware transition progress."""
    writer = LightWriter(hass)
    t0 = hass.loop.time()
    await writer.async_set_brightness(ENTITY, 200, 100.0)
    await hass.async_block_till_done()

    flight = writer.get_in_flight_brightness(ENTITY)
    assert flight is not None
    assert flight[1] == 100.0
    assert flight[2] == 0  # started from 0
    assert flight[3] == 200

    # At t0, estimated level is 0
    assert writer.current_estimated_level(ENTITY) == 0

    # Halfway through (50s elapsed)
    hass.loop.time = lambda: t0 + 50.0
    assert writer.current_estimated_level(ENTITY) == 100

    # At completion (100s elapsed)
    hass.loop.time = lambda: t0 + 100.0
    assert writer.get_in_flight_brightness(ENTITY) is None
    # Reset loop time
    hass.loop.time = lambda: t0


async def test_turn_off_clears_in_flight_brightness(hass):
    """Turning off clears active in-flight brightness tracking."""
    writer = LightWriter(hass)
    await writer.async_set_brightness(ENTITY, 200, 100.0)
    await hass.async_block_till_done()
    assert writer.get_in_flight_brightness(ENTITY) is not None

    await writer.async_turn_off(ENTITY, 4.0)
    await hass.async_block_till_done()
    assert writer.get_in_flight_brightness(ENTITY) is None
