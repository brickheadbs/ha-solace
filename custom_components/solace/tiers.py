"""The tier state machine — perceptual dead zone, slew timing, and the transition matrix.

PURE MODULE — no ``homeassistant`` imports, ever.

Implements ``docs/specifications/TIER_STATE_MACHINE.md`` (approved 2026-09-13). Three
pieces, in the order the spec presents them:

1. **Perceptual dead zone** (:func:`perceptual_delta`, :func:`past_perceptual_dead_zone`)
   — replaces the flat ``dead_zone`` level-count suppression in ``engine.past_dead_zone``.
   Measured hardware curve: output ∝ level**2.3 (see the spec's "Perceptual dead zone"
   section). A flat level-count dead zone is *inverted*: the same raw delta is nearly
   imperceptible near full brightness and enormous near the bottom of the curve. This
   module suppresses on predicted **output** change instead, so the same dead-zone
   percentage means the same thing at every level.

2. **Slew-derived transition timing** (:func:`slew_transition_s`) — replaces the fixed
   ``transition_automatic_s`` for within-tier value updates. A 3-level nudge and a
   150-level jump used to get the same 300 s fade; this derives the duration from the
   size of the *perceptual* shift so the fade rate stays roughly constant instead.

3. **The transition matrix** (:class:`TierChange`, :func:`select_transition`) — replaces
   the ``if/elif`` chain on ``solution.source`` / ``last_src`` in
   ``coordinator._async_apply``, which the spec calls out by name as the source of a
   silent bug (every branch there was unreachable). ``select_transition`` returns the
   **name** of the ``HouseSettings`` field to use, never the value — the caller (writer
   or coordinator) resolves ``getattr(house, name)``. This keeps the matrix testable
   without a ``HouseSettings`` instance and keeps this module ignorant of what a
   ``HouseSettings`` even is.

Tiers come from :class:`custom_components.solace.standby.StateTier` directly —
``L0_OFF, L1_DEMAND, L2_DIMINISHED, L3_AMBIENCE, L1S_SPECIAL``. ``L1S_SPECIAL`` is a
*slot*, not a tier: while a special mode (night ramp, morning ramp) is bound to a room,
it substitutes for ``L1_DEMAND`` in that room and unbinds on timeout or trigger. Every
matrix row below is written against ``L1_DEMAND``, and :func:`_normalize` collapses
``L1S_SPECIAL`` onto it before matching — except for the ``L1 <-> L1S`` swap itself,
which is a within-tier update with no fixed setting (see :func:`select_transition`).
"""

from __future__ import annotations

from dataclasses import dataclass

from .standby import StateTier

__all__ = [
    "LARGE_MARGIN_LEVELS",
    "MAX_LEVEL",
    "perceptual_delta",
    "past_perceptual_dead_zone",
    "slew_transition_s",
    "TierChange",
    "select_transition",
]

MAX_LEVEL = 254

DEFAULT_PERCEPTUAL_PCT = 0.04
"""Suppress a write below this fractional change in light OUTPUT.

Calibrated against Brandon's own stated threshold rather than picked round: he gave
"a shift of lvl 200 to 203" as the case not worth sending (2026-09-13). At gamma 2.3
that is a **3.48%** output change, so a 3% default — which is what the design spec first
proposed — would have *written* it and missed the requirement by a hair. 4% is the
tightest value that honours the stated rule; 200 -> 205 (5.84%) still writes.

The asymmetry this exists to fix, same raw delta, both measured through the same curve:

    200 -> 207   8.23%   comfortably perceptible
     20 ->  23  37.91%   the flat dead_zone=8 used to swallow this whole

At the bottom of the range a single level is already 11.9% (20 -> 21) and 27.4%
(9 -> 10), so ambience and night levels become responsive again instead of frozen.
"""
"""Home Assistant / Zigbee brightness ceiling. Matches ``engine.MAX_LEVEL``; duplicated
here rather than imported because that constant lives in ``engine.py``, out of scope for
this file, and a bare ``254`` would otherwise appear unexplained below."""

LARGE_MARGIN_LEVELS = 128
"""Raw-level escape hatch for :func:`past_perceptual_dead_zone`, independent of
``gamma``. In normal operation a raw delta this large already clears any sane ``pct``
threshold on its own — at these levels ``perceptual_delta`` is monotonic in the ratio,
so a half-range jump is never perceptually small. This constant exists purely as a
safety net against a *broken* perceptual computation (a caller passing ``gamma=0``, or
some future numerical edge case): a jump of at least half the level range must never be
silently swallowed just because the percentage math went wrong. See
``test_large_margin_escapes_a_broken_gamma`` for the case this actually protects
against."""


def perceptual_delta(old_level: int, new_level: int, gamma: float = 2.3) -> float:
    """Fractional change in perceived light OUTPUT for a level move on this hardware.

    Measured curve (``TIER_STATE_MACHINE.md``, "Perceptual dead zone"): output is
    proportional to ``level ** gamma`` with ``gamma`` ≈ 2.3. Output is a *ratio*
    quantity, so normalising by the 254 ceiling cancels out and this can work directly
    on raw levels::

        (new_level / old_level) ** gamma - 1

    ``old_level == 0`` or ``new_level == 0`` is defined as **always perceptible**:
    motion across zero is a tier boundary (``L0``), never within-tier drift, and the
    ratio would otherwise be undefined (division by zero) or infinite. Returning
    ``float("inf")`` means any caller comparing this against a finite threshold treats
    it as unconditionally above it, with no special-casing required at the call site.
    """
    if old_level == 0 or new_level == 0:
        return float("inf")
    return abs((new_level / old_level) ** gamma - 1)


def past_perceptual_dead_zone(
    new_level: int,
    last_written: int | None,
    *,
    pct: float = DEFAULT_PERCEPTUAL_PCT,
    floor_levels: int = 0,
    gamma: float = 2.3,
) -> bool:
    """True when a write should happen; False to suppress it.

    Replaces the flat ``dead_zone`` level-count suppression (``engine.past_dead_zone``)
    with the perceptual test from the spec: suppress a write unless the predicted
    **output** change is at least ``pct`` (default 3%)::

        abs((new_level / last_written) ** gamma - 1) >= pct

    Always writes (returns ``True``), before any percentage math runs:

    * ``last_written is None`` — no baseline to suppress against.
    * ``new_level == 0`` or ``last_written == 0`` — a tier boundary (``L0``), not
      within-tier drift. This function is for the "within-tier value update" and
      "``L1`` ↔ ``L1S``" rows of the transition matrix; a change touching zero belongs
      to a different matrix row entirely (``select_transition`` handles it) and must
      never be suppressed here regardless of what it would otherwise compute to.
    * ``abs(new_level - last_written) > LARGE_MARGIN_LEVELS`` — the escape hatch
      described on :data:`LARGE_MARGIN_LEVELS`.

    Otherwise: suppressed (``False``) when the raw delta is at or below
    ``floor_levels`` (**default 0** — off) — a pure jitter floor, independent of the
    percentage test, kept only to absorb integer/rounding noise of a couple of levels
    exactly as ``engine.past_dead_zone``'s own final fallback does
    (``abs(new_level - last_written) >= max(dead_zone, 1)``). It is *not* ANDed with the
    percentage test and does not gate it: once the raw delta clears ``floor_levels``,
    the percentage test alone decides, and a below-``floor_levels`` raw delta is
    suppressed even on the rare level where it would compute as perceptible (e.g. a
    literal 1-level nudge at level 1). Do not raise ``floor_levels`` to "fix" the
    inverted dead zone the spec describes — that bug lived in a flat threshold sized
    like this one (``dead_zone`` defaults to 8), and raising this floor back toward
    that size reintroduces exactly the same bug this function exists to remove. The
    percentage test is the real gate; this floor only ever narrows what would otherwise
    write, never widens it.

    It defaults to **0** because it is redundant: wherever a one-level step is genuinely
    imperceptible the percentage test already suppresses it (200 -> 201 is 1.15%, well
    under the 4% default), and wherever it is not imperceptible the floor was *wrongly*
    blocking a real change (9 -> 10 at the ambience floor is 27.4%). A floor of 1 was
    therefore reintroducing the frozen bottom-of-range this function exists to fix, just
    one level wide instead of eight. The percentage test is self-limiting against jitter
    by construction, because jitter is only jitter when you cannot see it.
    """
    if last_written is None:
        return True
    if new_level == 0 or last_written == 0:
        return True
    delta_levels = abs(new_level - last_written)
    if delta_levels > LARGE_MARGIN_LEVELS:
        return True
    if delta_levels <= floor_levels:
        return False
    return perceptual_delta(last_written, new_level, gamma) >= pct


def slew_transition_s(
    old_level: int,
    new_level: int,
    *,
    target_rate: float,
    min_s: float,
    max_s: float,
    gamma: float = 2.3,
) -> float:
    """Derive a within-tier update's transition duration from the size of the shift.

    Replaces the fixed ``transition_automatic_s`` for value updates within a tier
    (spec: "Slew-rate transitions"), where today a 3-level nudge and a 150-level jump
    both get the same 300 s fade. Instead::

        T = clamp(perceptual_delta(old_level, new_level, gamma) / target_rate, min_s, max_s)

    ``target_rate`` is a **fractional output change per second** — the same units
    :func:`perceptual_delta` returns, per second. A ``target_rate`` of ``0.01`` means
    "let the output change by about 1% per second"; a small perceptual delta then
    yields a short fade and a large one a long fade, both moving at roughly the same
    perceptual rate, before clamping keeps either end within the settings' bounds.

    A non-positive ``target_rate`` (division by zero, or a caller passing a nonsense
    value) and the ``old_level == 0`` / ``new_level == 0`` infinite-delta case both fall
    back to ``max_s`` — the slowest allowed fade is the safe default when the rate
    calculation itself cannot be trusted, rather than raising mid-cycle.
    """
    if target_rate <= 0:
        return max_s
    delta_output = perceptual_delta(old_level, new_level, gamma)
    if delta_output == float("inf"):
        return max_s
    seconds = delta_output / target_rate
    return min(max(seconds, min_s), max_s)


@dataclass(frozen=True, slots=True)
class TierChange:
    """One tier transition, as seen by :func:`select_transition`.

    ``occupied`` and ``fresh_occupancy`` only matter for a ``L0 -> L1``/``L1S`` change
    (the room's demand rows); ``rising`` only matters for a change *to* ``L3`` (the
    ambience rows, which pick their setting by brightness direction, not tier order —
    see the spec's "any → L3 (rising)" vs "(falling)" rows). Leave the irrelevant fields
    at their default for any other change; :func:`select_transition` never reads a field
    outside the row it matched.
    """

    from_tier: StateTier
    to_tier: StateTier
    occupied: bool = False
    fresh_occupancy: bool = False
    rising: bool = False


def _normalize(tier: StateTier) -> StateTier:
    """``L1S_SPECIAL`` is a substitution slot for ``L1_DEMAND``, not a distinct tier for
    matrix purposes (spec: "L1S is a *slot*, not a tier"). Every matrix row is written
    against ``L1_DEMAND``; this collapses ``L1S_SPECIAL`` onto it before matching so
    ``L0 -> L1S`` and ``L2 -> L1S`` fall into the same rows as ``L0 -> L1`` and
    ``L2 -> L1`` without duplicating every row. The one place this must NOT happen first
    is the ``L1 <-> L1S`` swap itself — :func:`select_transition` checks that before
    normalizing."""
    return StateTier.L1_DEMAND if tier is StateTier.L1S_SPECIAL else tier


def select_transition(change: TierChange, settings: object) -> str:
    """Return the **name** of the ``HouseSettings`` field to use for this tier change's
    transition duration — never the value. The caller resolves it (typically
    ``getattr(house, select_transition(change, house))``); ``settings`` is used only to
    validate the name exists before handing it back, so a typo here fails loudly at the
    call site instead of silently resolving to ``None`` three layers away.

    Encodes exactly the "Transition selection" table in
    ``docs/specifications/TIER_STATE_MACHINE.md``, in the table's own row order:

    | From -> To            | Occupied              | Setting                     |
    |-----------------------|-----------------------|------------------------------|
    | L0 -> L1/L1S          | yes, fresh occupancy  | transition_up_occupancy_s   |
    | L0 -> L1/L1S          | yes, already occupied | transition_up_occupied_on_s |
    | L0 -> L1/L1S          | no                    | transition_automatic_s      |
    | any -> L3 (rising)    | --                    | transition_up_ambience_s    |
    | any -> L3 (falling)   | --                    | transition_down_ambience_s  |
    | L1 -> L2              | --                    | transition_down_diminish_s  |
    | L2 -> L1              | --                    | TBC (see below)             |
    | any -> L0             | --                    | transition_down_off_s       |

    The two remaining rows in the spec table — "within-tier value update" and
    "``L1`` <-> ``L1S``" — are not fixed settings at all; both use
    :func:`slew_transition_s` instead. This function raises ``ValueError`` for both
    (``from_tier == to_tier``, or ``{from_tier, to_tier} == {L1_DEMAND, L1S_SPECIAL}``)
    so a caller that reaches for the wrong function finds out immediately rather than
    getting a plausible-looking but wrong setting name back.

    ``L2 -> L1`` is marked **TBC** in the spec ("Brandon's sheet says 'Clear to L1'"
    with no setting named). This provisionally reuses ``transition_up_occupancy_s`` —
    marked below with a ``# TBC:`` comment so it is easy to find and change once
    Brandon confirms the real setting.

    Any pair not covered by the table above (for example ``L3 -> L1`` or ``L3 -> L2`` —
    the spec's "any -> L3" row covers entry into ambience but nothing about leaving it
    other than via "any -> L0") raises ``ValueError`` rather than guessing. Encode the
    real rule here once the spec defines one; do not infer it from adjacent rows.
    """
    if change.from_tier == change.to_tier or {change.from_tier, change.to_tier} == {
        StateTier.L1_DEMAND,
        StateTier.L1S_SPECIAL,
    }:
        raise ValueError(
            f"{change.from_tier} -> {change.to_tier} is a within-tier update (including "
            "the L1S substitution slot), not a tier change — it has no fixed transition "
            "setting; use slew_transition_s() instead"
        )

    norm_from = _normalize(change.from_tier)
    norm_to = _normalize(change.to_tier)

    if norm_to is StateTier.L0_OFF:
        name = "transition_down_off_s"
    elif norm_to is StateTier.L3_AMBIENCE:
        name = "transition_up_ambience_s" if change.rising else "transition_down_ambience_s"
    elif norm_from is StateTier.L0_OFF and norm_to is StateTier.L1_DEMAND:
        if change.occupied and change.fresh_occupancy:
            name = "transition_up_occupancy_s"
        elif change.occupied:
            name = "transition_up_occupied_on_s"
        else:
            name = "transition_automatic_s"
    elif norm_from is StateTier.L1_DEMAND and norm_to is StateTier.L2_DIMINISHED:
        name = "transition_down_diminish_s"
    elif norm_from is StateTier.L2_DIMINISHED and norm_to is StateTier.L1_DEMAND:
        # TBC: TIER_STATE_MACHINE.md, "Transition selection" table, L2 -> L1 row —
        # "Brandon's sheet says 'Clear to L1'" but names no concrete setting.
        # Provisionally reuse the up-occupancy setting; reconcile once confirmed.
        name = "transition_up_occupancy_s"
    else:
        raise ValueError(
            f"no transition rule for {change.from_tier} -> {change.to_tier} "
            f"(occupied={change.occupied}) — not in the spec's transition matrix"
        )

    if not hasattr(settings, name):
        raise AttributeError(
            f"settings object has no field {name!r}, selected for "
            f"{change.from_tier} -> {change.to_tier}"
        )
    return name
