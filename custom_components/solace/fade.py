"""Output planner — how a change actually reaches the bulb.

PURE MODULE — no ``homeassistant`` imports.

**This file exists because of measured hardware behaviour, not preference.** Everything
below is from ``.claude/skills/z2m-commands/SKILL.md`` and
``docs/home-automation/ZIGBEE-FADE-LIMITS.md`` (homelab PR #1385), where it was measured
on these exact bulbs by three independent testers reading Zigbee ``readResponse`` frames.
Nothing here is inferred from documentation, and none of it is guessable — an engine
written from first principles gets it wrong and the failure is *silent*.

The finding that shapes the whole file
--------------------------------------

Long **colour** transitions corrupt. Long **brightness** transitions do not. It is a
**rate** limit, not a duration limit::

    R = Δ / T                    R_crit(colour) ≈ 0.156 mired/second

Seven colour data points separate perfectly on R; the boundary brackets
``1/64 = 0.015625`` mired per decisecond — the signature of a 6-bit fixed-point step
accumulator underflowing to zero. When it underflows the bulb jumps to a hardware rail
and **stalls there permanently** until an absolute write rescues it. No error, no log.

Two consequences that kill the obvious designs:

1. **Chunking does not help.** ``R = Δ/T`` is invariant under chunking — splitting a
   90-minute glide into five 18-minute segments divides Δ and T equally and fails
   identically. (This is why ``plan_colour`` steps rather than chunks.)
2. **A stepped glide must use a SHORT fade then HOLD.** R is computed from the
   **transition time**, never the hold interval::

       ✅ {"color_temp": +5, "transition": 4}    R = 1.25    verified, 18+ steps clean
       ❌ {"color_temp": +5, "transition": 60}   R = 0.083   underflows

   Getting that wrong makes a correct design look broken.

So the architecture is forced:

===============  ==========================================================
Channel          Mechanism
===============  ==========================================================
**Brightness**   One long hardware ``transition``. Safe, free, zero traffic.
                 Verified linear to 40 minutes.
**Colour**       Software-stepped absolutes — a small ``color_temp`` every
                 ~60 s, each step's own fade short and far inside the safe
                 window. A stalled step is cheap to detect and fix.
===============  ==========================================================

🔴 **IKEA is the exception.** A concurrent colour step **froze an in-flight brightness
fade at 84 for 420 s**, against a clean same-family control that tracked perfectly. On
those five bulbs the two channels must be serialised. See ``may_run_concurrently``.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from math import ceil

from .models import Family

__all__ = [
    "R_CRIT_COLOUR_MIRED_PER_S",
    "MAX_TRANSITION_S",
    "PlanKind",
    "ColourStep",
    "ColourPlan",
    "BrightnessSegment",
    "BrightnessPlan",
    "rate",
    "colour_transition_is_safe",
    "plan_colour",
    "plan_brightness",
    "may_run_concurrently",
]

R_CRIT_COLOUR_MIRED_PER_S = 0.156
"""Measured colour rate floor. Bracketed 0.133-0.167 by the data; the fitted boundary is
1/64 mired per decisecond = 0.15625 mired/s. **Exposed as a helper** — Series 1 and 4 of
the test plan will narrow it, and it may differ per family."""

R_CRIT_SAFETY = 1.5
"""Multiplier on R_crit. The boundary is bracketed, not pinned, and the failure mode is
a permanently stalled bulb — so plan comfortably inside it rather than on it."""

MAX_TRANSITION_S = 6500
"""Zigbee carries ``transtime`` as a **16-bit decisecond field** ⇒ 65535 ds ≈ 109
minutes. z2m applies no cap (it just sends ``transition * 10``), so a longer value risks
silently wrapping. The 2026-07 build clamped to 6500 s deliberately rather than wrap;
do the same."""

DEFAULT_STEP_TRANSITION_S = 4.0
"""Per-step fade for a stepped colour glide. Matches the bulbs' own hidden default —
but **send it explicitly anyway**. Every bulb in this house carries ``transition: 4`` in
z2m's configuration.yaml, so omitting ``transition:`` inherits a 4 s fade and reads as
sluggish. ha-hardware-truth §3: always send it, every time."""


class PlanKind(str, Enum):
    NONE = "none"
    TRANSITION = "transition"
    STEPPED = "stepped"


def rate(delta: float, seconds: float) -> float:
    """``R = Δ / T``, in units per second. Units are mireds for colour, levels for
    brightness — the two channels use different clusters and must be modelled
    separately."""
    if seconds <= 0:
        return float("inf")
    return abs(delta) / seconds


def colour_transition_is_safe(
    delta_mired: float,
    seconds: float,
    r_crit: float = R_CRIT_COLOUR_MIRED_PER_S,
    safety: float = R_CRIT_SAFETY,
) -> bool:
    """Will a single ``color_temp`` + ``transition`` survive, or will it underflow?"""
    if delta_mired == 0:
        return True
    return rate(delta_mired, seconds) >= r_crit * safety


@dataclass(frozen=True, slots=True)
class ColourStep:
    at_s: float
    """Seconds from the start of the plan."""
    mired: int
    transition_s: float
    """The step's OWN fade — short. Never the interval to the next step."""


@dataclass(frozen=True, slots=True)
class ColourPlan:
    kind: PlanKind
    steps: tuple[ColourStep, ...]
    interval_s: float
    """Hold time between steps. Informational — the coordinator schedules on ``at_s``."""
    reason: str
    """Why this shape was chosen. Surfaced in the panel; a stepped plan looks like
    chattering traffic unless the reason is visible."""

    @property
    def is_stepped(self) -> bool:
        return self.kind is PlanKind.STEPPED


@dataclass(frozen=True, slots=True)
class BrightnessSegment:
    at_s: float
    level: int
    transition_s: float


@dataclass(frozen=True, slots=True)
class BrightnessPlan:
    segments: tuple[BrightnessSegment, ...]
    reason: str


def plan_colour(
    start_mired: int,
    target_mired: int,
    duration_s: float,
    *,
    step_mired: int = 5,
    step_transition_s: float = DEFAULT_STEP_TRANSITION_S,
    r_crit: float = R_CRIT_COLOUR_MIRED_PER_S,
    safety: float = R_CRIT_SAFETY,
) -> ColourPlan:
    """Plan a colour change from ``start_mired`` to ``target_mired`` over ``duration_s``.

    Picks the mechanism the hardware can actually execute:

    * **Single transition** when the rate is comfortably above ``R_crit`` and the
      duration fits inside the 16-bit ``transtime`` field. One command, no traffic.
    * **Stepped absolutes** otherwise — the only thing that works for a slow glide.
      Each step's own fade is short (so its R is ~1.25 mired/s, far inside the safe
      window) and the *hold* between steps does the pacing.

    Note what this deliberately does **not** do: split a slow glide into shorter
    transitions. That is the intuitive fix and it fails identically, because R is
    invariant under chunking.
    """
    delta = target_mired - start_mired
    if delta == 0:
        return ColourPlan(PlanKind.NONE, (), 0.0, "already at target")

    if duration_s <= MAX_TRANSITION_S and colour_transition_is_safe(
        delta, duration_s, r_crit, safety
    ):
        seconds = max(duration_s, 0.0)
        return ColourPlan(
            PlanKind.TRANSITION,
            (ColourStep(at_s=0.0, mired=target_mired, transition_s=seconds),),
            interval_s=seconds,
            reason=(
                f"single transition: R={rate(delta, seconds):.3f} mired/s "
                f">= {r_crit * safety:.3f} floor"
            ),
        )

    # Stepped. Choose a step size whose OWN fade is safe, then let the hold do the
    # pacing. A step smaller than this would underflow inside its own 4 s fade.
    min_step = max(1, ceil(r_crit * safety * step_transition_s))
    size = max(step_mired, min_step)

    count = max(1, ceil(abs(delta) / size))
    interval = duration_s / count

    # If the holds would be shorter than the fades, the glide is not actually slow —
    # a single transition is both safe and smoother.
    if interval < step_transition_s:
        seconds = min(max(duration_s, 0.0), MAX_TRANSITION_S)
        return ColourPlan(
            PlanKind.TRANSITION,
            (ColourStep(at_s=0.0, mired=target_mired, transition_s=seconds),),
            interval_s=seconds,
            reason="steps would be shorter than their own fades; single transition",
        )

    steps: list[ColourStep] = []
    for i in range(1, count + 1):
        mired = int(round(start_mired + delta * (i / count)))
        if i == count:
            mired = target_mired  # land exactly, never near
        steps.append(
            ColourStep(
                at_s=round(interval * i, 3),
                mired=mired,
                transition_s=step_transition_s,
            )
        )

    return ColourPlan(
        PlanKind.STEPPED,
        tuple(steps),
        interval_s=interval,
        reason=(
            f"stepped: {count} × {size} mired, each fading in {step_transition_s:g}s "
            f"(R={size / step_transition_s:.2f}) then holding {interval:.0f}s — "
            f"a single {duration_s:.0f}s transition would be "
            f"R={rate(delta, duration_s):.4f}, below the {r_crit:.3f} floor"
        ),
    )


def plan_brightness(
    target_level: int,
    duration_s: float,
    *,
    start_level: int | None = None,
) -> BrightnessPlan:
    """Plan a brightness change. **One long hardware transition — that is the whole
    trick.**

    Brightness rides ``genLevelCtrl``, a different cluster with different accumulator
    precision, and is verified clean at 0.085 levels/s (900 s fade exact at all five
    samples; 2400 s confirmed by a second tester). There is no known practical rate
    floor, so there is nothing to plan around except the ``transtime`` field.

    A duration beyond the 16-bit ceiling is split into segments. Splitting is safe
    *here* precisely because brightness has no rate limit — the same move on colour
    would be useless.
    """
    duration = max(duration_s, 0.0)
    if duration <= MAX_TRANSITION_S:
        return BrightnessPlan(
            (BrightnessSegment(at_s=0.0, level=target_level, transition_s=duration),),
            reason=f"single hardware transition over {duration:.0f}s",
        )

    count = ceil(duration / MAX_TRANSITION_S)
    span = duration / count
    begin = start_level if start_level is not None else target_level
    delta = target_level - begin

    segments: list[BrightnessSegment] = []
    for i in range(1, count + 1):
        level = int(round(begin + delta * (i / count)))
        if i == count:
            level = target_level
        segments.append(
            BrightnessSegment(at_s=round(span * (i - 1), 3), level=level, transition_s=span)
        )

    return BrightnessPlan(
        tuple(segments),
        reason=(
            f"{count} segments of {span:.0f}s — a single {duration:.0f}s transition "
            f"exceeds the {MAX_TRANSITION_S}s uint16 transtime ceiling and would "
            "silently wrap"
        ),
    )


def may_run_concurrently(family: Family) -> bool:
    """May a colour glide run on top of an in-flight brightness fade for this bulb?

    **No, on IKEA.** Measured 2026-08-12 with a clean same-family control:
    ``Entry Ceiling`` running brightness 90→40 over 600 s *with* concurrent colour steps
    **stalled at 84** — T+180/360/540/600 all 84 — while ``Entry Uplight`` doing
    brightness alone over the same window hit 40→50→60→70 exactly at every sample. One
    variable changed.

    Yes on both Aqara families, verified in both directions including a 4-bulb RGB combo
    that hit its brightness target exactly while colour stepped alongside.

    ⚠️ The IKEA result is one controlled comparison. It is worth a confirming run before
    it hardens into a design rule — but until then the safe default is to serialise,
    because the failure is silent.
    """
    return family is not Family.IKEA
