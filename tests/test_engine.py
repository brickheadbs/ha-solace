"""Engine tests — the 17-step contract, and every trap that has already been paid for.

Each test that encodes a *bug* names it. These are regression tests for real failures
found during design, not hypothetical edge cases.
"""

from __future__ import annotations

import pytest

from custom_components.solace.engine import (
    ambient_gate,
    apply_clamp,
    clip_to_full,
    debounce_gate,
    demand,
    past_dead_zone,
    ramp_bias,
    rate_limit,
    solve,
    to_level,
)
from custom_components.solace.models import (
    EngineInput,
    Family,
    HouseSettings,
    LightSettings,
    Mode,
    RampPoint,
    RoomSettings,
)


@pytest.fixture
def house() -> HouseSettings:
    """The six-tab starting values."""
    return HouseSettings()


@pytest.fixture
def room() -> RoomSettings:
    return RoomSettings(name="Kitchen")


@pytest.fixture
def light() -> LightSettings:
    return LightSettings(entity_id="light.kitchen_diner_floor_se", family=Family.AQARA_CCT)


def _input(**kwargs) -> EngineInput:
    base = {
        "lux": 10.0,
        "occupied": True,
        "dnd": False,
        "clock_hour": 14.0,  # daytime: outside the evening ramp
        "gate_open": False,  # start closed, as the brief's property table does
    }
    base.update(kwargs)
    return EngineInput(**base)


# --------------------------------------------------------------------------------
# Step 3 — demand
# --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("lux", "expected_level"),
    [(10.0, 161), (40.0, 105), (49.0, 97)],
)
def test_demand_matches_the_brief_property_table(house, room, light, lux, expected_level):
    """The settled-level table from the brief's gate/demand property test."""
    result = solve(house, room, light, _input(lux=lux))
    assert result.level == expected_level


def test_demand_is_full_at_or_below_lux_full(house):
    assert demand(0.0, house) == 1.0
    assert demand(house.lux_full, house) == 1.0


def test_demand_is_zero_at_the_top_of_the_window(house):
    assert demand(house.lux_full + house.lux_window, house) == 0.0
    assert demand(50_000.0, house) == 0.0


def test_demand_is_monotonically_decreasing(house):
    values = [demand(lux, house) for lux in (1, 5, 20, 80, 300, 539)]
    assert values == sorted(values, reverse=True)


# --------------------------------------------------------------------------------
# Step 2 — the ambient gate
# --------------------------------------------------------------------------------


def test_gate_hysteresis_does_not_flicker_at_the_boundary(house):
    """50/80 lx with hysteresis: the gate must not chatter between them."""
    # Rising out of darkness — stays open right through the 50 lx mark.
    assert ambient_gate(60.0, was_open=True, house=house) is True
    assert ambient_gate(79.9, was_open=True, house=house) is True
    assert ambient_gate(80.0, was_open=True, house=house) is False
    # Falling out of daylight — stays shut until 50.
    assert ambient_gate(60.0, was_open=False, house=house) is False
    assert ambient_gate(51.0, was_open=False, house=house) is False
    assert ambient_gate(50.0, was_open=False, house=house) is True


def test_gate_shut_zeroes_the_room_even_though_demand_is_nonzero(house, room, light):
    """From the brief: at 51 lx the gate is shut while demand is still ~0.35.

    Not a bug — two mechanisms answering different questions. Recorded as a test so
    nobody "fixes" it by hardcoding a relationship between the two windows.
    """
    assert demand(51.0, house) > 0.3
    assert solve(house, room, light, _input(lux=51.0)).level == 0
    assert solve(house, room, light, _input(lux=400.0)).level == 0


def test_debounce_defaults_to_zero_and_zero_means_no_debounce(house):
    """THE DEBOUNCE RULE. 0 must mean *no* debounce, not "a very short one"."""
    assert house.gate_debounce_rising_s == 0.0
    assert house.gate_debounce_falling_s == 0.0
    state, pending = debounce_gate(True, False, now=100.0, pending_since=None, house=house)
    assert state is True
    assert pending is None


def test_debounce_holds_the_old_state_until_the_delay_elapses():
    house = HouseSettings(gate_debounce_rising_s=180.0)
    # raw says "close the gate" (bright); we were open. Rising debounce applies.
    state, pending = debounce_gate(False, True, now=0.0, pending_since=None, house=house)
    assert state is True and pending == 0.0
    state, pending = debounce_gate(False, True, now=179.0, pending_since=0.0, house=house)
    assert state is True and pending == 0.0
    state, pending = debounce_gate(False, True, now=180.0, pending_since=0.0, house=house)
    assert state is False and pending is None


def test_debounce_pending_clears_when_the_world_changes_back(house):
    state, pending = debounce_gate(True, True, now=50.0, pending_since=10.0, house=house)
    assert state is True and pending is None


# --------------------------------------------------------------------------------
# Step 4 — the evening ramp, and the midnight trap
# --------------------------------------------------------------------------------


def test_ramp_interpolates_continuously_between_points(house):
    assert ramp_bias(20.0, house) == pytest.approx(-0.5)
    assert ramp_bias(21.25, house) == pytest.approx(-1.0)
    assert ramp_bias(22.5, house) == pytest.approx(-1.5)


def test_ramp_is_flat_before_it_opens(house):
    """A deliberate step at the first point — the live blueprint has no bias at 19:00."""
    assert ramp_bias(18.0, house) == 0.0
    assert ramp_bias(19.9, house) == 0.0
    assert ramp_bias(20.0, house) == pytest.approx(-0.5)


def test_ramp_survives_midnight(house):
    """TRAP #1. A decimal clock comparison breaks after 00:00 (`23.5 < 6.5` is False).

    The ramp must hold its last value through midnight rather than snapping to 0.
    """
    assert ramp_bias(23.5, house) == pytest.approx(-1.5)
    assert ramp_bias(0.5, house) == pytest.approx(-1.5)
    assert ramp_bias(3.0, house) == pytest.approx(-1.5)


def test_ramp_has_an_explicit_morning_release(house):
    """Without the release the ramp holds -1.5 stops all the next day."""
    assert ramp_bias(6.4, house) == pytest.approx(-1.5)
    assert ramp_bias(6.5, house) == 0.0
    assert ramp_bias(12.0, house) == 0.0
    assert ramp_bias(17.9, house) == 0.0


def test_ramp_supports_more_than_two_points():
    """"Build it as an ordered list from the start" — two points are config, not schema."""
    house = HouseSettings(
        ramp=(
            RampPoint(19.0, -0.25),
            RampPoint(21.0, -0.75),
            RampPoint(23.0, -2.0),
        )
    )
    assert ramp_bias(19.0, house) == pytest.approx(-0.25)
    assert ramp_bias(20.0, house) == pytest.approx(-0.5)
    assert ramp_bias(22.0, house) == pytest.approx(-1.375)
    assert ramp_bias(23.0, house) == pytest.approx(-2.0)


def test_ramp_points_out_of_order_are_sorted_not_trusted():
    house = HouseSettings(ramp=(RampPoint(22.5, -1.5), RampPoint(20.0, -0.5)))
    assert ramp_bias(21.25, house) == pytest.approx(-1.0)


# --------------------------------------------------------------------------------
# Steps 5-7 — bias, clip, level
# --------------------------------------------------------------------------------


def test_bias_is_additive_across_all_four_levels(house, room, light):
    """Additive so a parent dial moves everything while children keep their offsets."""
    house = HouseSettings(bias_stops=0.5)
    room = RoomSettings(bias_stops=0.25, zone_bias_stops=0.25)
    light = LightSettings(bias_stops=-1.0)
    result = solve(house, room, light, _input(lux=10.0))
    assert result.stops == pytest.approx(0.0)


def test_one_stop_doubles_the_light(house, room, light):
    base = solve(house, room, light, _input(lux=100.0))
    up = solve(house, RoomSettings(bias_stops=1.0), light, _input(lux=100.0))
    assert up.fraction == pytest.approx(base.fraction * 2)


def test_clip_stops_bias_pushing_demand_past_full():
    """Step 6 is the CLIP. Distinct from the step-14 CLAMP — do not conflate."""
    assert clip_to_full(0.8, 2.0) == 1.0
    assert clip_to_full(0.1, 1.0) == pytest.approx(0.2)
    assert clip_to_full(0.1, -1.0) == pytest.approx(0.05)


def test_levels_are_integers_on_the_0_254_scale():
    assert to_level(1.0) == 254
    assert to_level(0.0) == 0
    assert isinstance(to_level(0.5), int)
    assert to_level(0.5) == 127


# --------------------------------------------------------------------------------
# Step 8-13 — the gates
# --------------------------------------------------------------------------------


def test_night_mode_is_a_fixed_level_not_a_scaling(house, room, light):
    """"Predictable when half asleep." Night must not vary with outdoor lux."""
    dark = solve(house, room, light, _input(lux=1.0, night_active=True, asleep=True))
    dimmer = solve(house, room, light, _input(lux=45.0, night_active=True, asleep=True))
    assert dark.mode is Mode.NIGHT
    assert dark.level == dimmer.level == house.night_level


def test_ambience_is_a_floor_that_never_lowers_the_level(house, room, light):
    house = HouseSettings(ambience_level=20)
    bright_room = solve(house, room, light, _input(lux=10.0))  # computes ~161
    assert bright_room.level == 161  # floor did not pull it down
    dim = solve(house, RoomSettings(bias_stops=-5.0), light, _input(lux=10.0))
    assert dim.level == 20  # floor lifted it


def test_ambience_is_off_when_asleep(house, room, light):
    """Ambience applies while DND is OFF. DND on ⇒ asleep ⇒ night level, not a floor."""
    house = HouseSettings(ambience_level=20, night_level=3)
    result = solve(house, RoomSettings(bias_stops=-5.0), light,
                   _input(lux=10.0, night_active=True, asleep=True))
    assert result.level == 3


def test_ambience_zero_disables_the_feature(house, room, light):
    house = HouseSettings(ambience_level=0)
    result = solve(house, RoomSettings(bias_stops=-6.0), light, _input(lux=10.0))
    assert result.level < 5


def test_diminish_reduces_and_stays_never_switches_off(house, light):
    """Kitchen only. The near sensor reading clear must NOT be an off."""
    room = RoomSettings(diminish_pct=40.0)
    full = solve(house, room, light, _input(lux=10.0, diminish_active=False))
    reduced = solve(house, room, light, _input(lux=10.0, diminish_active=True))
    assert full.level == 161
    assert reduced.level == 97
    assert reduced.level > 0


def test_diminish_zero_has_no_effect(house, light):
    room = RoomSettings(diminish_pct=0.0)
    assert solve(house, room, light, _input(lux=10.0, diminish_active=True)).level == 161


def test_unoccupied_is_zero(house, room, light):
    assert solve(house, room, light, _input(lux=10.0, occupied=False)).level == 0


def test_min_cutoff_prefers_off_to_a_useless_glow(house, light):
    house = HouseSettings(min_cutoff=10)
    room = RoomSettings(bias_stops=-6.0)
    result = solve(house, room, light, _input(lux=10.0))
    assert result.level == 0


def test_manual_wins_over_everything_computed(house, room, light):
    """Including the gate and occupancy — manual is step 13, after every gate."""
    result = solve(
        house, room, light, _input(lux=5000.0, occupied=False, manual_level=200)
    )
    assert result.level == 200


# --------------------------------------------------------------------------------
# Step 14 — the clamp
# --------------------------------------------------------------------------------


def test_clamp_never_lifts_an_off_light_off_zero():
    """THE BUG, found 2026-08-11.

    Clamping 0 up to clamp_min leaves the room glowing at level 1 instead of off.
    """
    ceiling = LightSettings(entity_id="light.living_ceiling", clamp_min=1, clamp_max=10)
    assert apply_clamp(0, ceiling) == 0
    assert apply_clamp(1, ceiling) == 1
    assert apply_clamp(200, ceiling) == 10


def test_clamp_survives_every_upstream_stage(house, room):
    """Per-light hard limits must survive bias, ambience and manual alike."""
    ceiling = LightSettings(entity_id="light.living_ceiling", clamp_max=10)
    loud = solve(HouseSettings(bias_stops=2.0), room, ceiling, _input(lux=1.0))
    assert loud.level == 10
    manual = solve(house, room, ceiling, _input(lux=1.0, manual_level=254))
    assert manual.level == 10


def test_a_gated_off_light_stays_off_despite_a_clamp_minimum(house, room):
    ceiling = LightSettings(entity_id="light.living_ceiling", clamp_min=5, clamp_max=10)
    assert solve(house, room, ceiling, _input(lux=10.0, occupied=False)).level == 0


# --------------------------------------------------------------------------------
# Step 15 — the rate limiter
# --------------------------------------------------------------------------------


def test_rate_limiter_goes_to_zero_immediately():
    """THE TRACED FAILURE: light at 60, target 0, naive limiter moved it UP to 54."""
    assert rate_limit(current=60, target=0, step=6) == 0


def test_rate_limiter_turns_on_straight_to_level():
    """Otherwise it creeps 6 → 12 → 18 instead of turning on."""
    assert rate_limit(current=0, target=52, step=6) == 52


def test_rate_limiter_caps_only_tracking():
    """Where hunting can actually occur, it still limits."""
    assert rate_limit(current=52, target=74, step=6) == 58
    assert rate_limit(current=74, target=52, step=6) == 68


def test_rate_limiter_zero_step_means_unlimited():
    assert rate_limit(current=52, target=200, step=0) == 200


# --------------------------------------------------------------------------------
# Step 16 — the dead zone
# --------------------------------------------------------------------------------


def test_dead_zone_suppresses_small_changes():
    assert past_dead_zone(52, 51, dead_zone=2) is False
    assert past_dead_zone(54, 52, dead_zone=2) is True


def test_dead_zone_never_swallows_an_off_or_an_on():
    assert past_dead_zone(0, 1, dead_zone=10) is True
    assert past_dead_zone(1, 0, dead_zone=10) is True
    assert past_dead_zone(0, 0, dead_zone=10) is False


def test_first_write_always_happens():
    assert past_dead_zone(52, None, dead_zone=10) is True


# --------------------------------------------------------------------------------
# The trace
# --------------------------------------------------------------------------------


def test_solution_carries_a_full_trace(house, room, light):
    """The panel must render the consequence beside the control, which needs the
    intermediates, not just the answer."""
    result = solve(house, room, light, _input(lux=10.0))
    steps = dict(result.trace)
    assert steps["lux"] == 10.0
    assert steps["gate_open"] is True
    assert 0 < steps["demand"] < 1
    assert steps["level_raw"] == 161
    assert steps["clamped"] == 161


# --------------------------------------------------------------------------------
# Bedroom at night, and ambience-vs-occupancy (both settled by Brandon 2026-08-13)
# --------------------------------------------------------------------------------


def test_a_night_off_room_goes_fully_dark_when_asleep(house, light):
    """The bedroom's rule. A night level in the room he is asleep in is not a gentler
    version of off — it is a light on."""
    bedroom = RoomSettings(name="Bedroom", night_off=True)
    result = solve(house, bedroom, light, _input(lux=1.0, night_active=True, asleep=True))
    assert result.mode is Mode.NIGHT
    assert result.level == 0


def test_other_rooms_still_get_the_night_level_when_asleep(house, room, light):
    got = solve(house, room, light, _input(lux=1.0, night_active=True, asleep=True))
    assert got.level == house.night_level


def test_getting_up_relights_the_bedroom_at_the_night_level(house, light):
    """THE BUG THIS REPLACES — the one that would have burned him at 06:00.

    Measured over 72 h: the phone's DND clears the *moment he gets out of bed*
    (on 22:49 → off 05:59 → on 07:25). So `asleep` goes False while `night_active`
    stays latched, and the bedroom must come back at the NIGHT level.

    Brandon: "If I wake up and get out of bed, it will turn off and the lights come on
    to the low night setting and I can see."
    """
    bedroom = RoomSettings(name="Bedroom", night_off=True)
    got = solve(house, bedroom, light, _input(lux=1.0, night_active=True, asleep=False))
    assert got.mode is Mode.NIGHT
    assert got.level == house.night_level


def test_getting_up_must_not_relight_the_house_at_full_demand(house, room, light):
    """The failure mode of the version this replaces.

    Defining night as "DND is on right now" ends night mode the instant he stands up.
    The engine then recomputes from a pitch-dark lux reading and lights the room at
    near-full demand. The latch is what stands between him and that.
    """
    latched = solve(house, room, light, _input(lux=1.0, night_active=True, asleep=False))
    unlatched = solve(house, room, light, _input(lux=1.0, night_active=False, asleep=False))
    assert latched.level == house.night_level
    assert unlatched.level > 150  # what he would have been hit with
    assert latched.level < unlatched.level


def test_night_off_does_nothing_while_awake(house, light):
    bedroom = RoomSettings(name="Bedroom", night_off=True)
    assert solve(house, bedroom, light, _input(lux=10.0)).level == 161


def test_ambience_survives_an_empty_room(house, light):
    """Brandon: ambience conditions are "below threshold and awake" — two conditions.
    Occupancy is not one of them."""
    house = HouseSettings(ambience_level=20)
    assert house.ambience_ignores_occupancy is True
    result = solve(house, RoomSettings(), light, _input(lux=10.0, occupied=False))
    assert result.level == 20


def test_ambience_still_goes_out_when_he_falls_asleep(house, light):
    """DND on ⇒ asleep ⇒ the awake glow ends. An occupied room drops from the 20 floor
    to the night level, not to it."""
    house = HouseSettings(ambience_level=20, night_level=3)
    result = solve(house, RoomSettings(), light,
                   _input(lux=10.0, occupied=True, night_active=True, asleep=True))
    assert result.level == 3


def test_an_empty_room_is_dark_once_he_is_asleep(house, light):
    """Ambience is the *awake* glow. Asleep + empty is off, not a night level."""
    house = HouseSettings(ambience_level=20, night_level=3)
    result = solve(house, RoomSettings(), light,
                   _input(lux=10.0, occupied=False, night_active=True, asleep=True))
    assert result.level == 0


def test_ambience_never_lowers_an_occupied_room(house, light):
    house = HouseSettings(ambience_level=20)
    assert solve(house, RoomSettings(), light, _input(lux=10.0, occupied=True)).level == 161


def test_ambience_and_night_off_together_leave_the_bedroom_dark(house, light):
    """The combination that matters: awake-glow on house-wide, bedroom asleep."""
    house = HouseSettings(ambience_level=20)
    bedroom = RoomSettings(name="Bedroom", night_off=True)
    result = solve(house, bedroom, light,
                   _input(lux=10.0, occupied=False, night_active=True, asleep=True))
    assert result.level == 0


def test_a_bright_empty_house_stays_dark_despite_ambience(house, light):
    """Ambience is gated on the lux threshold, so daytime is unaffected."""
    house = HouseSettings(ambience_level=20)
    assert solve(house, RoomSettings(), light, _input(lux=400.0, occupied=False)).level == 0
