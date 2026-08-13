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

COUNTS = {
    "lux_history_samples",
    "colour_step_mired",
    "colour_step_mired_smooth",
    "colour_catch_up_steps",
    "dead_zone",
}
"""Small integer counts. A step of 1 is already the finest meaningful resolution — a
mired is not subdividable on the wire, and "catch up by 2.5 steps" is not a thing."""


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


def test_no_bulb_counts_are_written_down_anywhere():
    """A count of bulbs is a hardcoded fact about one house at one moment.

    Every family count in this codebase was written as prose — "five bulbs stop at
    4000 K", a table reading 5/6/12 — and on 2026-08-13 a live registry probe made all
    of them wrong. The counts are *derived* from the registry precisely so they cannot
    rot; writing one into a comment quietly reintroduces the thing the derivation exists
    to prevent, and the next agent believes the comment.
    """
    root = pathlib.Path(__file__).resolve().parents[1] / "custom_components" / "solace"
    # Two or more only. "one bulb, one writer" and "lux sensor → one bulb" are idioms
    # about the singular case, not claims about how many are installed.
    counting = re.compile(
        r"\b(two|three|four|five|six|seven|eight|nine|ten|\d+)\s+bulbs\b",
        re.IGNORECASE,
    )
    offenders = []
    for path in sorted(root.rglob("*.py")):
        for number, line in enumerate(path.read_text().splitlines(), 1):
            match = counting.search(line)
            # "a 4-bulb RGB combo" describes a measurement that was run, not a claim
            # about what is installed today.
            if match and "combo" not in line:
                offenders.append(f"{path.name}:{number}: {line.strip()}")
    assert not offenders, "bulb counts written down instead of derived:\n" + "\n".join(offenders)
