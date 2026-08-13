"""Fade-planner tests — the measured hardware model from homelab PR #1385.

The colour data points below are **real measurements** from
``docs/home-automation/ZIGBEE-FADE-LIMITS.md``, taken by three independent testers
reading Zigbee ``readResponse`` frames. If a change to ``fade.py`` breaks the
classification test, the change is wrong — the bulbs are not going to move.
"""

from __future__ import annotations

import pytest

from custom_components.solace.fade import (
    MAX_TRANSITION_S,
    PlanKind,
    R_CRIT_COLOUR_MIRED_PER_S,
    colour_transition_is_safe,
    may_run_concurrently,
    plan_brightness,
    plan_colour,
    rate,
)
from custom_components.solace.models import Family

# (delta_mired, seconds, survived) — every colour data point collected, in order.
MEASURED_COLOUR_RUNS = [
    (120, 60, True),  # agent
    (120, 300, True),  # agent
    (100, 600, True),  # last pass
    (120, 900, False),  # first fail
    (150, 1500, False),  # gemini
    (150, 2400, False),  # gemini
    (100, 5400, False),  # stuck at the hardware rail
]


@pytest.mark.parametrize(("delta", "seconds", "survived"), MEASURED_COLOUR_RUNS)
def test_the_rate_model_classifies_every_measured_run(delta, seconds, survived):
    """Seven points, perfect separation on R. Safety factor 1.0 reproduces the measured
    boundary exactly; the shipped default plans more conservatively than this."""
    assert colour_transition_is_safe(delta, seconds, safety=1.0) is survived


def test_the_boundary_sits_where_the_measurements_bracket_it():
    """Every pass ≥ 0.1667 mired/s; every fail ≤ 0.1333. R_crit ≈ 1/64 per decisecond."""
    passes = [rate(d, t) for d, t, ok in MEASURED_COLOUR_RUNS if ok]
    fails = [rate(d, t) for d, t, ok in MEASURED_COLOUR_RUNS if not ok]
    assert min(passes) > max(fails)
    assert max(fails) < R_CRIT_COLOUR_MIRED_PER_S < min(passes)


def test_chunking_a_glide_does_not_change_its_rate():
    """R = Δ/T is invariant under chunking.

    This is the intuitive fix — "break the long fade into shorter fades" — and it fails
    identically. The test exists so nobody re-derives it.
    """
    whole = rate(205, 5400)
    fifth = rate(205 / 5, 5400 / 5)
    assert whole == pytest.approx(fifth)
    assert not colour_transition_is_safe(205 / 5, 5400 / 5, safety=1.0)


# --------------------------------------------------------------------------------
# plan_colour
# --------------------------------------------------------------------------------


def test_a_fast_colour_change_uses_one_transition():
    plan = plan_colour(250, 370, duration_s=300)
    assert plan.kind is PlanKind.TRANSITION
    assert len(plan.steps) == 1
    assert plan.steps[0].mired == 370
    assert plan.steps[0].transition_s == 300


def test_the_90_minute_circadian_glide_is_stepped():
    """4000K → 2200K is 250 → 455 mired. Over 90 minutes that is 0.038 mired/s —
    25× below the floor. A single transition would strand the bulb at a rail."""
    plan = plan_colour(250, 455, duration_s=90 * 60)
    assert plan.kind is PlanKind.STEPPED
    assert plan.steps[-1].mired == 455


def test_every_step_of_a_stepped_plan_is_individually_safe():
    """The whole point: R is computed from the step's own TRANSITION time, never its
    hold interval. `{"color_temp": +5, "transition": 60}` underflows; +5 over 4 s
    does not."""
    plan = plan_colour(250, 455, duration_s=90 * 60)
    previous = 250
    for step in plan.steps:
        delta = step.mired - previous
        assert colour_transition_is_safe(delta, step.transition_s, safety=1.0)
        previous = step.mired


def test_a_stepped_plan_holds_far_longer_than_it_fades():
    plan = plan_colour(250, 455, duration_s=90 * 60)
    assert plan.interval_s > plan.steps[0].transition_s * 5


def test_a_stepped_plan_lands_exactly_on_target_never_near_it():
    plan = plan_colour(300, 187, duration_s=3600)
    assert plan.steps[-1].mired == 187


def test_a_stepped_plan_spans_the_requested_duration():
    plan = plan_colour(250, 455, duration_s=90 * 60)
    assert plan.steps[-1].at_s == pytest.approx(90 * 60, rel=1e-6)


def test_steps_never_fall_below_the_underflow_floor():
    """A 1-mired step over a 4 s fade is R = 0.25 — safe. A sub-1 step is not
    expressible on the wire anyway."""
    plan = plan_colour(250, 260, duration_s=7200, step_mired=1)
    for step in plan.steps:
        assert step.transition_s <= 5


def test_no_change_produces_no_commands():
    plan = plan_colour(300, 300, duration_s=600)
    assert plan.kind is PlanKind.NONE
    assert plan.steps == ()


def test_a_glide_beyond_the_uint16_ceiling_is_never_a_single_transition():
    """>109 minutes risks silently wrapping the 16-bit transtime field."""
    plan = plan_colour(250, 455, duration_s=MAX_TRANSITION_S + 1000)
    assert plan.kind is PlanKind.STEPPED
    for step in plan.steps:
        assert step.transition_s <= MAX_TRANSITION_S


def test_the_plan_explains_itself():
    """Stepped traffic looks like chatter unless the reason is visible in the panel."""
    plan = plan_colour(250, 455, duration_s=90 * 60)
    assert "below" in plan.reason and "floor" in plan.reason


# --------------------------------------------------------------------------------
# plan_brightness
# --------------------------------------------------------------------------------


def test_brightness_is_one_long_hardware_transition():
    """Different cluster, different accumulator precision. Verified linear to 40 min."""
    plan = plan_brightness(20, duration_s=2400)
    assert len(plan.segments) == 1
    assert plan.segments[0].level == 20
    assert plan.segments[0].transition_s == 2400


def test_brightness_is_never_stepped_at_rates_that_would_kill_colour():
    """0.085 levels/s was verified clean; the colour floor is irrelevant here."""
    plan = plan_brightness(20, duration_s=900, start_level=225)
    assert len(plan.segments) == 1


def test_brightness_beyond_the_transtime_ceiling_is_split():
    plan = plan_brightness(20, duration_s=3 * MAX_TRANSITION_S, start_level=254)
    assert len(plan.segments) == 3
    for segment in plan.segments:
        assert segment.transition_s <= MAX_TRANSITION_S
    assert plan.segments[-1].level == 20


def test_split_brightness_segments_are_monotonic_toward_the_target():
    plan = plan_brightness(20, duration_s=3 * MAX_TRANSITION_S, start_level=254)
    levels = [s.level for s in plan.segments]
    assert levels == sorted(levels, reverse=True)


# --------------------------------------------------------------------------------
# The IKEA exception
# --------------------------------------------------------------------------------


def test_ikea_must_not_run_colour_and_brightness_concurrently():
    """Measured: Entry Ceiling's brightness fade STALLED at 84 for 420 s with colour
    steps alongside, while a same-family control doing brightness alone tracked
    exactly."""
    assert may_run_concurrently(Family.IKEA) is False


def test_both_aqara_families_may_run_both_channels():
    assert may_run_concurrently(Family.AQARA_CCT) is True
    assert may_run_concurrently(Family.AQARA_RGB) is True
