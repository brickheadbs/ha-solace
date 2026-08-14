"""The Solace calculation engine — outdoor lux to one bulb's level.

PURE MODULE. **No ``homeassistant`` imports, ever.**

    "Keep pure functions (calculations, curves, interpolation) in their own module with
    no homeassistant imports. That file is testable with plain pytest and is where the
    logic bugs actually live; everything else is plumbing."
        — ha-integration-build §8

This file implements the 17-step contract from the build brief, archived 2026-08-13 at
``homelab:docs/archive/SOLACE-BUILD-BRIEF-2026-08-13.md``
("Order of calculation — lux sensor → one bulb"). **Order matters**: several steps are
only correct in this position, and two of them were bugs in earlier drafts that got
fixed by moving them. Read the brief before reordering anything here.

The two traps already paid for, do not reintroduce:

1. **Midnight.** Decimal clock comparisons break after 00:00 (``23.5 < 6.5`` is False).
   Every clock window runs on ``(clock - 18) % 24`` and the ramp has an explicit
   morning release.
2. **Clamp before the zero check.** Clamping 0 up to ``clamp_min`` leaves the room
   glowing at level 1 instead of off. The clamp is last *and* conditional on level > 0.
"""

from __future__ import annotations

import math

from .models import (
    EngineInput,
    HouseSettings,
    LightSettings,
    Mode,
    RampPoint,
    RoomSettings,
    Solution,
    ZoneSettings,
)

__all__ = [
    "ambience_threshold",
    "debounce_ambience",
    "demand",
    "ramp_bias",
    "mode_for",
    "clip_to_full",
    "to_level",
    "apply_clamp",
    "rate_limit",
    "past_dead_zone",
    "solve",
]

MAX_LEVEL = 254
"""Levels are 0-254 integers, never percent. At 1 % a percent UI can only command 2.54,
and the 1-10 % band is exactly where the owner lives. z2m passes floats through and the
*bulb* truncates (verified: sent 63.75, bulb reported 63)."""


# --------------------------------------------------------------------------------
# Step 2 — the ambience threshold: is it dark enough for the resting glow?
# --------------------------------------------------------------------------------


def ambience_threshold(lux: float, was_open: bool, house: HouseSettings) -> bool:
    """Hysteretic dark/bright threshold — **for ambience, and nothing else.**

    Two thresholds, deliberately apart, so the boundary does not flicker: it reads DARK
    at or below ``ambience_start_lux`` and does not read BRIGHT again until lux reaches
    ``ambience_stop_lux``.

    ⚠️ **This does NOT decide whether lights may run.** It used to, and that was a design
    error with a long paper trail:

    * Owner, 2026-08-13: *"It isn't supposed to be a gate. It is supposed to ONLY be for
      ambience lighting."*
    * The panel shipped a card claiming the two jobs were deliberately one mechanism —
      *"shipping them separately would be two systems doing one job"*. That claim was
      invented here, not asked for.
    * This docstring previously observed that the 50/80 pair made *"the top ~85 % of the
      demand curve unreachable"* and dismissed it as **"a tuning observation, not a bug"**.
      It was the bug. At 247 lx an occupied room computed level 18 and was then zeroed,
      and the only way to find out was to ask.

    **Normal lighting is governed by demand, occupancy and ``min_cutoff``** — the demand
    curve already falls to zero at ``lux_full + lux_window`` on its own, so it needs no
    second ceiling bolted on top.
    """
    if was_open:
        return lux < house.ambience_stop_lux
    return lux <= house.ambience_start_lux


def debounce_ambience(
    raw_open: bool,
    was_open: bool,
    now: float,
    pending_since: float | None,
    house: HouseSettings,
) -> tuple[bool, float | None]:
    """Apply the per-direction time debounce to a gate transition.

    Returns ``(ambience_open, new_pending_since)``.

    ⚠️ **Both debounces default to 0 and 0 must mean *no* debounce** — not "a very short
    one". The Sonoff mmWave sensors already impose a 15 s minimum in hardware that
    cannot be removed, and z2m adds ``no_occupancy_since`` on top. Stacking a 3-minute
    rising debounce on that is 3 m 15 s of lag and then a mystery.
    """
    if raw_open == was_open:
        return was_open, None

    delay = house.ambience_debounce_falling_s if raw_open else house.ambience_debounce_rising_s
    if delay <= 0:
        return raw_open, None

    if pending_since is None:
        return was_open, now
    if now - pending_since >= delay:
        return raw_open, None
    return was_open, pending_since


# --------------------------------------------------------------------------------
# Step 3 — demand: the only step that is not taste
# --------------------------------------------------------------------------------


def demand(lux: float, house: HouseSettings) -> float:
    """How much light the room needs for this outdoor lux, 0-1.

    **Log falloff**, per the design handoff — not the linear form in the xlsx::

        lo = lux_full;  hi = lux_full + lux_window
        demand = 1 - ln(lux/lo) / ln(hi/lo)

    Perceptually correct (the eye is roughly logarithmic), and it self-corrects the
    "curve saturates at high lux" concern the linear version had.

    Objective, **not an adjustment**. Its *shape* is tunable via ``lux_full`` and
    ``lux_window``; its output is never a bias.
    """
    lo = max(house.lux_full, 1e-9)
    hi = lo + max(house.lux_window, 1e-9)
    if lux <= lo:
        return 1.0
    if lux >= hi:
        return 0.0
    return _clamp01(1.0 - math.log(lux / lo) / math.log(hi / lo))


# --------------------------------------------------------------------------------
# Step 4 — mode and the evening ramp
# --------------------------------------------------------------------------------


def mode_for(
    night_active: bool,
    away: bool = False,
    sunrise_progress: float | None = None,
) -> Mode:
    """Operating mode follows away state, virtual sunrise, and night latch.

    ⚠️ It is tempting to write ``Mode.NIGHT if dnd else Mode.NORMAL``. That is wrong, and
    it was wrong here for a day. DND clears when he gets out of bed (measured), so that
    version leaves night mode the moment he stands up at 3 am and relights the house at
    full demand. The latch is computed by the coordinator; see ``EngineInput.night_active``.
    """
    if away:
        return Mode.AWAY
    if sunrise_progress is not None:
        return Mode.SUNRISE
    return Mode.NIGHT if night_active else Mode.NORMAL


def _evening_axis(hour: float, anchor: float) -> float:
    """Map a clock hour onto an evening-relative axis so midnight is not a cliff.

    ``(clock - anchor) % 24`` makes the evening monotonic across midnight, which a raw
    decimal clock is not: with the 15:00 anchor, 20:00 is 5, 22:30 is 7.5, 02:00 is 11
    and the 06:30 release is 15.5.

    ⚠️ **The anchor was the literal 18.0 until 2026-08-13, and that silently discarded
    ramp points earlier than 18:00.** Any point before the anchor wraps to ~23, which
    sorts *after* the morning release and is read as daytime — zero stops, no error. At
    54°N midwinter, sunset is 16:05 and civil dusk 16:50, so a perfectly sensible 16:30
    ramp point vanished. It is a setting now, and the default moved to 15:00 so the
    darkest evenings of the year fit inside it.
    """
    return (hour - anchor) % 24.0


def ramp_bias(hour: float, house: HouseSettings) -> float:
    """Bias in stops from the evening ramp — a continuous glide through N points.

    An **ordered list**, not two hardcoded phases. Two points are the starting config,
    not the schema. Because the glide between points is continuous it needs no
    transition of its own; only a *mode* change uses the mode-change transition.

    Outside the ramp (after the morning release, through the day) the bias is 0.
    """
    if not house.ramp:
        return 0.0

    anchor = house.evening_axis_hour
    axis = _evening_axis(hour, anchor)
    release = _evening_axis(house.morning_release_hour, anchor)
    if axis >= release:
        return 0.0

    points = sorted(
        (RampPoint(hour=_evening_axis(p.hour, anchor), stops=p.stops) for p in house.ramp),
        key=lambda p: p.hour,
    )
    onset = max(house.ramp_onset_minutes, 0.0) / 60.0
    if axis < points[0].hour - onset:
        return 0.0
    if axis < points[0].hour:
        # ⚠️ **NEVER JUMP.** This used to hold a flat 0 right up to the first ramp point
        # and then *step* onto it. Gliding all the way from 18:00 would invent a bias
        # nobody asked for, so instead it eases in over ``ramp_onset_minutes``
        # immediately before the first point — smooth, but still no bias at teatime.
        # Set the onset to 0 to get the old step back.
        if onset <= 0:
            return 0.0
        return ((axis - (points[0].hour - onset)) / onset) * points[0].stops
    if axis >= points[-1].hour:
        # Hold the last point until the morning release — this is what the release is
        # for. Without it the ramp would either snap back at midnight or hold forever.
        return points[-1].stops

    for lo, hi in zip(points, points[1:]):
        if lo.hour <= axis <= hi.hour:
            span = hi.hour - lo.hour
            if span <= 0:
                return hi.stops
            t = (axis - lo.hour) / span
            return lo.stops + t * (hi.stops - lo.stops)
    return 0.0


# --------------------------------------------------------------------------------
# Steps 5-7 — bias, clip, level
# --------------------------------------------------------------------------------


def clip_to_full(demand_value: float, stops: float) -> float:
    """Step 6. ``min(1, demand × 2^stops)``.

    **This is the CLIP, not the CLAMP.** It stops bias pushing demand past 100 %.
    The per-light clamp is step 14 and is a completely different mechanism; conflating
    the two is how the "room glows at level 1 when it should be off" bug appeared.
    """
    return _clamp01(demand_value * (2.0**stops))


def to_level(fraction: float) -> int:
    """Step 7. Fraction to the command scale, 0-254 integers."""
    return int(round(_clamp01(fraction) * MAX_LEVEL))


# --------------------------------------------------------------------------------
# Step 14 — the clamp, always last
# --------------------------------------------------------------------------------


def apply_clamp(level: int, light: LightSettings) -> int:
    """Per-light hard limits, **only when the light should be ON**.

    The conditional is the whole point. ``living_ceiling`` has a clamp_min above 0 and a
    glare cap around 10; clamping a computed 0 up to clamp_min would leave the room
    glowing instead of dark. Bug found and fixed 2026-08-11 — do not "simplify" the
    ``if level <= 0`` away.
    """
    if level <= 0:
        return 0
    return min(light.clamp_max, max(light.clamp_min, level))


# --------------------------------------------------------------------------------
# Step 15 — the rate limiter (tracking only)
# --------------------------------------------------------------------------------


def rate_limit(current: int, target: int, step: int) -> int:
    """Cap how far the level may move per tick — **while tracking only**.

    The limiter's job is to stop *hunting*: outdoor lux wobbles ⇒ demand wobbles ⇒
    without a cap the bulb visibly chases every wobble.

    The trap (a real bug in the xlsx calculator): applying that cap to on and off too.
    Traced failure — light at 60, target 0, the naive limiter moved it **up** to 54,
    the opposite of the instruction. On and off are *commands*, not tracking, and
    smoothness there is already the ``transition:`` parameter's job, executed by the
    bulb in hardware.
    """
    if target <= 0:
        return 0  # OFF now; the off-transition does the fade.
    if current <= 0:
        return target  # ON straight to level; the on-transition fades it up.
    if step <= 0:
        return target
    delta = max(-step, min(step, target - current))
    return current + delta


def past_dead_zone(
    new_level: int,
    last_written: int | None,
    dead_zone: int,
    source: str = "demand",
    last_source: str | None = None,
) -> bool:
    """Step 16. A change smaller than the dead zone writes nothing at all.

    Always write when the answer is "off" or "on from off", on state/source changes,
    or on explicit non-demand modes (ambience, night, sunrise, away, manual) so small
    steps (e.g. 1 level) take effect cleanly.
    """
    if last_written is None:
        return True
    if new_level == 0 or last_written == 0:
        return new_level != last_written
    if last_source is not None and last_source != source:
        return new_level != last_written
    if source in ("ambience", "night", "sunrise", "away", "manual"):
        return new_level != last_written
    return abs(new_level - last_written) >= max(dead_zone, 1)


# --------------------------------------------------------------------------------
# The orchestrator
# --------------------------------------------------------------------------------


def solve(
    house: HouseSettings,
    room: RoomSettings,
    light: LightSettings,
    data: EngineInput,
    zone: ZoneSettings | None = None,
) -> Solution:
    """Run the full 17-step pipeline for one light.

    Every intermediate is recorded in ``Solution.trace`` so the panel can show the
    consequence beside the control ("-1 stop → level 102 (18 % light)") rather than a
    bare number the user has to decode.
    """
    trace: list[tuple[str, object]] = []

    # 1. Outdoor lux — the one sensor in the house.
    trace.append(("lux", data.lux))

    # 2. Ambient gate (hysteretic). The *time* debounce needs a clock, which this module
    #    does not have, so the caller applies it and hands the finished answer down in
    #    `ambience_resolved`. Recomputing it here from `ambience_open` is what quietly nullified
    #    the debounce — see EngineInput.ambience_resolved.
    ambience_open = (
        data.ambience_resolved
        if data.ambience_resolved is not None
        else ambience_threshold(data.lux, data.ambience_open, house)
    )
    trace.append(("ambience_open", ambience_open))

    # 3. Demand — objective.
    demand_value = demand(data.lux, house)
    trace.append(("demand", round(demand_value, 4)))

    # 4. Mode.
    mode = mode_for(data.night_active, away=data.away, sunrise_progress=data.sunrise_progress)
    ramp = 0.0 if mode in (Mode.NIGHT, Mode.AWAY, Mode.SUNRISE) else ramp_bias(data.clock_hour, house)
    trace.append(("mode", mode.value))
    trace.append(("ramp_stops", round(ramp, 4)))

    # 5. Bias — additive stops, four levels plus the ramp. Additive so a parent dial
    #    moves everything while children keep their offsets.
    zone_stops = zone.bias_stops if zone is not None else room.zone_bias_stops
    stops = (
        house.bias_stops
        + room.bias_stops
        + zone_stops
        + light.bias_stops
        + ramp
    )
    trace.append(("stops", round(stops, 4)))

    # 6-7. Clip, then the command scale.
    fraction = clip_to_full(demand_value, stops)
    level = to_level(fraction)
    trace.append(("fraction", round(fraction, 4)))
    trace.append(("level_raw", level))

    # Away mode: instantly shut off all lights across the house
    if mode is Mode.AWAY:
        level = 0
        trace.append(("away", True))

    # Virtual sunrise wake-up fade
    elif mode is Mode.SUNRISE:
        if room.sunrise_enabled or room.night_off:
            progress = max(0.0, min(1.0, data.sunrise_progress or 0.0))
            eased = progress ** 1.5
            target_level = max(level, 30)
            level = int(round(eased * target_level))
            trace.append(("virtual_sunrise", level))
        else:
            level = 0 if (room.night_off and data.asleep) else house.night_level
            trace.append(("sunrise_other_room", level))

    # 8. Night override — a fixed level, not a scaling.
    elif mode is Mode.NIGHT:
        if room.night_off and data.asleep:
            # The bedroom's rule, keyed on ASLEEP (not on the night latch): a night level
            # in the room he is asleep in is not a gentler version of off, it is a light
            # on. The moment he is up — DND clears by itself — this falls through to the
            # night level below, so the room he is standing in is never the dark one.
            level = 0
            trace.append(("night_off", True))
        else:
            level = house.night_level
            trace.append(("night_override", level))

    # Bedtime wind-down (auto dwell) in bedroom before sleep
    if mode is Mode.NORMAL and data.bedtime_dwell_active and (room.bedtime_dwell_enabled or room.night_off) and data.occupied:
        if level > house.bedtime_dwell_level:
            level = house.bedtime_dwell_level
            trace.append(("bedtime_dwell", level))

    # 10. Diminish — a reduction that STAYS; never an off. Per ZONE: the end of the room
    #     nobody is standing in dims, the rest of it does not.
    demand_level = level
    diminish_pct = zone.diminish_pct if zone is not None else room.diminish_pct
    if diminish_pct > 0 and data.diminish_active and level > 0 and mode not in (Mode.AWAY, Mode.SUNRISE):
        level = int(round(level * (1.0 - diminish_pct / 100.0)))
        trace.append(("diminish", level))

    # 11. Occupancy. The only thing that switches normal lighting off outright.
    if not data.occupied and mode not in (Mode.AWAY,):
        level = 0
        trace.append(("unoccupied", True))

    # 12. Min cutoff — below it, off rather than a useless glow.
    cutoff = 0 if ambience_open else house.min_cutoff
    if 0 < level < cutoff and mode not in (Mode.AWAY, Mode.SUNRISE):
        level = 0
        trace.append(("below_cutoff", cutoff))

    # 12b. AMBIENCE — **the replacement for OFF**, not a floor under demand.
    ambience = room.ambience_level or house.ambience_level
    dark_and_awake = ambience_open and not data.asleep
    lit_here = data.occupied or house.ambience_ignores_occupancy
    if ambience > 0 and dark_and_awake and lit_here and mode not in (Mode.AWAY, Mode.SUNRISE):
        if level == 0:
            level = ambience
            trace.append(("ambience_replaces_off", level))
        elif demand_level >= ambience and level < ambience:
            level = ambience
            trace.append(("ambience_clamp", level))
        elif demand_level < ambience and level < house.demand_floor_level:
            level = house.demand_floor_level
            trace.append(("demand_floor", level))

    # 13. Manual wins over everything computed above.
    if data.manual_level is not None:
        level = max(0, min(MAX_LEVEL, data.manual_level))
        trace.append(("manual", level))

    # 14. CLAMP — per light, LAST, and only when the light should be on.
    level = apply_clamp(level, light)
    trace.append(("clamped", level))

    # 14b. WHY is the level what it is? Needed by the limiter below.
    steps_taken = dict(trace)
    if data.manual_level is not None:
        source = "manual"
    elif mode is Mode.AWAY:
        source = "away"
    elif level <= 0:
        source = "off"
    elif "virtual_sunrise" in steps_taken:
        source = "sunrise"
    elif "ambience_replaces_off" in steps_taken:
        source = "ambience"
    elif mode is Mode.NIGHT:
        source = "night"
    else:
        source = "demand"

    # 15. Rate limit — **demand tracking only, and only between two demand ticks.**
    tracking = source == "demand" and data.last_source == "demand"
    if tracking:
        level = rate_limit(data.current_level, level, house.rate_limit_step)
        trace.append(("rate_limited", level))
    else:
        trace.append(("rate_limit_skipped", source))

    # 16. Dead zone.
    write = past_dead_zone(
        level,
        data.last_written_level,
        house.dead_zone,
        source=source,
        last_source=data.last_source,
    )
    trace.append(("should_write", write))

    return Solution(
        level=level,
        should_write=write,
        mode=mode,
        ambience_open=ambience_open,
        demand=demand_value,
        stops=stops,
        fraction=fraction,
        source=source,
        trace=tuple(trace),
    )


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))
