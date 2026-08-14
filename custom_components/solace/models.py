"""Settings and input models for the Solace lighting engine.

PURE MODULE — no ``homeassistant`` imports. See ``engine.py`` for why.

⚠️ **Every field below is a STARTING VALUE for a helper, never a constant.**
The brief's core rule: *"as few values as possible should be hardcoded... A value that
cannot be changed from the panel is a bug."* The defaults here exist so a fresh install
does something sane and so the tests have a fixture — the config entry overrides all of
them, and the panel writes the config entry.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import Enum

__all__ = [
    "Family",
    "ZoneSettings",
    "Mode",
    "RampPoint",
    "HouseSettings",
    "RoomSettings",
    "LightSettings",
    "EngineInput",
    "Solution",
    "RemoteSettings",
]


class Family(str, Enum):
    """Bulb families. They differ in ways the engine must know about.

    See ha-hardware-truth §1 (Kelvin ranges) and z2m-commands §2 (IKEA freezes an
    in-flight brightness fade when colour steps arrive alongside it).
    """

    AQARA_RGB = "aqara_rgb"
    AQARA_CCT = "aqara_cct"
    IKEA = "ikea"


class Mode(str, Enum):
    """Engine operating modes."""

    NORMAL = "normal"
    NIGHT = "night"
    AWAY = "away"
    SUNRISE = "sunrise"


@dataclass(frozen=True, slots=True)
class RampPoint:
    """One point on the evening ramp.

    The ramp is an **ordered list**, not two hardcoded phases — retrofitting a third
    phase later is worse than supporting N now (brief, "Evening ramp — a list").
    """

    hour: float
    """Clock hour, 0-24 (e.g. 22.5 == 22:30)."""

    stops: float
    """Bias in stops at this point. Negative = dimmer."""


@dataclass(frozen=True, slots=True)
class HouseSettings:
    """House-wide settings. One per config entry."""

    # -- Step 2: ambient gate (lux hysteresis) ------------------------------------
    ambience_start_lux: float = 50.0
    """Falling edge — at or below this, lights MAY run."""
    ambience_stop_lux: float = 80.0
    """Rising edge — at or above this, lights stop. Must be > ambience_start_lux."""
    ambience_debounce_falling_s: float = 0.0
    ambience_debounce_rising_s: float = 0.0
    """⚠️ THE DEBOUNCE RULE: default 0, and 0 must mean *no* debounce. Three layers
    already debounce before HA sees anything (Sonoff 15 s in hardware, z2m
    no_occupancy_since, then us). Never raise these without the owner's explicit
    approval."""

    # -- Step 3: demand (log falloff) ---------------------------------------------
    lux_full: float = 1.0
    """`lo` — outdoor lux at or below which demand is 1.0."""
    lux_window: float = 539.0
    """`hi = lux_full + lux_window` — outdoor lux at which demand reaches 0."""

    # -- Step 4: mode / evening ramp ----------------------------------------------
    ramp: tuple[RampPoint, ...] = (
        RampPoint(hour=20.0, stops=-0.5),
        RampPoint(hour=22.5, stops=-1.5),
    )
    morning_release_hour: float = 6.5
    """Explicit morning release. Without it the ramp holds its last value all next day
    (trap #1 in the brief — decimal clock comparisons break after midnight)."""

    # -- Step 5: bias --------------------------------------------------------------
    bias_stops: float = 0.0

    # -- Steps 8-12, 15-16: gates and limits ---------------------------------------
    night_level: int = 3
    """Step 8. A fixed level, not a scaling — predictable when half asleep."""
    night_release_lux: float = 10.0
    """Night mode ends when outdoor lux rises above this, so a 4 am summer sunrise
    returns normal logic instead of holding the house at the night level all morning."""
    alarm_lead_minutes: float = 30.0
    """Night mode also ends this long before the next alarm, whichever comes first."""
    alarm_stale_minutes: float = 120.0
    """How far in the PAST an alarm may be and still count as a wake-up.

    ``sensor.pixel_8a_next_alarm`` only republishes after an alarm fires (measured: the
    06:00 value was still being reported at 06:47), so on a night with no alarm set it
    holds yesterday's time forever. Unbounded, that unlatches night mode the instant he
    falls asleep — and at 3 am the house lights at full demand. Beyond this, the alarm is
    a leftover and night mode ends on lux at dawn instead."""
    ambience_level: int = 0
    """Step 9. A low-light *floor* while awake and the gate reads dark. 0 ⇒ feature off."""
    ambience_ignores_occupancy: bool = True
    """RESOLVED by the owner 2026-08-13: *"Ambience is correctly stated as on with
    conditions true: below threshold and awake."* Two conditions — occupancy is not one
    of them, so the ambience floor survives an empty room. (The brief's step order put
    the occupancy gate after the floor, which would have gone dark instead; that reading
    is now settled.) Still a helper, because it is still a preference."""
    min_cutoff: int = 1
    """Step 12. Below this ⇒ 0, not a useless glow."""
    rate_limit_step: int = 0
    """Step 15. Max level change per tick while *tracking*. 0 ⇒ unlimited."""
    dead_zone: int = 2
    """Step 16. A change smaller than this writes nothing at all."""

    # -- Clock 2: the adaptive interval -------------------------------------------
    update_interval_min_s: float = 30.0
    """Used while the outdoor lux is moving fast."""
    update_interval_home_s: float = 150.0
    """Stable, but someone is home."""
    update_interval_max_s: float = 600.0
    """Stable and empty."""
    lux_volatility_lx: float = 50.0
    """Spread across the last few readings above which lux counts as *moving*."""

    # -- Step 17: transitions ------------------------------------------------------
    transition_on_s: float = 2.0
    transition_off_s: float = 4.0
    transition_mode_s: float = 10.0
    transition_setting_s: float = 0.5
    """Fires while dragging a slider — a long glide here is unusable."""

    # -- Colour (house-wide, one value; clamped per bulb on the way out) -----------
    day_kelvin: int = 4000
    night_kelvin: int = 2200
    colour_glide_minutes: float = 90.0
    colour_trim_kelvin: int = 0
    """Manual trim, added after the curve."""
    colour_step_mired: int = 5
    """Step size for families that must **serialise** colour against brightness — they
    skip steps while a brightness fade runs, so a coarse walk tracks and a fine one
    drifts. See ``fade.fade_profile``."""
    colour_step_mired_smooth: int = 2
    """Step size for families that may glide colour *during* a brightness fade. They
    never skip a step, so they can be walked finely and look continuous."""
    colour_catch_up_steps: int = 3
    """How many steps' worth a single move may cover when catching up after skipped
    steps. Safe at any size — a larger Δ over the same short fade raises R, away from the
    underflow floor — so this bounds the visible jump, not the hardware risk."""
    colour_step_transition_s: float = 4.0
    """See fade.py — R is computed from the TRANSITION time, never the step interval."""

    # -- Formerly literals buried in the plumbing (2026-08-13) ---------------------
    refresh_debounce_s: float = 0.3
    """How long to coalesce a slider drag before recalculating. Fires immediately, then
    coalesces — the opposite of the 10 s default, which is the failure the brief blames
    for the last build."""
    dusk_fallback_hour: float = 21.5
    """Used only when ``sun.sun`` has no usable ``next_dusk``."""
    lux_history_samples: int = 5
    """How many readings the volatility window keeps."""
    manual_brightness_threshold: int = 25
    manual_kelvin_threshold: int = 100
    """Deltas above which a change is a HUMAN touch rather than a bulb echoing back a
    value that differs slightly from what was commanded. Adaptive Lighting's measured
    numbers, but measured on *its* hardware — hence tunable here."""
    fallback_min_kelvin: int = 2000
    fallback_max_kelvin: int = 9009
    """Used only when a light does not report its own range."""
    family_cct_max_kelvin: int = 4200
    family_rgb_max_kelvin: int = 7000
    """Where the bulb-family split falls, by reported Kelvin ceiling."""
    colour_rate_floor: float = 0.156
    """Measured colour rate floor, mired/s. Below it a bulb's 6-bit fixed-point step
    underflows and the fade stalls."""
    colour_rate_safety: float = 1.5
    """Multiplier on the floor. The boundary is bracketed, not pinned, and the failure
    mode is a permanently stalled bulb — plan comfortably inside it."""

    # -- Smoothness. THE RULE: never jump ------------------------------------------
    morning_glide_minutes: float = 90.0
    """The morning colour release used to be a **step** from night to day Kelvin. Now a
    glide of this length. 0 restores the old snap, and is a setting rather than a
    constant so "never jump" stays the user's call, not the code's."""
    evening_axis_hour: float = 15.0
    """Where the evening ramp's axis starts. Any ramp point EARLIER than this is silently
    read as daytime and contributes nothing — so this must sit before the earliest ramp
    point you ever want, including midwinter. Was a hardcoded 18.0."""
    ramp_onset_minutes: float = 30.0
    """The evening ramp used to **step** onto its first point. Now it eases in over this
    long. 0 restores the step."""
    demand_floor_level: int = 1
    """The dimmest level demand may fall to while dark, rather than snapping off.

    **1, because 0 is off** (owner, 2026-08-13: *"really as low as 0, but 0 is off"*).
    This was 3 — "roughly 1 % of the scale" — which fought the rule that the cutoff drops
    out after dark precisely so low levels are reachable. Ambience does not raise a low
    demand up to itself; demand wins, down to here."""

    # -- Virtual sunrise wake-up fade ----------------------------------------------
    sunrise_fade_enabled: bool = True
    """Gradually brightens bedroom lights before alarm time to simulate natural sunrise."""
    sunrise_fade_minutes: float = 30.0
    """Duration of the pre-alarm sunrise brightening curve."""

    # -- Bedtime wind-down (bedroom auto-dwell) ------------------------------------
    bedtime_dwell_enabled: bool = True
    """Settle bedroom lights to a low warm glow before sleep when occupied late evening."""
    bedtime_dwell_hour: float = 22.5
    """Clock hour after which bedtime wind-down engages in bedroom."""
    bedtime_dwell_level: int = 15
    """Dimmest comfortable level for late evening wind-down before sleeping."""

    # -- Display only ---------------------------------------------------------------
    gamma: float = 2.39
    """Measured mean on Aqara CCT (per-point 2.23-2.47). **Display column only** — gamma
    correction is OUT of the command path (ha-lighting-system §2, it "didn't really seem
    to help"). Kept so the panel can show "level 102 → 18 % light"."""


@dataclass(frozen=True, slots=True)
class RemoteSettings:
    """A physical remote controller (e.g. Styrbar) mapped to room actions."""

    remote_id: str
    name: str = "Remote"
    room_id: str = ""
    action_entity: str = ""
    button_on: str = "toggle_auto_manual"
    button_off: str = "turn_off"
    button_up: str = "nudge_bias_up"
    button_down: str = "nudge_bias_down"
    button_left: str = "toggle_manual"
    button_right: str = "toggle_sleep"


@dataclass(frozen=True, slots=True)
class ZoneSettings:
    """A sub-zone inside an area — its own lights, its own bias, its own presence.

    ⚠️ **An area is four walls, not a use.** (Owner, 2026-08-13: *"Even though the office
    and sitting areas are different uses, they are the same 4 walls and only one sensor.
    In the kitchen we do have 2 sensors, but still same 4 walls."*)

    So Living is ONE area containing sitting and office zones, and Kitchen is ONE area
    containing sink, diner, centre and hallway. The earlier build made each of those a
    separate room, which meant a whole-room dial did not exist for the room anyone
    actually stands in.

    Presence works at two levels and they do different jobs:

    * **Area presence** (any sensor in the area) answers *is the room occupied* — either
      kitchen sensor lights the whole kitchen.
    * **Zone presence** answers *is this end of it occupied*. When a zone's own sensor
      reads clear its lights reduce by ``diminish_pct`` and STAY there. Never an off.
    """

    zone_id: str = ""
    name: str = "Zone"
    lights: tuple[str, ...] = ()
    bias_stops: float = 0.0
    """The layer between the area and the individual light."""
    diminish_pct: float = 0.0
    """0 ⇒ no effect. Only meaningful when the zone has its own presence sensor."""


@dataclass(frozen=True, slots=True)
class RoomSettings:
    """Per-AREA settings. One per config *subentry*.

    Named ``RoomSettings`` for continuity; an "area" here is a set of four walls, which
    may contain several zones.
    """

    name: str = "Room"
    bias_stops: float = 0.0
    zone_bias_stops: float = 0.0
    """The layer between room and light (Living: sitting / office)."""
    diminish_pct: float = 0.0
    """Step 10. Kitchen only. When the *near* sensor reads clear, reduce by this much
    and STAY there — never an off. 0 ⇒ no effect. Do not generalise to other rooms."""
    ambience_level: int = 0
    """Per-room ambience floor. **0 ⇒ take the house floor**, not "off" — the room
    control is an override, and the handoff's rule is that a control at zero is simply
    unmodified. Set the *house* floor to 0 to turn the feature off everywhere."""
    night_off: bool = False
    """**Asleep** ⇒ this room goes fully OFF, not to the night level.

    Owner, 2026-08-13: *"in the bedroom… when asleep bedroom goes all off. If awake in
    the night, it returns to the same state as the house (night mode during dark)."*
    Keyed on ``asleep``, NOT on ``night_active``: once he is up (DND clears) the bedroom
    rejoins the house at the night level rather than staying dark in the one room he is
    standing in. That is the same signal in both directions, with no extra helper — the
    phone already reports it."""
    manual_hold_minutes: float = 30.0
    """A touch holds manual for N minutes; the switch holds indefinitely."""
    sunrise_enabled: bool = False
    """Enable virtual sunrise wake-up fade in this room."""
    bedtime_dwell_enabled: bool = False
    """Enable bedtime auto-dwell wind-down in this room."""
    zones: tuple[ZoneSettings, ...] = ()
    """Sub-zones. Empty ⇒ the area is undivided and every light takes
    ``zone_bias_stops`` / ``diminish_pct`` from the area itself."""


@dataclass(frozen=True, slots=True)
class LightSettings:
    """Per-light settings."""

    entity_id: str = ""
    family: Family = Family.AQARA_RGB
    bias_stops: float = 0.0
    clamp_min: int = 0
    clamp_max: int = 254
    min_kelvin: int = 2000
    max_kelvin: int = 9009
    """Read from the live registry, not guessed — IKEA-family bulbs stop at 4000 K."""


@dataclass(frozen=True, slots=True)
class EngineInput:
    """Everything the engine reads from the world for one light, one tick."""

    lux: float
    """`sensor.entry_exterior_illuminance` — the one sensor in the house."""
    occupied: bool
    dnd: bool
    """DND on ⇒ asleep ⇒ NIGHT.

    A measured signal, not an inference: the owner's Pixel 8a in **priority-only** DND
    means he is asleep. One signal, three uses — night mode, the ambience gate, and the
    bedroom's night-off rule."""
    clock_hour: float
    night_active: bool = False
    """⚠️ **LATCHED, and NOT the same as ``asleep``.** This is the correction that
    matters most in the whole engine.

    Measured from 72 h of history: the Pixel's DND **clears the moment the owner gets out
    of bed** (measured: DND on late evening, *off first thing*, on again shortly after). So treating night
    mode as "DND is on right now" means the instant he stands up at 3 am the house leaves
    night mode, recomputes from a pitch-dark lux reading, and lights every occupied room
    at full demand — roughly level 206 of 254, straight into his face.

    Night therefore **starts** on sleep and **ends** on its own terms: outdoor lux above
    ``night_release_lux``, or ``alarm_lead_minutes`` before the next alarm. Getting up
    does not end it — which is exactly the behaviour he described: *"if I wake up and get
    out of bed… the lights come on to the low night setting and I can see."*"""
    asleep: bool = False
    """Is he asleep **right now** — DND on, or the sleep toggle held. Distinct from
    ``night_active``: asleep drives the bedroom fully dark and suppresses the ambience
    glow; night_active drives the level everywhere."""
    away: bool = False
    """Away mode armed — forces all room lighting off immediately."""
    sunrise_progress: float | None = None
    """0.0 to 1.0 progress through pre-alarm virtual sunrise fade."""
    bedtime_dwell_active: bool = False
    """Bedtime wind-down active in bedroom before sleep."""
    ambience_open: bool = True
    """The gate's *previous* state — it is hysteretic, so it is an input as well as an
    output. Used only when ``ambience_resolved`` is None."""
    ambience_resolved: bool | None = None
    """The gate's **final** state for this tick, already hysteretic *and* debounced.

    ⚠️ This field exists because omitting it silently disabled the time debounce. The
    coordinator owns the clock, so it is the only thing that can debounce; it did, stored
    the result, and then handed it to ``solve`` as ``ambience_open`` — where ``solve``
    re-ran ``ambience_threshold`` on it and produced the *un*-debounced answer again. The
    debounce moved ``binary_sensor.…_ambient_gate`` and nothing else: the lights still
    zeroed instantly, and the sensor and the bulbs visibly disagreed.

    None ⇒ compute the gate from ``lux`` and ``ambience_open`` (what the unit tests do, and
    what makes ``solve`` usable standalone)."""
    diminish_active: bool = False
    """The near sub-zone sensor reads clear (kitchen only)."""
    manual_level: int | None = None
    """Step 13. Not None ⇒ manual wins over everything computed."""
    current_level: int = 0
    """What the bulb is at now — the rate limiter's starting point."""
    last_written_level: int | None = None
    last_source: str | None = None
    """What drove this light's level on the PREVIOUS tick — see ``Solution.source``.

    The rate limiter needs it. Without it, ambience made every entry and exit look like
    demand tracking (the light is never off, and the target is never 0, so both of the
    limiter's exemptions became unreachable) and walking into a room crawled up at
    ``rate_limit_step`` per tick."""
    """What we last *commanded*. Feeds the dead zone; None ⇒ always write."""


@dataclass(frozen=True, slots=True)
class Solution:
    """The engine's answer for one light, plus the trace behind it.

    The trace is not debug decoration — the panel must "render the consequence beside
    the control" (brief, "Stops vs percent"), which means showing every intermediate.
    """

    level: int
    should_write: bool
    mode: Mode
    ambience_open: bool
    demand: float
    stops: float
    fraction: float
    source: str = "demand"
    """WHY the level is what it is: ``demand``, ``ambience``, ``night`` or ``off``."""
    trace: tuple[tuple[str, object], ...] = field(default=())

    def with_trace(self, step: str, value: object) -> Solution:
        return replace(self, trace=(*self.trace, (step, value)))
