"""Dedicated unit tests for 2026-08-15 Master Processing and State Table architecture."""

import pytest

from custom_components.solace.engine import compute_state_table, solve, solve_master
from custom_components.solace.models import (
    DEFAULT_LUX_CURVE,
    EngineInput,
    Family,
    HouseSettings,
    LightSettings,
    Mode,
    RoomSettings,
    SplinePoint,
    ZoneSettings,
)


@pytest.fixture
def house() -> HouseSettings:
    return HouseSettings()


@pytest.fixture
def bedroom() -> RoomSettings:
    return RoomSettings(name="Bedroom", night_off=True, ambience_level=0)


@pytest.fixture
def kitchen() -> RoomSettings:
    return RoomSettings(name="Kitchen", ambience_level=15)


@pytest.fixture
def ceiling_light() -> LightSettings:
    return LightSettings(
        entity_id="light.living_ceiling",
        family=Family.IKEA,
        clamp_min=0,
        clamp_max=12,  # 5% hard glare clamp
    )


@pytest.fixture
def normal_light() -> LightSettings:
    return LightSettings(
        entity_id="light.kitchen_diner",
        family=Family.AQARA_CCT,
        clamp_min=0,
        clamp_max=254,
    )


def test_master_processing_spline_curves_and_cloudy_boost():
    """Verify Master Processing generates baseline target brightness and colour from splines."""
    custom_lux = (
        SplinePoint(0.0, 1.0),
        SplinePoint(100.0, 0.8),
        SplinePoint(1000.0, 0.2),
        SplinePoint(3000.0, 0.0),
    )
    custom_bright = (
        SplinePoint(0.0, 30.0),
        SplinePoint(9.0, 254.0),
        SplinePoint(18.0, 180.0),
        SplinePoint(23.0, 30.0),
        SplinePoint(24.0, 30.0),
    )
    house_custom = HouseSettings(
        lux_curve=custom_lux,
        brightness_timeline=custom_bright,
        cloudy_boost_stops=0.5,
    )

    # 1. Daytime high focus at 12:00 with dark overcast (100 lx)
    out = solve_master(lux=100.0, clock_hour=12.0, house=house_custom)
    assert out.spline_demand == 0.8
    assert out.cloudy_boost_stops == 0.5
    # Demand boosted: 0.8 * 2^0.5 = 0.8 * 1.414 = 1.0 (clamped)
    assert out.demand == 1.0
    assert out.time_brightness_level > 200
    assert out.target_brightness > 200

    # 2. Bright midday sun (5000 lx) -> 0 demand regardless of boost
    bright_sun = solve_master(lux=5000.0, clock_hour=12.0, house=house_custom)
    assert bright_sun.demand == 0.0
    assert bright_sun.target_brightness == 0


def test_state_table_precomputation(house, kitchen, normal_light):
    """Verify StateTable pre-computes L1, L2, L3, Ls with zero occupancy lag."""
    zone = ZoneSettings(zone_id="diner", name="Diner", diminish_stops=1.0)
    master = solve_master(lux=10.0, clock_hour=14.0, house=house)

    state = compute_state_table(
        master=master,
        house=house,
        room=kitchen,
        light=normal_light,
        clock_hour=14.0,
        zone=zone,
    )

    assert state.l1 == 161
    # L2 is 1.0 stop below L1 (50% light output)
    assert state.l2 == 80
    # L3 is fixed kitchen ambience level
    assert state.l3 == 15
    # Ls is housewide night level
    assert state.ls == 3
    assert state.target_kelvin > 2000


def test_hardware_clamps_enforced_in_state_table(house, kitchen, ceiling_light):
    """Living ceiling 5% glare clamp (12) must clamp L1, L2, L3, Ls."""
    master = solve_master(lux=1.0, clock_hour=14.0, house=house)
    state = compute_state_table(
        master=master,
        house=house,
        room=kitchen,
        light=ceiling_light,
        clock_hour=14.0,
    )

    assert state.l1 == 12  # clamped from 254 down to 12
    assert state.l2 <= 12
    assert state.l3 <= 12
    assert state.ls <= 12


def test_bedroom_sleep_mode_forced_off_across_all_modes(house, bedroom, normal_light):
    """Bedroom sleep mode forces level 0 across Normal, Night, Summer Dawn, and Naps."""
    # 1. 04:30 bright summer dawn (lux 500, clock 04:30) while asleep in bedroom
    summer_dawn = solve(
        house,
        bedroom,
        normal_light,
        EngineInput(lux=500.0, occupied=True, dnd=True, clock_hour=4.5, asleep=True, night_active=False),
    )
    assert summer_dawn.level == 0
    assert summer_dawn.source == "sleep"

    # 2. Midday nap (lux 2000, clock 13:00) while asleep
    midday_nap = solve(
        house,
        bedroom,
        normal_light,
        EngineInput(lux=2000.0, occupied=True, dnd=True, clock_hour=13.0, asleep=True, night_active=False),
    )
    assert midday_nap.level == 0
    assert midday_nap.source == "sleep"

    # 3. 03:00 Night Mode while asleep
    night_asleep = solve(
        house,
        bedroom,
        normal_light,
        EngineInput(lux=0.0, occupied=True, dnd=True, clock_hour=3.0, asleep=True, night_active=True),
    )
    assert night_asleep.level == 0
    assert night_asleep.source == "sleep"

    # 4. Wake up in the night (asleep = False, night_active = True) -> turns on to low night level
    night_awake = solve(
        house,
        bedroom,
        normal_light,
        EngineInput(lux=0.0, occupied=True, dnd=False, clock_hour=3.0, asleep=False, night_active=True),
    )
    assert night_awake.level == house.night_level
    assert night_awake.source == "night"


def test_bedroom_virtual_sunrise_and_sunset(house, bedroom, normal_light):
    """Verify Bedroom Virtual Sunrise and Virtual Sunset progress calculation."""
    # Sunrise at 50% progress
    sunrise_50 = solve(
        house,
        bedroom,
        normal_light,
        EngineInput(
            lux=0.0,
            occupied=True,
            dnd=False,
            clock_hour=6.0,
            asleep=False,
            sunrise_progress=0.5,
        ),
    )
    assert sunrise_50.mode is Mode.SUNRISE
    assert 0 < sunrise_50.level < house.virtual_sunrise_target_level
    assert sunrise_50.source == "sunrise"

    # Sunset at 80% progress (almost dark)
    sunset_80 = solve(
        house,
        bedroom,
        normal_light,
        EngineInput(
            lux=0.0,
            occupied=True,
            dnd=False,
            clock_hour=23.0,
            asleep=False,
            sunset_progress=0.8,
        ),
    )
    assert sunset_80.mode is Mode.SUNSET
    assert sunset_80.level < 80
    assert sunset_80.source == "sunset"
