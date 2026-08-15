"""Colour-curve tests — dusk-anchored, mired-interpolated, clamped per bulb."""

from __future__ import annotations

from dataclasses import replace

import pytest

from custom_components.solace.colour import (
    clamp_kelvin,
    kelvin_to_mired,
    mired_to_kelvin,
    resolve_colour,
    target_kelvin,
)
from custom_components.solace.models import Family, HouseSettings, LightSettings

DUSK = 21.5  # civil dusk, a summer evening


@pytest.fixture
def house() -> HouseSettings:
    return HouseSettings()


def test_mired_round_trips():
    assert mired_to_kelvin(kelvin_to_mired(4000)) == pytest.approx(4000, abs=2)
    assert kelvin_to_mired(2200) == 455
    assert kelvin_to_mired(4000) == 250


def test_the_24h_colour_timeline_evaluates_correctly(house):
    """Default colour timeline smoothly transitions across 24 hours."""
    # 00:00 -> 2200K, 12:00 -> 4000K, 19:00 -> 3000K, 22:30 -> 2200K
    assert target_kelvin(0.0, house=house) == 2200
    assert target_kelvin(12.0, house=house) == 4000
    assert target_kelvin(19.0, house=house) == 3000
    assert target_kelvin(22.5, house=house) == 2200


def test_the_manual_trim_is_added_after_the_curve():
    house = HouseSettings(colour_trim_kelvin=200)
    assert target_kelvin(12.0, house=house) == 4000 + 200


# --------------------------------------------------------------------------------
# The per-bulb clamp — and making it visible
# --------------------------------------------------------------------------------


def test_ikea_bulbs_pin_at_4000k_and_say_so():
    """Five bulbs stop at 4000 K. The bulb reports success either way — the only way
    the clamp stops being invisible is if we carry it up to the panel."""
    ikea = LightSettings(
        entity_id="light.living_ceiling",
        family=Family.IKEA,
        min_kelvin=2202,
        max_kelvin=4000,
    )
    kelvin, clamped = clamp_kelvin(5000, ikea)
    assert kelvin == 4000
    assert clamped is True


def test_aqara_cct_floors_at_2702k():
    """A 2200 K bedtime target pins the six Aqara CCT bulbs."""
    cct = LightSettings(family=Family.AQARA_CCT, min_kelvin=2702, max_kelvin=6535)
    kelvin, clamped = clamp_kelvin(2200, cct)
    assert kelvin == 2702
    assert clamped is True


def test_an_in_range_target_is_not_flagged_as_clamped():
    rgb = LightSettings(family=Family.AQARA_RGB, min_kelvin=2000, max_kelvin=9009)
    kelvin, clamped = clamp_kelvin(2200, rgb)
    assert kelvin == 2200
    assert clamped is False


def test_resolve_colour_reports_both_what_was_asked_and_what_is_achievable(house):
    ikea = LightSettings(family=Family.IKEA, min_kelvin=2202, max_kelvin=4000)
    result = resolve_colour(clock_hour=0.0, dusk_hour=DUSK, house=house, light=ikea)
    assert result.requested_kelvin == 2200
    assert result.kelvin == 2202
    assert result.mired == kelvin_to_mired(2202)
    assert result.was_clamped is True
