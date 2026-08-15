"""House-wide colour curve — one value, clamped per bulb on the way out.

PURE MODULE — no ``homeassistant`` imports.

Settled decisions this implements (ha-lighting-system §2, do not re-litigate):

* **Colour is house-wide, one value.** Anchored to **civil dusk**, interpolated in
  **mireds**, plus a manual Kelvin trim.
* **Sun *elevation* was tried and failed** — it sits flat all afternoon then collapses
  in 90 minutes. Anchor to dusk and the clock instead.
* **Clamp per bulb, and surface the clamp.** A 5000 K request pins every IKEA-family
  bulb at 4000 K. The bulb reports success either way — silence here is how "colour
  doesn't work" happens. (How many that is, is read from the registry and shown in the
  panel; it is deliberately not written down here, because it changes.)
"""

from __future__ import annotations

from dataclasses import dataclass

from .models import DEFAULT_COLOUR_TIMELINE, HouseSettings, LightSettings
from .spline import MonotoneCubicSpline

__all__ = [
    "kelvin_to_mired",
    "mired_to_kelvin",
    "target_kelvin",
    "clamp_kelvin",
    "ColourTarget",
    "resolve_colour",
]


def kelvin_to_mired(kelvin: float) -> int:
    """Mired = 1_000_000 / Kelvin. Lower mired = cooler/bluer."""
    return int(round(1_000_000.0 / max(kelvin, 1.0)))


def mired_to_kelvin(mired: float) -> int:
    return int(round(1_000_000.0 / max(mired, 1.0)))


def target_kelvin(
    clock_hour: float,
    dusk_hour: float | HouseSettings = 21.5,
    house: HouseSettings | None = None,
) -> int:
    """House-wide colour target for this moment, before the per-bulb clamp.

    Evaluates the 24h interactive Spline curve (house.colour_timeline).
    """
    if isinstance(dusk_hour, HouseSettings):
        house = dusk_hour
        dusk_hour = 21.5
    if house is None:
        house = HouseSettings()

    timeline = house.colour_timeline or DEFAULT_COLOUR_TIMELINE
    colour_spline = MonotoneCubicSpline(timeline)
    time_kelvin = colour_spline.evaluate_periodic_24h(clock_hour)
    return int(round(max(2000.0, min(9000.0, time_kelvin + house.colour_trim_kelvin))))


def clamp_kelvin(kelvin: int, light: LightSettings) -> tuple[int, bool]:
    """Clamp a Kelvin target into this bulb's real range.

    Returns ``(kelvin, was_clamped)``. **The bool matters** — a clamp is not an error
    and produces no log line, so the only way it stops being invisible is if we carry it
    up to the panel.

    Broadcasting one Kelvin to mixed families is *safe* (measured: an IKEA pinned
    5000 K → 4000 K and kept working, both Aqara families took it exactly) — but the
    families then **visually diverge**, which is the thing worth showing.
    """
    clamped = max(light.min_kelvin, min(light.max_kelvin, kelvin))
    return clamped, clamped != kelvin


@dataclass(frozen=True, slots=True)
class ColourTarget:
    kelvin: int
    mired: int
    was_clamped: bool
    requested_kelvin: int


def resolve_colour(
    clock_hour: float,
    dusk_hour: float | HouseSettings = 21.5,
    house: HouseSettings | LightSettings | None = None,
    light: LightSettings | None = None,
) -> ColourTarget:
    """House curve → this bulb's achievable target, with the clamp made visible."""
    if isinstance(dusk_hour, HouseSettings):
        if isinstance(house, LightSettings):
            light = house
        house = dusk_hour
        dusk_hour = 21.5
    if light is None:
        light = LightSettings(min_kelvin=1000, max_kelvin=20000)
    if house is None:
        house = HouseSettings()

    requested = target_kelvin(clock_hour, dusk_hour, house)
    kelvin, was_clamped = clamp_kelvin(requested, light)
    return ColourTarget(
        kelvin=kelvin,
        mired=kelvin_to_mired(kelvin),
        was_clamped=was_clamped,
        requested_kelvin=requested,
    )
