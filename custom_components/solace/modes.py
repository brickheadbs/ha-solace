"""Special Modes: Work, Gaming and Movie for the Bedroom office. **Pure** — no HA imports.

A special mode is a *profile* laid over the normal demand calculation, never a separate
writer. Each mode says, per office light, either a fixed level or "follow Solace"
(``FOLLOW``), plus a colour temperature for the fixed lights (``0`` = follow the house
curve) and a bias in stops for the followed lights.

Only one mode is live at a time. Precedence is Movie > Gaming > Work: the more
deliberate, shorter-lived activity wins if two helpers are somehow on together.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: Level sentinel meaning "this light follows the normal Solace demand".
FOLLOW = -1

#: Precedence order, highest first.
SPECIAL_MODES: tuple[str, ...] = ("movie", "gaming", "work")

MODE_HELPERS: dict[str, str] = {
    "work": "input_boolean.work_mode",
    "gaming": "input_boolean.gaming_mode",
    "movie": "input_boolean.movie_mode",
}

MODE_LABELS: dict[str, str] = {"work": "Work", "gaming": "Gaming", "movie": "Movie"}

DESK_LEFT = "light.bedroom_desk_left"
DESK_RIGHT = "light.bedroom_desk_right"
COUNTER = "light.bedroom_counter"
WARDROBE = "light.bedroom_wardrobe"
GLASS = "light.bedroom_glass_lamp"

MODE_LIGHTS: frozenset[str] = frozenset({DESK_LEFT, DESK_RIGHT, COUNTER, WARDROBE, GLASS})

#: -0.30 EV corner-reflection compensation for the right desk light, measured during the
#: 2026-11 D65 calibration (78 on the right reads the same as 86 on the left).
DESK_RIGHT_RATIO = 78.0 / 86.0

#: Signals from the Mac watcher (see homelab packages/special_modes.yaml).
DISPLAYS_ASLEEP_ENTITY = "binary_sensor.mac_displays_asleep"
WATCHER_ALIVE_ENTITY = "binary_sensor.mac_watcher_alive"
GUEST_MODE_ENTITY = "input_boolean.living_guest_mode"


@dataclass(frozen=True, slots=True)
class ModeProfile:
    """One mode's settings, read from HouseSettings."""

    mode: str
    desk: int
    counter: int
    wardrobe: int
    glass: int
    kelvin: int
    bias_stops: float
    debounce_minutes: float

    def fixed_level(self, entity_id: str) -> int | None:
        """The fixed level for a light, or None when the light follows Solace."""
        if entity_id == DESK_LEFT:
            raw = self.desk
        elif entity_id == DESK_RIGHT:
            raw = self.desk if self.desk <= 0 else round(float(self.desk) * DESK_RIGHT_RATIO)
        elif entity_id == COUNTER:
            raw = self.counter
        elif entity_id == WARDROBE:
            raw = self.wardrobe
        elif entity_id == GLASS:
            raw = self.glass
        else:
            return None
        raw = int(raw)
        if raw <= FOLLOW:
            return None
        return max(0, min(254, raw))

    @property
    def fixed_kelvin(self) -> int | None:
        """Kelvin for the fixed lights, or None to follow the house colour curve."""
        k = int(self.kelvin)
        return k if k > 0 else None


def profile_for(house: Any, mode: str) -> ModeProfile:
    """Build the profile for ``mode`` from a HouseSettings instance."""

    def g(key: str, default: float) -> float:
        return float(getattr(house, f"{mode}_mode_{key}", default))

    return ModeProfile(
        mode=mode,
        desk=int(g("desk_level", FOLLOW)),
        counter=int(g("backlight_level", FOLLOW)),
        wardrobe=int(g("corner_level", FOLLOW)),
        glass=int(g("glass_level", FOLLOW)),
        kelvin=int(g("kelvin", 0)),
        bias_stops=g("bias_stops", 0.0),
        debounce_minutes=g("debounce_minutes", 5.0),
    )


def active_mode(helper_states: dict[str, bool]) -> str | None:
    """The live mode by precedence, given ``{mode: helper_is_on}``."""
    for mode in SPECIAL_MODES:
        if helper_states.get(mode):
            return mode
    return None


def mode_hold(
    *,
    occupied: bool,
    seconds_since_presence: float,
    debounce_minutes: float,
    displays_asleep: bool,
    occupied_elsewhere: bool,
    guest_mode: bool,
) -> bool:
    """Whether the mode's profile should drive the lights right now.

    * Displays asleep: no work is being done, so the profile pauses (lights fall back to
      normal Solace) and resumes when the displays wake.
    * Bedroom empty and someone seen in another room: you have left, so the debounce is
      skipped. Ignored while Guest Mode is on, because that someone may be the guest.
    * Otherwise the profile holds while occupied and for ``debounce_minutes`` after.
    """
    if displays_asleep:
        return False
    if occupied:
        return True
    if occupied_elsewhere and not guest_mode:
        return False
    return seconds_since_presence < debounce_minutes * 60.0


def sunny_override_state(lux: float, threshold: float, release_pct: float, latched: bool) -> bool:
    """Sunny override with hysteresis. Kept here because it is pure and tiny.

    On at ``lux >= threshold``; once on, stays on until ``lux < threshold * (1 - pct)``.
    """
    if threshold <= 0:
        return False
    if lux >= threshold:
        return True
    if latched and lux >= threshold * (1.0 - max(0.0, release_pct) / 100.0):
        return True
    return False
