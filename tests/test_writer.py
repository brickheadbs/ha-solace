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


async def test_the_concurrent_family_glides_through_a_brightness_fade(hass, sent):
    """Verified: Aqara RGB glides colour smoothly alongside brightness fades."""
    writer = LightWriter(hass)
    await writer.async_set_brightness(ENTITY, 200, 600)
    await hass.async_block_till_done()
    sent.clear()

    assert await _step(hass, writer, SMOOTH, 3000, 4500) == 4500
    assert len(sent) == 1


async def test_turning_off_clears_the_busy_window(hass, sent):
    """Turning off clears the busy flag immediately."""
    writer = LightWriter(hass)
    await writer.async_set_brightness(ENTITY, 200, 600)
    await writer.async_turn_off(ENTITY, 4)
    await hass.async_block_till_done()
    sent.clear()

    assert await _step(hass, writer, STEPPED, 3000, 4000) == 4000
    assert len(sent) == 1


# ------------------------------------------------------------------ hardware clamps


async def test_the_bulbs_own_kelvin_limits_still_win(hass, sent):
    """Out-of-range targets are clamped strictly per bulb capability."""
    writer = LightWriter(hass)
    ikea_light = _light(Family.IKEA, min_k=2202, max_k=4000)
    result = await _step(hass, writer, STEPPED, 3000, 5600, light=ikea_light)
    assert result == 4000
    assert sent[0]["color_temp_kelvin"] == 4000


async def test_an_unknown_current_colour_writes_nothing(hass, sent):
    """If current colour is unknown, nothing is sent until wake or report."""
    writer = LightWriter(hass)
    assert await _step(hass, writer, SMOOTH, None, 4000) is None
    assert sent == []
