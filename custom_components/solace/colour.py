"""House-wide colour curve — one value, clamped per bulb on the way out.

PURE MODULE — no ``homeassistant`` imports.

Settled decisions this implements (ha-lighting-system §2, do not re-litigate):

* **Colour is house-wide, one value.** Anchored to **civil dusk**, interpolated in
  **mireds**, plus a manual Kelvin trim.
* **Sun *elevation* was tried and failed** — it sits flat all afternoon then collapses
  in 90 minutes. Anchor to dusk and the clock instead.
* **Clamp per bulb, and surface the clamp.** A 5000 K request pins five bulbs at
  4000 K (the three entry lights, the living ceiling, and ``living_sitting_ne``). The
  bulb reports success either way — silence here is how "colour doesn't work" happens.
"""

from __future__ import annotations

from dataclasses import dataclass

from .models import HouseSettings, LightSettings

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


def target_kelvin(clock_hour: float, dusk_hour: float, house: HouseSettings) -> int:
    """House-wide colour target for this moment, before the per-bulb clamp.

    The glide starts at civil dusk and runs for ``colour_glide_minutes``, interpolating
    **linearly in mireds** (not Kelvin — equal mired steps are roughly equal perceptual
    steps, which is also the unit the wire protocol uses). It then holds the night
    value until the morning release.

    All arithmetic is on ``(clock - dusk) % 24`` so the curve is continuous across
    midnight, where a decimal-clock comparison would break.
    """
    elapsed = (clock_hour - dusk_hour) % 24.0
    release_at = (house.morning_release_hour - dusk_hour) % 24.0
    glide_hours = max(house.colour_glide_minutes, 0.0) / 60.0

    day_mired = kelvin_to_mired(house.day_kelvin)
    night_mired = kelvin_to_mired(house.night_kelvin)

    if elapsed >= release_at:
        kelvin = house.day_kelvin
    elif glide_hours <= 0 or elapsed >= glide_hours:
        kelvin = house.night_kelvin
    else:
        t = elapsed / glide_hours
        kelvin = mired_to_kelvin(day_mired + t * (night_mired - day_mired))

    return kelvin + house.colour_trim_kelvin


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
    dusk_hour: float,
    house: HouseSettings,
    light: LightSettings,
) -> ColourTarget:
    """House curve → this bulb's achievable target, with the clamp made visible."""
    requested = target_kelvin(clock_hour, dusk_hour, house)
    kelvin, was_clamped = clamp_kelvin(requested, light)
    return ColourTarget(
        kelvin=kelvin,
        mired=kelvin_to_mired(kelvin),
        was_clamped=was_clamped,
        requested_kelvin=requested,
    )
