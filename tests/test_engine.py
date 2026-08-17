"""Engine tests — the 17-step contract, and every trap that has already been paid for.

Each test that encodes a *bug* names it. These are regression tests for real failures
found during design, not hypothetical edge cases.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from custom_components.solace.engine import (
    ambience_threshold,
    apply_clamp,
    clip_to_full,
    compute_state_table,
    debounce_ambience,
    demand,
    past_dead_zone,
    ramp_bias,
    rate_limit,
    solve,
    solve_master,
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
    SplinePoint,
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
        "ambience_open": False,  # start closed, as the brief's property table does
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
    assert ambience_threshold(60.0, was_open=True, house=house) is True
    assert ambience_threshold(79.9, was_open=True, house=house) is True
    assert ambience_threshold(80.0, was_open=True, house=house) is False
    # Falling out of daylight — stays shut until 50.
    assert ambience_threshold(60.0, was_open=False, house=house) is False
    assert ambience_threshold(51.0, was_open=False, house=house) is False
    assert ambience_threshold(50.0, was_open=False, house=house) is True


def test_the_ambience_threshold_does_not_switch_normal_lighting_off(house, room, light):
    """⚠️ THE 2026-08-13 BUG, inverted into a guard.

    This test used to assert the opposite — that at 51 lx an occupied room goes to 0
    because the ambience threshold (50/80) is shut — and it called that "two mechanisms
    answering different questions, recorded so nobody fixes it".

    It was the bug, and the test was holding it in place. Owner: *"It isn't supposed to
    be a gate. It is supposed to ONLY be for ambience lighting."* An occupied room with
    real demand lights, whatever the ambience threshold says.
    """
    assert demand(51.0, house) > 0.3
    assert solve(house, room, light, _input(lux=51.0)).level > 0

    # Normal lighting still goes out on its own — via DEMAND reaching zero at
    # lux_full + lux_window, which is what makes that window mean what the panel says.
    out_at = house.lux_full + house.lux_window
    assert demand(out_at, house) == 0.0
    assert solve(house, room, light, _input(lux=out_at)).level == 0
    # ...and it is still lit just below that point.
    assert solve(house, room, light, _input(lux=out_at * 0.5)).level > 0


def test_debounce_defaults_to_zero_and_zero_means_no_debounce(house):
    """THE DEBOUNCE RULE. 0 must mean *no* debounce, not "a very short one"."""
    assert house.ambience_debounce_rising_s == 0.0
    assert house.ambience_debounce_falling_s == 0.0
    state, pending = debounce_ambience(True, False, now=100.0, pending_since=None, house=house)
    assert state is True
    assert pending is None


def test_debounce_holds_the_old_state_until_the_delay_elapses():
    house = HouseSettings(ambience_debounce_rising_s=180.0)
    # raw says "close the gate" (bright); we were open. Rising debounce applies.
    state, pending = debounce_ambience(False, True, now=0.0, pending_since=None, house=house)
    assert state is True and pending == 0.0
    state, pending = debounce_ambience(False, True, now=179.0, pending_since=0.0, house=house)
    assert state is True and pending == 0.0
    state, pending = debounce_ambience(False, True, now=180.0, pending_since=0.0, house=house)
    assert state is False and pending is None


def test_debounce_pending_clears_when_the_world_changes_back(house):
    state, pending = debounce_ambience(True, True, now=50.0, pending_since=10.0, house=house)
    assert state is True and pending is None


# --------------------------------------------------------------------------------
# Step 4 — the evening ramp, and the midnight trap
# --------------------------------------------------------------------------------


def test_ramp_bias_is_disabled_in_favour_of_24h_timeline(house):
    """The 24h Brightness Schedule Spline replaces the old evening ramp table."""
    assert ramp_bias(20.0, house) == 0.0
    assert ramp_bias(22.5, house) == 0.0
    assert ramp_bias(0.0, house) == 0.0


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


def test_ambience_clamps_diminish_but_never_lifts_demand(house, room, light):
    """The owner's spec, 2026-08-13:

        Demand      normal output   80 %
        Diminished  set to 50 %  →  40 %
        Ambience    set to 10 %  →  10 %

    Ambience is a clamp on the **diminished** result, not on demand. A sub-zone going
    quiet must not take the room below its resting glow — but a bright afternoon
    genuinely needs less light than the glow, and lifting it back up would light a room
    the daylight has already lit.
    """
    house = HouseSettings(ambience_level=25)

    plain = solve(house, room, light, _input(lux=10.0))
    assert plain.level == 161  # the floor does not pull a lit room down

    # Diminished but still above the floor — the reduction stands.
    dimmed = solve(
        house, RoomSettings(diminish_pct=50.0), light,
        _input(lux=10.0, diminish_active=True),
    )
    assert 78 <= dimmed.level <= 81

    # Diminished *below* the floor — ambience wins.
    harsh = solve(
        house, RoomSettings(diminish_pct=95.0), light,
        _input(lux=10.0, diminish_active=True),
    )
    assert harsh.level == 25

    # DEMAND below the floor — demand wins, and is NOT lifted to ambience.
    low = solve(house, RoomSettings(bias_stops=-5.0), light, _input(lux=10.0))
    assert 0 < low.level < 25, "a low demand was lifted up to the ambience floor"


def test_demand_does_not_dim_below_the_awake_floor(house, room, light):
    """"Demand wins" — it dims rather than snapping off, down to the floor.

    The floor is **1, because 0 is off** (owner: *"really as low as 0, but 0 is off"*).
    It was 3 until 2026-08-13, which fought the rule that the cutoff drops out after dark
    precisely so low levels are reachable.
    """
    house = HouseSettings(ambience_level=25, demand_floor_level=1)
    result = solve(house, RoomSettings(bias_stops=-7.0), light, _input(lux=10.0))
    assert 0 < result.level < 25

    # Driven all the way to nothing, the light is OFF — and off in the dark, while awake,
    # is exactly what ambience replaces. It does not stay dark and it is not floored at 1.
    crushed = solve(house, RoomSettings(bias_stops=-12.0), light, _input(lux=10.0))
    assert crushed.level == 25
    assert "ambience_replaces_off" in dict(crushed.trace)


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
    """...but ONLY in daylight. After dark the cutoff drops out entirely.

    Owner, 2026-08-13: the ambience settings "also disable the Minimum cutoff so that
    lights can go as low as 1 at night when low levels are actually needed". A glow that
    is useless against daylight is the entire point once it is dark.
    """
    house = HouseSettings(min_cutoff=10, ambience_start_lux=50, ambience_stop_lux=80)
    room = RoomSettings(bias_stops=-6.0)

    # Bright: the cutoff bites.
    bright = solve(house, room, light, _input(lux=200.0))
    assert bright.level == 0

    # Dark: it does not. A level below the cutoff survives instead of snapping off.
    dark = solve(house, room, light, _input(lux=10.0))
    assert 0 < dark.level < 10


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
    assert steps["ambience_open"] is True
    assert 0 < steps["demand"] < 1
    assert steps["level_raw"] == 161
    assert steps["clamped"] == 161


# --------------------------------------------------------------------------------
# Bedroom at night, and ambience-vs-occupancy (both settled by the owner 2026-08-13)
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
    (on late evening → off on rising → on again shortly after). So `asleep` goes False while `night_active`
    stays latched, and the bedroom must come back at the NIGHT level.

    The owner: "If I wake up and get out of bed, it will turn off and the lights come on
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
    """The owner: ambience conditions are "below threshold and awake" — two conditions.
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


# --------------------------------------------------------------------------------
# The gate debounce has to survive the trip into solve()
# --------------------------------------------------------------------------------


def test_a_debounced_gate_is_not_recomputed_away(house, room, light):
    """⚠️ Regression. `solve` used to re-run `ambience_threshold` on the value the coordinator
    had already debounced, which produced the *un*-debounced answer every time. The
    debounce moved `binary_sensor.…_ambient_gate` and nothing else — the lights still
    zeroed instantly, and the sensor and the bulbs visibly disagreed.

    Here the world is bright (100 lx, well past `ambience_stop_lux` 80) but the caller's
    debounce is still holding the gate open. The lights must stay on.
    """
    held_open = solve(
        house, room, light, _input(lux=100.0, ambience_open=True, ambience_resolved=True)
    )
    assert dict(held_open.trace)["ambience_open"] is True
    assert held_open.level > 0, "the debounced gate was recomputed away"

    # And the converse: a caller holding it SHUT wins over a dark reading.
    #
    # Observed through ambience, not through the level — since 2026-08-13 the threshold
    # does not switch normal lighting off, so `level == 0` would no longer be evidence of
    # anything. An unoccupied room is off either way; what changes is whether the glow
    # replaces that off.
    glow = HouseSettings(ambience_level=20, ambience_ignores_occupancy=True)
    held_shut = solve(
        glow, room, light,
        _input(lux=5.0, occupied=False, ambience_open=False, ambience_resolved=False),
    )
    assert dict(held_shut.trace)["ambience_open"] is False
    assert held_shut.level == 0, "the debounced threshold was recomputed away"

    released = solve(
        glow, room, light,
        _input(lux=5.0, occupied=False, ambience_open=True, ambience_resolved=True),
    )
    assert released.level == 20


def test_without_a_resolved_gate_solve_still_computes_one(house, room, light):
    """`ambience_resolved=None` keeps `solve` usable standalone — the unit tests and any
    what-if preview rely on it deriving the gate from lux."""
    result = solve(house, room, light, _input(lux=10.0, ambience_open=False))
    assert dict(result.trace)["ambience_open"] is True
    assert result.level == 161


# --------------------------------------------------------------------------------
# Ambience — the owner's definition, verbatim, as executable tests
#
#   "Ambient ALWAYS confuses agents. It replaces the OFF state below threshold
#    while awake."                                            — 2026-08-13
#
# It was built twice as a floor under demand before that sentence landed. These tests
# exist so the third rebuild cannot quietly happen.
# --------------------------------------------------------------------------------

GLOW = dict(ambience_level=20, ambience_start_lux=50.0, ambience_stop_lux=80.0)


def test_ambience_replaces_off(light):
    """The headline rule. A room that would be dark shows the glow instead."""
    house = HouseSettings(**GLOW, ambience_ignores_occupancy=True)
    result = solve(house, RoomSettings(), light, _input(lux=10.0, occupied=False))
    assert result.level == 20
    assert "ambience_replaces_off" in dict(result.trace)


def test_ambience_never_dims_a_light_that_is_already_working(light):
    """It replaces OFF. It is not a ceiling, and not a floor that drags a lit room down."""
    house = HouseSettings(**GLOW)
    result = solve(house, RoomSettings(), light, _input(lux=10.0, occupied=True))
    assert result.level > 20, "a properly lit room was pulled down to the glow"


def test_ambience_does_not_appear_in_daylight(light):
    """Above the threshold, off stays off — the glow is an evening thing."""
    house = HouseSettings(**GLOW, ambience_ignores_occupancy=True)
    result = solve(house, RoomSettings(), light, _input(lux=200.0, occupied=False))
    assert result.level == 0


def test_ambience_does_not_appear_while_asleep(light):
    """Awake is half the rule. Night mode owns the house while he is asleep."""
    house = HouseSettings(**GLOW, ambience_ignores_occupancy=True)
    result = solve(
        house, RoomSettings(), light, _input(lux=10.0, occupied=False, asleep=True, dnd=True)
    )
    assert result.level != 20


def test_an_occupied_room_lights_at_the_lux_that_started_all_this(light):
    """247 lx, occupied, evening ramp active — the exact live reading that was reported
    as "lux well below the threshold but the lights are off". It must light."""
    house = HouseSettings(**GLOW, min_cutoff=11)
    result = solve(house, RoomSettings(), light, _input(lux=247.0, occupied=True))
    assert result.level > 0


def test_the_cutoff_drops_out_below_the_threshold_but_zero_is_still_off(light):
    """"Really as low as 0, but 0 is off." The dimmest reachable level is 1, not the
    cutoff — and not 0, which means off."""
    house = HouseSettings(
        ambience_level=0,
        ambience_start_lux=50.0,
        ambience_stop_lux=80.0,
        min_cutoff=11,
        demand_floor_level=1,
    )
    dim = solve(house, RoomSettings(bias_stops=-6.0), light, _input(lux=10.0, occupied=True))
    assert 0 < dim.level < 11


def test_a_night_level_below_the_cutoff_still_lights(light):
    """A latent trap the cutoff fix closes.

    While the cutoff was unconditional, any ``night_level`` below ``min_cutoff`` was
    silently zeroed — getting up at 3 am would have produced *no* light, with nothing in
    the log. It never fired on the live house (night_level 68, cutoff 11), so this is a
    trap removed rather than a break repaired; the default night_level of 3 sits one
    above the default cutoff of 1, which is uncomfortably close for something that fails
    silently and only at night.
    """
    house = HouseSettings(night_level=3, min_cutoff=11, ambience_start_lux=50.0)
    result = solve(
        house, RoomSettings(), light,
        _input(lux=5.0, occupied=True, night_active=True, asleep=False),
    )
    assert result.level == 3


# --------------------------------------------------------------------------------
# "Ambience is always on while awake when below threshold. Focus on ALWAYS on."
# "night level is NOT always on but only based on occupancy."      — 2026-08-13
# --------------------------------------------------------------------------------

NIGHT = dict(ambience_level=9, night_level=68, ambience_start_lux=50.0, min_cutoff=11)


def test_ambience_survives_the_night_latch_while_he_is_awake(light):
    """The 3 am case. Night mode latching must not take the glow out of the whole house
    — being awake is the condition, and he is awake."""
    house = HouseSettings(**NIGHT, ambience_ignores_occupancy=True)
    result = solve(
        house, RoomSettings(), light,
        _input(lux=5.0, occupied=False, night_active=True, asleep=False),
    )
    assert result.level == 9
    assert "ambience_replaces_off" in dict(result.trace)


def test_night_mode_owns_the_room_it_lights_and_ambience_fills_the_rest(light):
    """Night level is occupancy-driven; ambience is everywhere else. They do not fight:
    night mode sets a level, so ambience never sees a zero to replace."""
    house = HouseSettings(**NIGHT, ambience_ignores_occupancy=True)
    here = solve(
        house, RoomSettings(), light,
        _input(lux=5.0, occupied=True, night_active=True, asleep=False),
    )
    assert here.level == 68, "the occupied room should hold the night level"

    elsewhere = solve(
        house, RoomSettings(), light,
        _input(lux=5.0, occupied=False, night_active=True, asleep=False),
    )
    assert elsewhere.level == 9


def test_asleep_is_what_removes_the_glow_not_night_mode(light):
    house = HouseSettings(**NIGHT, ambience_ignores_occupancy=True)
    result = solve(
        house, RoomSettings(), light,
        _input(lux=5.0, occupied=False, night_active=True, asleep=True, dnd=True),
    )
    assert result.level == 0


def test_the_bedroom_transitions_from_dark_to_the_night_level_on_waking(light):
    """Owner: "If the sleep > awake the bedroom will transition on to the night level."

    Asleep, the room he is in is genuinely dark — a night level there is a light on, not
    a gentler off. Awake, it becomes the night level so he can see.
    """
    house = HouseSettings(**NIGHT)
    bedroom = RoomSettings(night_off=True)

    asleep = solve(
        house, bedroom, light,
        _input(lux=5.0, occupied=True, night_active=True, asleep=True, dnd=True),
    )
    assert asleep.level == 0

    awake = solve(
        house, bedroom, light,
        _input(lux=5.0, occupied=True, night_active=True, asleep=False),
    )
    assert awake.level == 68




# --------------------------------------------------------------------------------
# The rate limiter vs ambience — reported live as "I went into other rooms and
# nothing happened", 2026-08-13.
# --------------------------------------------------------------------------------

LIMITED = dict(rate_limit_step=2, ambience_level=11, ambience_start_lux=50.0, min_cutoff=1)


def test_walking_into_a_room_is_not_throttled_by_the_tracking_limiter(light):
    """⚠️ THE REGRESSION. The limiter exempts on (`current <= 0`) and off
    (`target <= 0`). Ambience makes both unreachable — the light is never off and the
    target is never 0 — so entering a room became "tracking" and crawled up 2 levels a
    tick. At the live 600 s interval that is ~15 hours to cross the range.
    """
    house = HouseSettings(**LIMITED)
    arriving = solve(
        house, RoomSettings(), light,
        _input(lux=5.0, occupied=True, current_level=11, last_source="ambience"),
    )
    assert arriving.source == "demand"
    assert arriving.level > 100, f"throttled to {arriving.level} — the room feels dead"


def test_leaving_a_room_drops_to_the_glow_immediately(light):
    """The same bug in the other direction: 193 down to 11 at 2 a tick."""
    house = HouseSettings(**LIMITED, ambience_ignores_occupancy=True)
    leaving = solve(
        house, RoomSettings(), light,
        _input(lux=5.0, occupied=False, current_level=193, last_source="demand"),
    )
    assert leaving.source == "ambience"
    assert leaving.level == 11


def test_demand_tracking_is_still_rate_limited(light):
    """The limiter must keep doing its actual job: stopping the bulb chasing lux wobble
    while nothing about the room's state has changed."""
    house = HouseSettings(**LIMITED)
    tracking = solve(
        house, RoomSettings(), light,
        _input(lux=5.0, occupied=True, current_level=100, last_source="demand"),
    )
    assert tracking.source == "demand"
    assert tracking.level == 102, "the limiter stopped limiting real tracking"


def test_the_first_tick_after_a_restart_is_not_throttled(light):
    """`last_source` is None on a cold start. That is a state change, not tracking."""
    house = HouseSettings(**LIMITED)
    cold = solve(
        house, RoomSettings(), light,
        _input(lux=5.0, occupied=True, current_level=11, last_source=None),
    )
    assert cold.level > 100


# --------------------------------------------------------------------------------
# Away Mode, Virtual Sunrise, Bedtime Auto Dwell, and Dead Zone Bypass
# --------------------------------------------------------------------------------


def test_away_mode_forces_all_lights_off(house, room, light):
    """Away mode forces level 0 and Mode.AWAY."""
    got = solve(house, room, light, _input(lux=5.0, occupied=True, away=True))
    assert got.mode is Mode.AWAY
    assert got.level == 0
    assert got.source == "away"


def test_virtual_sunrise_fades_bedroom_lights(house, light):
    """Virtual sunrise gradually ramps bedroom lights before alarm."""
    bedroom = RoomSettings(name="Bedroom", night_off=True)
    # At 0% progress -> level 0
    start = solve(house, bedroom, light, _input(lux=1.0, sunrise_progress=0.0))
    assert start.mode is Mode.SUNRISE
    assert start.level == 0

    # At 50% progress -> mid-level ramp
    mid = solve(house, bedroom, light, _input(lux=1.0, sunrise_progress=0.5))
    assert mid.mode is Mode.SUNRISE
    assert mid.level > 0
    assert mid.source == "sunrise"

    # At 100% progress -> full daytime/target level
    full = solve(house, bedroom, light, _input(lux=1.0, sunrise_progress=1.0))
    assert full.mode is Mode.SUNRISE
    assert full.level >= mid.level


def test_bedtime_dwell_caps_level_in_bedroom_late_evening(house, light):
    """Bedtime dwell caps bedroom level to bedtime_dwell_level when occupied."""
    bedroom = RoomSettings(name="Bedroom", night_off=True, bedtime_dwell_enabled=True)
    house_dwell = HouseSettings(bedtime_dwell_level=15)
    got = solve(
        house_dwell, bedroom, light,
        _input(lux=1.0, occupied=True, clock_hour=23.0, bedtime_dwell_active=True),
    )
    assert got.level <= 15
    assert ("bedtime_dwell", 15) in got.trace


def test_dead_zone_bypassed_on_source_change(house, room, light):
    """A 1-level delta on an ambience or state transition must not be blocked by dead_zone."""
    house_dz = HouseSettings(dead_zone=5)
    # Ambience transition with 1-level difference (e.g. from 10 to 11)
    got = solve(
        house_dz, room, light,
        _input(lux=5.0, occupied=False, current_level=10, last_written_level=10, last_source="demand", ambience_resolved=True),
    )
    # If level changes to ambience (say 11), should_write must be True
    assert got.should_write is True


def test_sunrise_fade_cannot_exceed_demand_zero_in_summer(house, light):
    """If demand is 0 (sun is up at 4am in summer), virtual sunrise produces 0 level."""
    bedroom = RoomSettings(name="Bedroom", night_off=True, sunrise_enabled=True)
    # High outdoor lux (e.g. 5000 lx, demand 0)
    got = solve(
        house, bedroom, light,
        _input(lux=5000.0, sunrise_progress=0.75, occupied=True),
    )
    assert got.mode is Mode.SUNRISE
    assert got.level == 0


def test_bedtime_dwell_and_night_mode_exempt_from_cutoff(house, light):
    """Bedtime dwell dim levels (e.g. 15) must not be zeroed by min_cutoff (e.g. 25)."""
    bedroom = RoomSettings(name="Bedroom", night_off=True, bedtime_dwell_enabled=True)
    house_cutoff = HouseSettings(min_cutoff=25, bedtime_dwell_level=15)
    # High demand (level 254) -> capped to bedtime_dwell_level 15 -> not zeroed by cutoff 25
    got_high = solve(
        house_cutoff, bedroom, light,
        _input(lux=1.0, occupied=True, bedtime_dwell_active=True),
    )
    assert got_high.level == 15
    assert ("below_cutoff", 25) not in got_high.trace

    # Dim demand (level 5) -> kept at 5 -> not zeroed by cutoff 25
    got_low = solve(
        house_cutoff, bedroom, light,
        _input(lux=500.0, occupied=True, bedtime_dwell_active=True),
    )
    assert got_low.level == 5
    assert ("below_cutoff", 25) not in got_low.trace


def test_virtual_sunrise_custom_spline_curve(light):
    """Virtual sunrise evaluates custom spline points smoothly and caps to demand."""
    custom_curve = (
        SplinePoint(0.0, 0.0),
        SplinePoint(50.0, 50.0),
        SplinePoint(100.0, 200.0),
    )
    house_curve = HouseSettings(sunrise_curve=custom_curve)
    bedroom = RoomSettings(name="Bedroom", night_off=True, sunrise_enabled=True)

    # In dark winter (lux=0, demand=100% -> L1=254)
    # At progress=0.5 -> 50 level
    got_mid = solve(
        house_curve, bedroom, light,
        _input(lux=0.0, sunrise_progress=0.5, occupied=True),
    )
    assert got_mid.mode is Mode.SUNRISE
    assert got_mid.level == 50

    # At progress=1.0 -> 200 level
    got_end = solve(
        house_curve, bedroom, light,
        _input(lux=0.0, sunrise_progress=1.0, occupied=True),
    )
    assert got_end.level == 200


def test_virtual_sunset_custom_spline_curve_and_demand_clamping(light):
    """Virtual sunset evaluates custom spline curve and respects master demand."""
    custom_curve = (
        SplinePoint(0.0, 180.0),
        SplinePoint(50.0, 60.0),
        SplinePoint(100.0, 0.0),
    )
    house_curve = HouseSettings(sunset_curve=custom_curve)
    bedroom = RoomSettings(name="Bedroom", night_off=True, sunset_enabled=True)

    # In dark night (lux=0, demand=100% -> L1=254)
    # At progress=0.0 -> 180
    got_start = solve(
        house_curve, bedroom, light,
        _input(lux=0.0, sunset_progress=0.0, occupied=True),
    )
    assert got_start.mode is Mode.SUNSET
    assert got_start.level == 180

    # At progress=0.5 -> 60
    got_mid = solve(
        house_curve, bedroom, light,
        _input(lux=0.0, sunset_progress=0.5, occupied=True),
    )
    assert got_mid.level == 60

def test_per_light_min_is_a_cutoff_not_a_floor_and_exempt_in_ambience_and_night(house, room):
    """Section 6.2 & UI Help Text: Min is a cutoff, not a floor.
    - During daytime demand tracking, level below cutoff drops to 0.
    - During Ambience (L3) and Night (Ls), cutoff is disabled and low levels are NOT clamped upward.
    """
    entry_light = LightSettings(
        entity_id="light.entry_ceiling",
        clamp_min=60,  # 24% cutoff
        clamp_max=100,
    )
    # 1. Ambience level of 2 (1%) MUST remain 2 and NOT be forced to 60
    table = compute_state_table(
        solve_master(0.0, 22.0, house),
        house,
        RoomSettings(name="Entry", ambience_level=2),
        entry_light,
        clock_hour=22.0,
    )
    assert table.l3 == 2

    # 2. Night level (3) MUST remain 3 and NOT be forced to 60
    assert table.ls == house.night_level

    # 3. In daytime, if demand level is below cutoff (e.g. 40 < 60), the light drops to 0.
    #
    # ⚠️ Asserted through `solve`, NOT through the state table. The Cut Off is armed by the
    # ambience gate, and the state table cannot see the gate — it is handed a MasterOutput
    # and nothing about darkness. Applying the cutoff there as well zeroed L1 whenever the
    # evening curve dipped below a fixture's cut, which stranded six real fixtures at the
    # ambience floor after dusk. `solve` step 7 is the single place the Cut Off lives.
    table_low_demand = compute_state_table(
        solve_master(200.0, 14.0, house),  # lower demand
        house,
        room,
        entry_light,
        clock_hour=14.0,
    )
    assert 0 < table_low_demand.l1 < entry_light.clamp_min

    # Same lux (so the same demand, so the same raw level) with only the GATE differing —
    # `ambience_resolved` pins it directly, since `ambience_open` is merely the previous
    # state fed to the hysteresis and at 200 lx would resolve closed either way.
    common = dict(lux=200.0, clock_hour=14.0)

    # Gate CLOSED (daylight) — the cutoff is armed and takes it to 0.
    lit = solve(house, room, entry_light, _input(**common, ambience_resolved=False))
    assert lit.level == 0

    # Gate OPEN (dark) — the cutoff is disarmed, so the same level survives.
    dark = solve(house, room, entry_light, _input(**common, ambience_resolved=True))
    assert dark.level == table_low_demand.l1



