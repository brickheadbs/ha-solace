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
    "Mode",
    "RampPoint",
    "HouseSettings",
    "RoomSettings",
    "LightSettings",
    "EngineInput",
    "Solution",
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
    """DND is the definition of "asleep" — one signal, three uses (brief, decided 2026-08-11)."""

    NORMAL = "normal"
    NIGHT = "night"


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
    gate_start_lux: float = 50.0
    """Falling edge — at or below this, lights MAY run."""
    gate_stop_lux: float = 80.0
    """Rising edge — at or above this, lights stop. Must be > gate_start_lux."""
    gate_debounce_falling_s: float = 0.0
    gate_debounce_rising_s: float = 0.0
    """⚠️ THE DEBOUNCE RULE: default 0, and 0 must mean *no* debounce. Three layers
    already debounce before HA sees anything (Sonoff 15 s in hardware, z2m
    no_occupancy_since, then us). Never raise these without Brandon's explicit
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
    ambience_level: int = 0
    """Step 9. A low-light *floor* while awake and the gate reads dark. 0 ⇒ feature off."""
    ambience_ignores_occupancy: bool = True
    """RESOLVED by Brandon 2026-08-13: *"Ambience is correctly stated as on with
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
    colour_step_transition_s: float = 4.0
    """See fade.py — R is computed from the TRANSITION time, never the step interval."""

    # -- Display only ---------------------------------------------------------------
    gamma: float = 2.39
    """Measured mean on Aqara CCT (per-point 2.23-2.47). **Display column only** — gamma
    correction is OUT of the command path (ha-lighting-system §2, it "didn't really seem
    to help"). Kept so the panel can show "level 102 → 18 % light"."""


@dataclass(frozen=True, slots=True)
class RoomSettings:
    """Per-room settings. One per config *subentry*."""

    name: str = "Room"
    bias_stops: float = 0.0
    zone_bias_stops: float = 0.0
    """The layer between room and light (Living: sitting / office)."""
    diminish_pct: float = 0.0
    """Step 10. Kitchen only. When the *near* sensor reads clear, reduce by this much
    and STAY there — never an off. 0 ⇒ no effect. Do not generalise to other rooms."""
    night_off: bool = False
    """Asleep ⇒ this room goes fully OFF, not to the night level.

    Brandon, 2026-08-13: *"in the bedroom… when asleep bedroom goes all off. If awake in
    the night, it returns to the same state as the house (night mode during dark)."*
    So this is the bedroom's rule, and it is overridden by ``awake_override`` — being
    awake at 3 am puts the room back on the house's night level rather than leaving the
    one room he is standing in dark."""
    manual_hold_minutes: float = 30.0
    """A touch holds manual for N minutes; the switch holds indefinitely."""


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
    """Read from the live registry, not guessed — five bulbs stop at 4000 K."""


@dataclass(frozen=True, slots=True)
class EngineInput:
    """Everything the engine reads from the world for one light, one tick."""

    lux: float
    """`sensor.entry_exterior_illuminance` — the one sensor in the house."""
    occupied: bool
    dnd: bool
    """DND on ⇒ asleep ⇒ NIGHT.

    A measured signal, not an inference: Brandon's Pixel 8a in **priority-only** DND
    means he is asleep. One signal, three uses — night mode, the ambience gate, and the
    bedroom's night-off rule."""
    clock_hour: float
    awake_override: bool = False
    """Up in the night. Cancels ``night_off`` so the bedroom rejoins the house's night
    mode rather than staying dark while he is standing in it."""
    gate_open: bool = True
    """The gate's *previous* state — it is hysteretic, so it is an input as well as an
    output."""
    diminish_active: bool = False
    """The near sub-zone sensor reads clear (kitchen only)."""
    manual_level: int | None = None
    """Step 13. Not None ⇒ manual wins over everything computed."""
    current_level: int = 0
    """What the bulb is at now — the rate limiter's starting point."""
    last_written_level: int | None = None
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
    gate_open: bool
    demand: float
    stops: float
    fraction: float
    trace: tuple[tuple[str, object], ...] = field(default=())

    def with_trace(self, step: str, value: object) -> Solution:
        return replace(self, trace=(*self.trace, (step, value)))
