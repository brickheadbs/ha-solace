"""Standing guards on the settings table itself.

Two house rules are enforced here rather than left to review, because both are the kind
of thing that decays one row at a time:

1. **Nothing is hardcoded.** A value that cannot be changed from the UI is a bug.
2. **Never jump, and never be coarse.** Anything a person feels the length of gets fine
   enough resolution to land where they meant.
"""

from __future__ import annotations

import pathlib
import re

import pytest

from custom_components.solace.const import HOUSE_SETTINGS, ROOM_SETTINGS
from custom_components.solace.models import HouseSettings, RoomSettings

BOOLEANS = {"ambience_ignores_occupancy"}
"""Rendered as switches. Two states is the whole point, not coarseness."""

COUNTS = {"lux_history_samples", "colour_step_mired", "dead_zone"}
"""Small integer counts. A step of 1 is already the finest meaningful resolution."""


@pytest.mark.parametrize("setting", HOUSE_SETTINGS, ids=lambda s: s.key)
def test_every_house_setting_exists_on_the_model(setting):
    assert setting.key in HouseSettings.__slots__, (
        f"{setting.key} is offered in the UI but the engine cannot read it"
    )


@pytest.mark.parametrize("setting", ROOM_SETTINGS, ids=lambda s: s.key)
def test_every_room_setting_exists_on_the_model(setting):
    assert setting.key in RoomSettings.__slots__


def test_every_model_field_is_reachable_from_the_ui():
    """The other direction, and the one that actually rots: a field added to the engine
    with no row in the settings table is a hardcoded value wearing a default."""
    # `ramp` and `zones` are lists, not scalars — each has its own purpose-built editor
    # in the panel rather than a numeric row. `name` is the subentry title.
    exempt = {"ramp", "zones", "name"}
    house_keys = {s.key for s in HOUSE_SETTINGS}
    room_keys = {s.key for s in ROOM_SETTINGS}
    missing_house = set(HouseSettings.__slots__) - house_keys - exempt
    missing_room = set(RoomSettings.__slots__) - room_keys - exempt - {"night_off"}
    assert not missing_house, f"engine settings with no UI control: {sorted(missing_house)}"
    assert not missing_room, f"room settings with no UI control: {sorted(missing_room)}"


@pytest.mark.parametrize("setting", (*HOUSE_SETTINGS, *ROOM_SETTINGS), ids=lambda s: s.key)
def test_no_setting_is_coarse(setting):
    """A control the user drags needs somewhere to land."""
    if setting.key in BOOLEANS or setting.key in COUNTS:
        return
    steps = (setting.maximum - setting.minimum) / setting.step
    assert steps >= 40, f"{setting.key} offers only {steps:.0f} positions"


FELT_DURATIONS = {
    "transition_on_s",
    "transition_off_s",
    "transition_mode_s",
    "transition_setting_s",
    "colour_step_transition_s",
    "refresh_debounce_s",
}
"""Durations the user *watches happen*. These are the "never jump" controls, and a whole
second is a visibly different fade — they resolve to a tenth.

Everything else measured in seconds is *scheduling* (how often to poll, how long to wait
before believing a sensor). Nobody perceives the length of those, so one second is
already finer than anyone can want."""


@pytest.mark.parametrize("setting", (*HOUSE_SETTINGS, *ROOM_SETTINGS), ids=lambda s: s.key)
def test_time_values_are_fine_grained(setting):
    if setting.key in FELT_DURATIONS:
        assert setting.step <= 0.1, (
            f"{setting.key} is a fade the user watches and steps in {setting.step} s"
        )
    elif setting.unit == "s":
        assert setting.step <= 1, f"{setting.key} steps in {setting.step} s"
    if setting.unit == "min":
        assert setting.step <= 1, f"{setting.key} steps in {setting.step} min"


def test_no_bare_numeric_literals_left_in_the_engine_path():
    """The no-hardcode rule, as a grep that fails the build.

    Not a general lint — a targeted list of the specific literals that were found in
    breach on 2026-08-13, so they cannot quietly come back.
    """
    banned = {
        "custom_components/solace/coordinator.py": [
            r"cooldown=0\.3", r"return 21\.5", r"\[-5:\]",
            r"min_kelvin = 2000", r"max_kelvin = 9009",
        ],
        "custom_components/solace/writer.py": [
            r"<= 4200", r"<= 7000",
        ],
    }
    root = pathlib.Path(__file__).resolve().parents[1]
    for rel, patterns in banned.items():
        text = (root / rel).read_text()
        for pattern in patterns:
            assert not re.search(pattern, text), (
                f"{rel}: `{pattern}` is hardcoded again — it belongs in const.py"
            )
