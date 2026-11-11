"""Enforces parity between `custom_components/solace/const.py` and `panel/src/rules-spec.ts`.

If a house or room setting is added, renamed, or retired in Python without updating the
canonical agent/UI rules spec (`rules-spec.ts`), this test fails immediately.
"""

from __future__ import annotations

from pathlib import Path
import re

from custom_components.solace.const import HOUSE_SETTINGS, ROOM_SETTINGS

SPEC_PATH = Path(__file__).resolve().parents[1] / "panel" / "src" / "rules-spec.ts"


def _extract_string_array(text: str, export_name: str) -> set[str]:
    pattern = rf"export const {export_name}\s*:\s*readonly string\[\]\s*=\s*\[(.*?)\]\s*as const;"
    match = re.search(pattern, text, flags=re.DOTALL)
    assert match, f"Missing {export_name} in {SPEC_PATH}"
    return set(re.findall(r'"([^"]+)"', match.group(1)))


def test_rules_spec_has_required_agent_reading_markers() -> None:
    text = SPEC_PATH.read_text(encoding="utf-8")
    assert "// === BEGIN REQUIRED AGENT READING: SOLACE & HA WIRING SPEC ===" in text
    assert "// === END REQUIRED AGENT READING ===" in text


def test_rules_spec_tracks_every_house_and_room_setting() -> None:
    text = SPEC_PATH.read_text(encoding="utf-8")
    spec_house = _extract_string_array(text, "TRACKED_HOUSE_KEYS")
    spec_room = _extract_string_array(text, "TRACKED_ROOM_KEYS")

    actual_house = {s.key for s in HOUSE_SETTINGS}
    actual_room = {s.key for s in ROOM_SETTINGS}

    assert spec_house == actual_house, (
        f"rules-spec.ts TRACKED_HOUSE_KEYS drift! "
        f"Missing in spec: {sorted(actual_house - spec_house)}, "
        f"Stale in spec: {sorted(spec_house - actual_house)}"
    )
    assert spec_room == actual_room, (
        f"rules-spec.ts TRACKED_ROOM_KEYS drift! "
        f"Missing in spec: {sorted(actual_room - spec_room)}, "
        f"Stale in spec: {sorted(spec_room - actual_room)}"
    )
