"""Special Modes (Work / Gaming / Movie) — the pure profile and hold logic."""

from __future__ import annotations

from custom_components.solace.const import HOUSE_DEFAULTS
from custom_components.solace.models import HouseSettings
from custom_components.solace.modes import (
    COUNTER,
    DESK_LEFT,
    DESK_RIGHT,
    GLASS,
    WARDROBE,
    active_mode,
    mode_hold,
    profile_for,
    sunny_override_state,
)


def test_work_defaults_are_the_d65_calibration():
    """Reset-to-default must land on the 2026-11 calibration, in both tables."""
    assert HOUSE_DEFAULTS["work_mode_desk_level"] == 86
    assert HOUSE_DEFAULTS["work_mode_backlight_level"] == 135
    assert HOUSE_DEFAULTS["work_mode_corner_level"] == 105
    assert HOUSE_DEFAULTS["work_mode_glass_level"] == 0
    assert HOUSE_DEFAULTS["work_mode_kelvin"] == 6500
    work = profile_for(HouseSettings(), "work")
    assert work.fixed_level(DESK_LEFT) == 86
    assert work.fixed_level(DESK_RIGHT) == 78  # -0.30 EV corner compensation
    assert work.fixed_level(COUNTER) == 135
    assert work.fixed_level(WARDROBE) == 105
    assert work.fixed_level(GLASS) == 0
    assert work.fixed_kelvin == 6500


def test_movie_defaults_follow_solace_dimmed_with_desk_off():
    movie = profile_for(HouseSettings(), "movie")
    assert movie.fixed_level(DESK_LEFT) == 0
    assert movie.fixed_level(DESK_RIGHT) == 0
    assert movie.fixed_level(COUNTER) is None
    assert movie.fixed_level(GLASS) is None
    assert movie.fixed_kelvin is None
    assert movie.bias_stops == -2


def test_unknown_light_is_never_driven():
    assert profile_for(HouseSettings(), "work").fixed_level("light.kitchen") is None


def test_precedence_is_movie_then_gaming_then_work():
    assert active_mode({"work": True, "gaming": True}) == "gaming"
    assert active_mode({"work": True, "movie": True, "gaming": True}) == "movie"
    assert active_mode({"work": True}) == "work"
    assert active_mode({}) is None


def _hold(**kw):
    base = dict(
        occupied=False,
        seconds_since_presence=60.0,
        debounce_minutes=5.0,
        displays_asleep=False,
        occupied_elsewhere=False,
        guest_mode=False,
    )
    base.update(kw)
    return mode_hold(**base)


def test_hold_while_occupied_and_through_the_debounce():
    assert _hold(occupied=True)
    assert _hold(seconds_since_presence=60.0)
    assert not _hold(seconds_since_presence=301.0)


def test_displays_asleep_pauses_even_when_occupied():
    assert not _hold(occupied=True, displays_asleep=True)


def test_seen_elsewhere_skips_the_debounce():
    assert not _hold(occupied_elsewhere=True)


def test_guest_mode_does_not_trust_presence_elsewhere():
    """Someone in another room may be the guest, so keep the debounce."""
    assert _hold(occupied_elsewhere=True, guest_mode=True)


def test_sunny_override_does_not_flap_on_passing_cloud():
    """2026-11-13 10:37/10:42: lux 3,895 -> 4,549 -> 4,457 flipped the bedroom off and on."""
    latched = sunny_override_state(4549, 4500, 15, False)
    assert latched
    assert sunny_override_state(4457, 4500, 15, latched)
    assert sunny_override_state(3895, 4500, 15, latched)
    assert not sunny_override_state(3800, 4500, 15, latched)
    assert not sunny_override_state(4457, 4500, 15, False)
    assert not sunny_override_state(9000, 0, 15, False)
