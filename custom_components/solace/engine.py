"""The Solace calculation engine — outdoor lux to one bulb's level.

PURE MODULE. **No ``homeassistant`` imports, ever.**

Implements the 2026-08-15 Master Processing vs Post Processing architecture:
- Master Processing: Spline Lux demand + Cloudy Boost, 24h Brightness timeline, 24h Colour timeline
- Post Processing: State Table (L1, L2, L3, Ls, Off), Stops bias hierarchy, Bedroom Special Modes,
  hardware clamps, explicit Auto/Manual state, and 8 softcoded transitions.
"""

from __future__ import annotations

import math
from typing import Sequence

from .models import (
    DEFAULT_LUX_CURVE,
    EngineInput,
    HouseSettings,
    LightSettings,
    MasterOutput,
    Mode,
    RampPoint,
    RoomSettings,
    Solution,
    SplinePoint,
    StateTable,
    ZoneSettings,
)
from .spline import MonotoneCubicSpline

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
    "solve_master",
    "compute_state_table",
    "solve",
]

MAX_LEVEL = 254


# --------------------------------------------------------------------------------
# Ambience Hysteresis Threshold
# --------------------------------------------------------------------------------


def ambience_threshold(lux: float, was_open: bool, house: HouseSettings) -> bool:
    """Hysteretic dark/bright threshold — for ambience, and nothing else."""
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
    """Apply the per-direction time debounce to a gate transition."""
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
# Demand & Ramp Functions
# --------------------------------------------------------------------------------


def demand(
    lux: float,
    curve_or_house: Sequence[SplinePoint] | HouseSettings,
) -> float:
    """Evaluate lux demand with spline curve."""
    if isinstance(curve_or_house, HouseSettings):
        curve = curve_or_house.lux_curve
    else:
        curve = curve_or_house

    if curve:
        return _clamp01(MonotoneCubicSpline(curve).evaluate(max(0.0, lux)))
    return 0.0


def ramp_bias(hour: float, house: HouseSettings) -> float:
    """Legacy helper: 24h Brightness Timeline replaces the old evening ramp."""
    return 0.0


def mode_for(
    night_active: bool,
    away: bool = False,
    sunrise_progress: float | None = None,
    sunset_progress: float | None = None,
) -> Mode:
    """Operating mode follows away state, special modes, and night latch."""
    if away:
        return Mode.AWAY
    if sunrise_progress is not None:
        return Mode.SUNRISE
    if sunset_progress is not None:
        return Mode.SUNSET
    return Mode.NIGHT if night_active else Mode.NORMAL


def clip_to_full(demand_value: float, stops: float) -> float:
    """Clip fraction to 0..1 range."""
    return _clamp01(demand_value * (2.0**stops))


def to_level(fraction: float) -> int:
    """Fraction to 0-254 level."""
    return int(round(_clamp01(fraction) * MAX_LEVEL))


def apply_clamp(level: int, light: LightSettings) -> int:
    """Per-light hardware max ceiling clamp, ONLY when level > 0."""
    if level <= 0:
        return 0
    return min(light.clamp_max, level)


def apply_cutoff(level: int, cutoff: int) -> int:
    """Cutoff drops to 0 if level is below threshold; does not force levels upward."""
    if level <= 0 or cutoff <= 0:
        return level
    return 0 if level < cutoff else level


def rate_limit(current: int, target: int, step: int) -> int:
    """Cap how far level may move per tick while tracking."""
    if target <= 0:
        return 0
    if current <= 0:
        return target
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
    """Step 16: suppress writes smaller than dead zone unless state changed."""
    if last_written is None:
        return True
    if new_level == 0 or last_written == 0:
        return new_level != last_written
    if last_source is not None and last_source != source:
        return new_level != last_written
    if source in ("ambience", "night", "sunrise", "sunset", "away", "manual", "bedtime_dwell"):
        return new_level != last_written
    return abs(new_level - last_written) >= max(dead_zone, 1)


# --------------------------------------------------------------------------------
# Master Processing
# --------------------------------------------------------------------------------


def solve_master(
    lux: float,
    clock_hour: float,
    house: HouseSettings,
    cloud_coverage: float | None = None,
) -> MasterOutput:
    """Run Master Processing to generate baseline Target Brightness and Target Kelvin."""
    trace: list[tuple[str, object]] = []

    # 1. Lux Demand: evaluate Clear Sun curve and Overcast / Cloudy curve
    demand_clear = demand(lux, house.lux_curve)
    demand_cloudy = demand(lux, house.lux_cloudy_curve)
    trace.append(("lux", lux))
    trace.append(("demand_clear", round(demand_clear, 4)))
    trace.append(("demand_cloudy", round(demand_cloudy, 4)))

    # Cloud blend factor alpha (0.0 = 100% Clear, 1.0 = 100% Overcast)
    alpha = 0.0
    if cloud_coverage is not None:
        thresh = max(0.0, min(99.0, house.cloudy_blend_threshold))
        if cloud_coverage > thresh:
            alpha = min(1.0, max(0.0, (cloud_coverage - thresh) / (100.0 - thresh)))
    trace.append(("cloud_coverage", cloud_coverage))
    trace.append(("cloud_alpha", round(alpha, 4)))

    spline_demand = (1.0 - alpha) * demand_clear + alpha * demand_cloudy
    demand_val = _clamp01(spline_demand)
    trace.append(("demand", round(demand_val, 4)))

    # 2. 24h Target Brightness Schedule
    bright_spline = MonotoneCubicSpline(house.brightness_timeline, periodic=True)
    time_brightness = bright_spline.evaluate_periodic_24h(clock_hour)
    time_brightness_level = int(round(max(0.0, min(MAX_LEVEL, time_brightness))))
    trace.append(("time_brightness_level", time_brightness_level))

    target_brightness = int(round(demand_val * time_brightness_level))
    trace.append(("target_brightness", target_brightness))

    # 3. 24h Target Colour Temperature Schedule
    colour_spline = MonotoneCubicSpline(house.colour_timeline, periodic=True)
    time_kelvin = colour_spline.evaluate_periodic_24h(clock_hour)
    target_kelvin = int(round(max(2000.0, min(9000.0, time_kelvin + house.colour_trim_kelvin))))
    trace.append(("target_kelvin", target_kelvin))

    return MasterOutput(
        target_brightness=target_brightness,
        target_kelvin=target_kelvin,
        demand=demand_val,
        time_brightness_level=time_brightness_level,
        cloud_coverage=cloud_coverage,
        cloud_alpha=alpha,
        demand_clear=demand_clear,
        demand_cloudy=demand_cloudy,
        trace=tuple(trace),
    )


# --------------------------------------------------------------------------------
# Post Processing: State Table Computation
# --------------------------------------------------------------------------------


def compute_state_table(
    master: MasterOutput,
    house: HouseSettings,
    room: RoomSettings,
    light: LightSettings,
    clock_hour: float = 14.0,
    zone: ZoneSettings | None = None,
) -> StateTable:
    """Compute the pre-calculated state table (L1, L2, L3, Ls) for one fixture."""
    zone_stops = zone.bias_stops if zone is not None else room.zone_bias_stops
    total_stops = (
        house.mood_trim_stops
        + house.bias_stops
        + room.bias_stops
        + zone_stops
        + light.bias_stops
    )

    # L1: Occupancy active level (Master Target adjusted by stops bias)
    #
    # ⚠️ NO CUT OFF HERE. Cut Offs are armed/disarmed by the ambience gate, and that gate is
    # not known at state-table time — it is applied in `solve` step 7, which owns the whole
    # rule. Applying it a second time here, unguarded, zeroed L1 whenever the evening curve
    # dipped below a fixture's cut, so six lights could never rise above the ambience floor
    # after dusk. Clamps are always on; Cut Offs are not.
    raw_l1_fraction = clip_to_full(master.demand, total_stops)
    raw_l1 = int(round(raw_l1_fraction * master.time_brightness_level))
    l1 = apply_clamp(raw_l1, light)

    # L2: Diminished subzone level (Stops below L1 preferred)
    diminish_stops = zone.diminish_stops if (zone is not None and zone.diminish_stops > 0) else room.diminish_stops
    dim_pct = zone.diminish_pct if zone is not None else room.diminish_pct

    if diminish_stops > 0:
        raw_l2 = int(round(l1 * (2.0 ** -diminish_stops)))
    elif dim_pct > 0:
        raw_l2 = int(round(l1 * (1.0 - dim_pct / 100.0)))
    else:
        raw_l2 = l1
    l2 = apply_clamp(raw_l2, light)  # Cut Off deferred to step 7, as for L1 above.

    # L3: Ambience resting floor (cutoffs disabled, max clamp preserved)
    ambience_raw = room.ambience_level or house.ambience_level
    l3 = apply_clamp(ambience_raw, light) if ambience_raw > 0 else 0

    # Ls: Housewide Night level (cutoffs disabled, max clamp preserved)
    ls = apply_clamp(house.night_level, light)

    return StateTable(
        l1=l1,
        l2=l2,
        l3=l3,
        ls=ls,
        target_kelvin=master.target_kelvin,
    )


# --------------------------------------------------------------------------------
# Solve for One Fixture
# --------------------------------------------------------------------------------


def solve(
    house: HouseSettings,
    room: RoomSettings,
    light: LightSettings,
    data: EngineInput,
    zone: ZoneSettings | None = None,
) -> Solution:
    """Run Master Processing and Post Processing for one light."""
    trace: list[tuple[str, object]] = []

    # 1. Master Processing
    master = solve_master(
        data.lux,
        data.clock_hour,
        house,
        cloud_coverage=data.cloud_coverage,
    )
    trace.extend(master.trace)

    # 2. Ambience Gate
    ambience_open = (
        data.ambience_resolved
        if data.ambience_resolved is not None
        else ambience_threshold(data.lux, data.ambience_open, house)
    )
    trace.append(("ambience_open", ambience_open))

    # 3. Mode
    mode = mode_for(
        data.night_active,
        away=data.away,
        sunrise_progress=data.sunrise_progress,
        sunset_progress=data.sunset_progress,
    )
    trace.append(("mode", mode.value))

    # 4. State Table
    state_table = compute_state_table(
        master, house, room, light, clock_hour=data.clock_hour, zone=zone
    )
    trace.append(("state_l1", state_table.l1))
    trace.append(("state_l2", state_table.l2))
    trace.append(("state_l3", state_table.l3))
    trace.append(("state_ls", state_table.ls))

    zone_stops = zone.bias_stops if zone is not None else room.zone_bias_stops
    total_stops = (
        house.mood_trim_stops
        + house.bias_stops
        + room.bias_stops
        + zone_stops
        + light.bias_stops
    )
    raw_l1_fraction = clip_to_full(master.demand, total_stops)
    raw_l1 = int(round(raw_l1_fraction * master.time_brightness_level))
    trace.append(("level_raw", raw_l1))

    # 5. State Selection
    level = 0
    source = "demand"

    # A. AWAY MODE
    if mode is Mode.AWAY:
        level = 0
        source = "away"
        trace.append(("away", True))

    # B. BEDROOM SLEEP OVERRIDE: Forced OFF across ALL modes in bedroom
    elif room.night_off and data.asleep:
        level = 0
        source = "sleep"
        trace.append(("bedroom_sleep_forced_off", True))

    # C. VIRTUAL SUNRISE
    elif mode is Mode.SUNRISE:
        if room.sunrise_enabled or room.night_off:
            progress_pct = max(0.0, min(100.0, (data.sunrise_progress or 0.0) * 100.0))
            sunrise_spline = MonotoneCubicSpline(house.sunrise_curve)
            curve_raw = sunrise_spline(progress_pct)
            target_level = min(int(round(curve_raw)), state_table.l1)
            level = apply_clamp(max(0, target_level), light)
            source = "sunrise"
            trace.append(("virtual_sunrise", level))
        else:
            level = 0 if data.asleep else min(house.night_level, state_table.l1)
            source = "sunrise"
            trace.append(("sunrise_other_room", level))

    # D. VIRTUAL SUNSET
    elif mode is Mode.SUNSET:
        progress_pct = max(0.0, min(100.0, (data.sunset_progress or 0.0) * 100.0))
        sunset_spline = MonotoneCubicSpline(house.sunset_curve)
        curve_raw = sunset_spline(progress_pct)
        target_level = min(int(round(curve_raw)), state_table.l1)
        level = apply_clamp(max(0, target_level), light)
        source = "sunset"
        trace.append(("virtual_sunset", level))

    # E. NIGHT MODE
    elif mode is Mode.NIGHT:
        if data.occupied:
            level = state_table.ls
            source = "night"
            trace.append(("night_override", level))
        else:
            if house.ambience_ignores_occupancy and ambience_open and not data.asleep and state_table.l3 > 0:
                level = state_table.l3
                source = "ambience"
                trace.append(("ambience_replaces_off", level))
            else:
                level = 0
                source = "off"
                trace.append(("night_unoccupied", True))

    # F. NORMAL MODE
    else:
        if data.occupied:
            if data.diminish_active:
                diminished = state_table.l2
                if ambience_open and not data.asleep and state_table.l3 > 0 and diminished < state_table.l3:
                    diminished = state_table.l3
                level = diminished
                source = "diminish"
                trace.append(("diminish_l2", level))
            else:
                level = state_table.l1
                source = "demand"
                trace.append(("occupancy_l1", level))

            if level == 0 and ambience_open and not data.asleep and state_table.l3 > 0:
                level = state_table.l3
                source = "ambience"
                trace.append(("ambience_replaces_off", level))
        else:
            dark_and_awake = ambience_open and not data.asleep
            if state_table.l3 > 0 and dark_and_awake:
                level = state_table.l3
                source = "ambience"
                trace.append(("ambience_replaces_off", level))
            else:
                level = 0
                source = "off"
                trace.append(("unoccupied", True))

    # 6. Bedtime Dwell Cap
    if data.bedtime_dwell_active and (room.bedtime_dwell_enabled or room.night_off):
        if level > house.bedtime_dwell_level:
            level = house.bedtime_dwell_level
            source = "bedtime_dwell"
            trace.append(("bedtime_dwell", level))

    # 7. Minimum Cutoff — the ONE place Cut Offs are applied.
    #
    # Cut Offs suppress the weak daytime buzz band. They DISARM whenever a resting floor is
    # armed: L3 (the ambience gate is open) or Ls (night). "Armed" is the gate, not the
    # currently-selected state — a room occupied at dusk still has L3 armed underneath it,
    # so its Cut Off is off.
    #
    # ⚠️ Deliberately NOT conditioned on ``state_table.l3 > 0``. Owner, 2026-08-13: the
    # ambience settings "also disable the Minimum cutoff so that lights can go as low as 1
    # at night when low levels are actually needed" — darkness is what disarms the cutoff,
    # and a room with no ambience floor of its own still gets that. Pinned by
    # test_the_cutoff_drops_out_below_the_threshold_but_zero_is_still_off.
    l3_armed = ambience_open
    ls_armed = mode is Mode.NIGHT
    cutoff = 0 if (l3_armed or ls_armed or data.bedtime_dwell_active or source in ("ambience", "night", "sunrise", "sunset", "bedtime_dwell")) else max(house.min_cutoff, light.clamp_min)
    trace.append(("cutoff_armed", cutoff > 0))
    if 0 < level < cutoff and mode not in (Mode.AWAY, Mode.SUNRISE, Mode.SUNSET, Mode.NIGHT):
        level = 0
        trace.append(("below_cutoff", cutoff))

    # 8. Manual Override
    if data.manual_level is not None:
        level = max(0, min(MAX_LEVEL, data.manual_level))
        source = "manual"
        trace.append(("manual", level))

    # 9. Hardware Clamp
    level = apply_clamp(level, light)
    trace.append(("clamped", level))

    # 10. Rate Limit
    tracking = source == "demand" and data.last_source == "demand"
    if tracking:
        level = rate_limit(data.current_level, level, house.rate_limit_step)
        trace.append(("rate_limited", level))
    else:
        trace.append(("rate_limit_skipped", source))

    # 11. Dead Zone
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
        demand=master.demand,
        stops=total_stops,
        fraction=clip_to_full(master.demand, total_stops),
        source=source,
        state_table=state_table,
        trace=tuple(trace),
    )


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))
