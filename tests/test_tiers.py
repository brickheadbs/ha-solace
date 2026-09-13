"""Tier state machine tests — perceptual dead zone, slew clamping, and every row of the
transition matrix from ``docs/specifications/TIER_STATE_MACHINE.md``.

The perceptual-dead-zone numbers below are computed directly from the formula the spec
gives (``abs((new/old) ** gamma - 1)``), not copied from the spec's own prose, which
gives rough (and in one case simply wrong) percentages for illustration. Where the
prose and the maths disagree, the maths wins and is cited inline — see
``test_seven_level_change_at_high_level_is_not_actually_suppressed_by_default``.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from custom_components.solace.standby import StateTier
from custom_components.solace.tiers import (
    LARGE_MARGIN_LEVELS,
    TierChange,
    past_perceptual_dead_zone,
    perceptual_delta,
    select_transition,
    slew_transition_s,
)

GAMMA = 2.3


def expected_delta(old: int, new: int, gamma: float = GAMMA) -> float:
    """Reference implementation, independent of tiers.py, for cross-checking."""
    return abs((new / old) ** gamma - 1)


# --------------------------------------------------------------------------------
# perceptual_delta
# --------------------------------------------------------------------------------


def test_perceptual_delta_matches_the_formula():
    assert perceptual_delta(200, 207) == pytest.approx(expected_delta(200, 207))
    assert perceptual_delta(20, 27) == pytest.approx(expected_delta(20, 27))


def test_perceptual_delta_is_zero_for_no_change():
    assert perceptual_delta(150, 150) == pytest.approx(0.0)


@pytest.mark.parametrize("old,new", [(0, 100), (100, 0), (0, 0)])
def test_perceptual_delta_is_infinite_across_zero(old, new):
    """Crossing zero is a tier boundary, not within-tier drift — always maximally
    perceptible, and undefined as a ratio besides."""
    assert perceptual_delta(old, new) == float("inf")


# --------------------------------------------------------------------------------
# past_perceptual_dead_zone — the inverted-dead-zone finding
# --------------------------------------------------------------------------------


def test_seven_level_change_at_low_level_must_write():
    """20 -> 27: ratio 1.35, ~99.4% output change. Nowhere near the 3% floor —
    the flat 8-level dead zone this replaces would have wrongly swallowed this."""
    delta = expected_delta(20, 27)
    assert delta == pytest.approx(0.9942, abs=1e-3)
    assert past_perceptual_dead_zone(27, 20) is True


def test_seven_level_change_at_high_level_is_not_actually_suppressed_by_default():
    """The task brief claims a 7-level change at level 200 is '~8% and must be
    suppressed at the 3% default'. Checking the maths: 200 -> 207 is
    abs((207/200)**2.3 - 1) ~= 8.23%, which is ABOVE the 3% pct floor, so this
    function correctly does NOT suppress it — the brief's claim is wrong (8.23% > 3%
    is a write, not a suppression), which is exactly why this module computes the
    true value instead of trusting a rough restatement of the spec.

    The real finding survives anyway: the SAME 7-level raw delta is ~99.4% perceptible
    at level 20 and only ~8.23% at level 200 — a >12x difference for an identical raw
    move. See the level-20-vs-level-200-at-delta-2 pair below for a case where that
    gap actually crosses the suppression threshold in both directions.
    """
    delta = expected_delta(200, 207)
    assert delta == pytest.approx(0.0823, abs=1e-3)
    assert delta > 0.03  # above the default pct floor -> NOT suppressed
    assert past_perceptual_dead_zone(207, 200) is True

    low_delta = expected_delta(20, 27)
    assert low_delta / delta > 12  # the sensitivity gap the spec is about


def test_same_small_delta_is_suppressed_high_and_written_low():
    """The clean version of the inverted-dead-zone finding: the identical 2-level raw
    move is suppressed at level 200 (below the 3% floor) but written at level 20
    (well above it) — same hardware, same dead-zone setting, opposite outcomes,
    purely because output is nonlinear in level."""
    assert expected_delta(200, 202) == pytest.approx(0.02315, abs=1e-4)
    assert expected_delta(20, 22) == pytest.approx(0.24510, abs=1e-4)

    assert past_perceptual_dead_zone(202, 200) is False  # 2.3% < 3% -> suppressed
    assert past_perceptual_dead_zone(22, 20) is True  # 24.5% >= 3% -> written


def test_none_last_written_always_writes():
    assert past_perceptual_dead_zone(100, None) is True


@pytest.mark.parametrize("new_level,last_written", [(0, 50), (50, 0), (0, 0)])
def test_either_side_zero_always_writes(new_level, last_written):
    """A write touching L0 is a tier boundary, handled by select_transition's 'any ->
    L0' / 'L0 -> L1' rows, not by this drift-only suppressor — never swallow it here."""
    assert past_perceptual_dead_zone(new_level, last_written) is True


def test_no_change_is_suppressed():
    assert past_perceptual_dead_zone(150, 150) is False


def test_floor_levels_suppresses_a_raw_jitter_independently_of_percentage():
    """A 1-level nudge is suppressed by the floor even though, right at the bottom of
    the curve, the percentage math alone would call it enormous — the floor is a
    jitter guard, applied before the percentage test ever runs, not an OR'd-in
    percentage override."""
    assert expected_delta(1, 2) > 1.0  # would be "always perceptible" by percentage alone
    assert past_perceptual_dead_zone(2, 1, floor_levels=1) is False
    # Raising floor_levels to 0 removes the floor; the percentage test alone decides.
    assert past_perceptual_dead_zone(2, 1, floor_levels=0) is True


def test_large_margin_escapes_a_broken_gamma():
    """gamma=0 makes every ratio compute to 1, so perceptual_delta always returns 0 —
    a broken-math scenario. A big enough raw jump must still force a write regardless;
    that is the entire point of LARGE_MARGIN_LEVELS."""
    assert expected_delta(100, 200, gamma=0) == pytest.approx(0.0)
    big_delta = 100 + LARGE_MARGIN_LEVELS + 2
    assert big_delta <= 254
    assert past_perceptual_dead_zone(big_delta, 100, gamma=0) is True

    # A jump just under the margin is NOT rescued -- broken gamma suppresses it, which
    # is exactly why LARGE_MARGIN_LEVELS exists as a backstop rather than a substitute
    # for trusting the percentage test in the normal case.
    small_delta = 100 + LARGE_MARGIN_LEVELS - 5
    assert past_perceptual_dead_zone(small_delta, 100, gamma=0) is False


# --------------------------------------------------------------------------------
# slew_transition_s
# --------------------------------------------------------------------------------


def test_slew_clamps_to_min_for_a_tiny_shift():
    """A 1-level nudge at high output produces a minuscule perceptual delta; a fast
    target_rate divides it down to well under min_s, which then wins the clamp."""
    seconds = slew_transition_s(200, 201, target_rate=1.0, min_s=2.0, max_s=120.0)
    raw = expected_delta(200, 201) / 1.0
    assert raw < 2.0
    assert seconds == pytest.approx(2.0)


def test_slew_clamps_to_max_for_a_storm():
    """A huge shift against a slow target_rate would want a multi-hour fade; max_s
    wins the clamp instead ('the light moves now')."""
    seconds = slew_transition_s(20, 200, target_rate=0.01, min_s=2.0, max_s=120.0)
    raw = expected_delta(20, 200) / 0.01
    assert raw > 120.0
    assert seconds == pytest.approx(120.0)


def test_slew_is_unclamped_in_the_middle_of_the_band():
    old, new, rate = 100, 130, 0.05
    expected = expected_delta(old, new) / rate
    seconds = slew_transition_s(old, new, target_rate=rate, min_s=1.0, max_s=600.0)
    assert 1.0 < seconds < 600.0
    assert seconds == pytest.approx(expected)


def test_slew_falls_back_to_max_for_a_zero_or_negative_rate():
    assert slew_transition_s(100, 150, target_rate=0.0, min_s=1.0, max_s=90.0) == 90.0
    assert slew_transition_s(100, 150, target_rate=-1.0, min_s=1.0, max_s=90.0) == 90.0


def test_slew_falls_back_to_max_across_zero():
    """old_level or new_level == 0 gives an infinite perceptual delta; slew_transition_s
    must not propagate infinity or raise, it should fail safe to the slowest bound."""
    assert slew_transition_s(0, 150, target_rate=0.05, min_s=1.0, max_s=90.0) == 90.0
    assert slew_transition_s(150, 0, target_rate=0.05, min_s=1.0, max_s=90.0) == 90.0


# --------------------------------------------------------------------------------
# select_transition — every row of the matrix
# --------------------------------------------------------------------------------


ALL_SETTING_FIELDS = [
    "transition_up_occupancy_s",
    "transition_up_occupied_on_s",
    "transition_automatic_s",
    "transition_up_ambience_s",
    "transition_down_ambience_s",
    "transition_down_diminish_s",
    "transition_down_off_s",
]


@pytest.fixture
def settings() -> SimpleNamespace:
    """A stand-in for HouseSettings carrying every field the matrix can select, so
    select_transition's hasattr validation passes for every row under test."""
    return SimpleNamespace(**{name: 1.0 for name in ALL_SETTING_FIELDS})


def test_l0_to_l1_fresh_occupancy(settings):
    change = TierChange(StateTier.L0_OFF, StateTier.L1_DEMAND, occupied=True, fresh_occupancy=True)
    assert select_transition(change, settings) == "transition_up_occupancy_s"


def test_l0_to_l1_already_occupied(settings):
    change = TierChange(StateTier.L0_OFF, StateTier.L1_DEMAND, occupied=True, fresh_occupancy=False)
    assert select_transition(change, settings) == "transition_up_occupied_on_s"


def test_l0_to_l1_not_occupied(settings):
    change = TierChange(StateTier.L0_OFF, StateTier.L1_DEMAND, occupied=False)
    assert select_transition(change, settings) == "transition_automatic_s"


def test_l0_to_l1s_uses_the_same_rows_as_l0_to_l1(settings):
    """The table groups L0 -> L1/L1S as one row; L1S_SPECIAL must fall into the exact
    same three occupancy-keyed branches as L1_DEMAND."""
    fresh = TierChange(StateTier.L0_OFF, StateTier.L1S_SPECIAL, occupied=True, fresh_occupancy=True)
    already = TierChange(StateTier.L0_OFF, StateTier.L1S_SPECIAL, occupied=True, fresh_occupancy=False)
    auto = TierChange(StateTier.L0_OFF, StateTier.L1S_SPECIAL, occupied=False)
    assert select_transition(fresh, settings) == "transition_up_occupancy_s"
    assert select_transition(already, settings) == "transition_up_occupied_on_s"
    assert select_transition(auto, settings) == "transition_automatic_s"


def test_any_to_l3_rising(settings):
    for from_tier in (StateTier.L0_OFF, StateTier.L1_DEMAND, StateTier.L2_DIMINISHED):
        change = TierChange(from_tier, StateTier.L3_AMBIENCE, rising=True)
        assert select_transition(change, settings) == "transition_up_ambience_s"


def test_any_to_l3_falling(settings):
    for from_tier in (StateTier.L0_OFF, StateTier.L1_DEMAND, StateTier.L2_DIMINISHED):
        change = TierChange(from_tier, StateTier.L3_AMBIENCE, rising=False)
        assert select_transition(change, settings) == "transition_down_ambience_s"


def test_l1_to_l2_diminish(settings):
    change = TierChange(StateTier.L1_DEMAND, StateTier.L2_DIMINISHED)
    assert select_transition(change, settings) == "transition_down_diminish_s"


def test_l1s_to_l2_uses_the_l1_to_l2_row(settings):
    """L1S_SPECIAL normalizes to L1_DEMAND for every row except the L1<->L1S swap
    itself."""
    change = TierChange(StateTier.L1S_SPECIAL, StateTier.L2_DIMINISHED)
    assert select_transition(change, settings) == "transition_down_diminish_s"


def test_l2_to_l1_is_the_tbc_row_provisionally_up_occupancy(settings):
    """Spec: 'L2 -> L1 ... TBC — Brandon's sheet says "Clear to L1"'. No setting is
    named yet; this asserts the documented provisional choice so a future change to
    it is a deliberate, visible diff rather than a silent behaviour change."""
    change = TierChange(StateTier.L2_DIMINISHED, StateTier.L1_DEMAND)
    assert select_transition(change, settings) == "transition_up_occupancy_s"


@pytest.mark.parametrize(
    "from_tier",
    [StateTier.L1_DEMAND, StateTier.L1S_SPECIAL, StateTier.L2_DIMINISHED, StateTier.L3_AMBIENCE],
)
def test_any_to_l0(settings, from_tier):
    change = TierChange(from_tier, StateTier.L0_OFF)
    assert select_transition(change, settings) == "transition_down_off_s"


def test_within_tier_update_raises(settings):
    """'within-tier value update' is not a fixed setting — it uses slew_transition_s."""
    with pytest.raises(ValueError):
        select_transition(TierChange(StateTier.L1_DEMAND, StateTier.L1_DEMAND), settings)


@pytest.mark.parametrize(
    "from_tier,to_tier",
    [
        (StateTier.L1_DEMAND, StateTier.L1S_SPECIAL),
        (StateTier.L1S_SPECIAL, StateTier.L1_DEMAND),
    ],
)
def test_l1_l1s_swap_raises(settings, from_tier, to_tier):
    """'L1 <-> L1S' — 'treat as within-tier update' per the spec, so this must raise
    exactly like the L1 -> L1 case, in both directions."""
    with pytest.raises(ValueError):
        select_transition(TierChange(from_tier, to_tier), settings)


@pytest.mark.parametrize(
    "from_tier,to_tier",
    [(StateTier.L3_AMBIENCE, StateTier.L1_DEMAND), (StateTier.L3_AMBIENCE, StateTier.L2_DIMINISHED)],
)
def test_pairs_absent_from_the_spec_table_raise_rather_than_guess(settings, from_tier, to_tier):
    """Neither 'L3 -> L1' nor 'L3 -> L2' appears in the spec's transition matrix (only
    'any -> L3' and 'any -> L0' are written as blanket rows). Raising here — instead of
    inferring a plausible answer from a neighbouring row — surfaces the gap rather than
    hiding it; see the select_transition docstring for the same point."""
    with pytest.raises(ValueError):
        select_transition(TierChange(from_tier, to_tier), settings)


def test_select_transition_validates_the_settings_object():
    """A settings object missing the selected field must fail loudly here, not three
    layers away as a None resolving silently."""
    incomplete = SimpleNamespace(transition_down_off_s=1.0)  # missing everything else
    with pytest.raises(AttributeError):
        select_transition(TierChange(StateTier.L1_DEMAND, StateTier.L0_OFF), SimpleNamespace())
    # The one field it does have still works:
    assert (
        select_transition(TierChange(StateTier.L1_DEMAND, StateTier.L0_OFF), incomplete)
        == "transition_down_off_s"
    )


# ------------------------------------------------------------------ calibration guard


def test_brandons_stated_threshold_is_the_calibration():
    """200 -> 203 must not be written. This is the number the default is FOR.

    Brandon, 2026-09-13, asked for exactly this: "If the update isn't able to be seen
    (a shift of lvl 200 to 203) then no need to send it." At gamma 2.3 that is a 3.48%
    output change, which is why the default is 4% and not the 3% the design spec first
    proposed — 3% would have written it and missed the requirement by a third of a
    percent. Pinning it here so the default cannot drift back under it unnoticed.
    """
    assert 0.034 < perceptual_delta(200, 203) < 0.035
    assert not past_perceptual_dead_zone(203, 200)
    # ...but the next step up is a real change and must survive.
    assert past_perceptual_dead_zone(205, 200)


def test_the_bottom_of_the_range_is_no_longer_frozen():
    """The inverted-dead-zone finding, pinned.

    A flat 8-level dead zone suppressed ~8% of output change at level 200 (fine) and
    ~95% at level 20 (not fine) — and ambience_floor=9, night_level=26 and
    min_cutoff=48 all live in that broken half. Through the perceptual gate a single
    level at the bottom is already well past threshold.
    """
    assert perceptual_delta(20, 21) > 0.10
    assert perceptual_delta(9, 10) > 0.25
    assert past_perceptual_dead_zone(21, 20)
    assert past_perceptual_dead_zone(10, 9)
