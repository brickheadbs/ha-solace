"""Colour-curve tests — dusk-anchored, mired-interpolated, clamped per bulb."""

from __future__ import annotations

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


def test_the_curve_holds_day_colour_before_dusk(house):
    assert target_kelvin(18.0, DUSK, house) == house.day_kelvin
    assert target_kelvin(21.4, DUSK, house) == house.day_kelvin


def test_the_glide_runs_from_dusk_for_the_configured_duration(house):
    """90 minutes, 4000K → 2200K, interpolated in mireds."""
    start = target_kelvin(DUSK, DUSK, house)
    middle = target_kelvin(DUSK + 0.75, DUSK, house)
    end = target_kelvin(DUSK + 1.5, DUSK, house)
    assert start == 4000
    assert end == 2200
    # Half-way in mireds is 352 mired ≈ 2840 K — NOT the 3100 K a Kelvin-linear
    # interpolation would give. Mired-linear is the settled decision.
    assert kelvin_to_mired(middle) == pytest.approx(352, abs=2)


def test_the_curve_is_continuous_across_midnight(house):
    """Anchored on `(clock - dusk) % 24`, so 23:30 → 00:30 → 03:00 is monotonic."""
    for hour in (23.5, 0.5, 3.0, 6.0):
        assert target_kelvin(hour, DUSK, house) == house.night_kelvin


def test_the_curve_releases_in_the_morning(house):
    assert target_kelvin(6.4, DUSK, house) == house.night_kelvin
    assert target_kelvin(6.5, DUSK, house) == house.day_kelvin
    assert target_kelvin(12.0, DUSK, house) == house.day_kelvin


def test_a_winter_dusk_works_the_same(house):
    """Civil dusk moves ~4.5 hours across the year at 54°N. Nothing may assume a time."""
    winter = 16.8
    assert target_kelvin(16.0, winter, house) == house.day_kelvin
    assert target_kelvin(winter + 1.5, winter, house) == house.night_kelvin
    assert target_kelvin(6.5, winter, house) == house.day_kelvin


def test_the_manual_trim_is_added_after_the_curve():
    house = HouseSettings(colour_trim_kelvin=200)
    assert target_kelvin(6.5, DUSK, house) == 4200


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
    result = resolve_colour(clock_hour=3.0, dusk_hour=DUSK, house=house, light=ikea)
    assert result.requested_kelvin == 2200
    assert result.kelvin == 2202
    assert result.mired == kelvin_to_mired(2202)
    assert result.was_clamped is True
