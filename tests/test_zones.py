"""Areas, zones, and the merge that turns v1's fragments into them.

The rule this file protects: **an area is four walls, not a use.** Living's office and
sitting ends are one room with one sensor; the kitchen has two sensors and is still one
room. v1 made each of those a separate "room", so the dial for the room anyone actually
stands in did not exist.
"""

from __future__ import annotations

import pytest

from custom_components.solace.engine import solve
from custom_components.solace.models import (
    EngineInput,
    Family,
    HouseSettings,
    LightSettings,
    RoomSettings,
    ZoneSettings,
)


@pytest.fixture
def house() -> HouseSettings:
    return HouseSettings()


@pytest.fixture
def light() -> LightSettings:
    return LightSettings(entity_id="light.living_office_e", family=Family.AQARA_CCT)


def _input(**kwargs) -> EngineInput:
    base = {"lux": 10.0, "occupied": True, "dnd": False, "clock_hour": 14.0, "gate_open": False}
    base.update(kwargs)
    return EngineInput(**base)


def test_zone_bias_sits_between_the_area_and_the_light(house, light):
    """house → area → zone → light, all additive. A parent dial moves everything while
    the children keep their offsets."""
    area = RoomSettings(name="Living", bias_stops=-0.5)
    sitting = ZoneSettings(zone_id="sitting", name="Sitting", bias_stops=0.0)
    office = ZoneSettings(zone_id="office", name="Office", bias_stops=+1.0)

    lit = LightSettings(entity_id="light.x", bias_stops=0.25)
    a = solve(house, area, lit, _input(), zone=sitting)
    b = solve(house, area, lit, _input(), zone=office)

    # One stop is a doubling, so the office ends up twice the sitting level (modulo the
    # 0-254 rounding and the clip at full).
    assert a.stops == pytest.approx(-0.25)
    assert b.stops == pytest.approx(0.75)
    assert b.level > a.level


def test_an_undivided_area_still_uses_its_own_zone_bias(house, light):
    """No zones ⇒ the area's own `zone_bias_stops` applies, exactly as in v1. This is
    what makes the v1→v2 migration behaviour-preserving."""
    area = RoomSettings(name="Entry", zone_bias_stops=-1.0)
    with_zone = solve(house, area, light, _input(), zone=None)
    assert with_zone.stops == pytest.approx(-1.0)


def test_diminish_is_per_zone_not_per_area(house, light):
    """The end of the room nobody is standing in dims; the rest of it does not."""
    area = RoomSettings(name="Kitchen")
    sink = ZoneSettings(zone_id="sink", name="Sink", diminish_pct=50.0)
    diner = ZoneSettings(zone_id="diner", name="Diner", diminish_pct=50.0)

    # The sink end has gone quiet; the diner end has not.
    quiet = solve(house, area, light, _input(diminish_active=True), zone=sink)
    busy = solve(house, area, light, _input(diminish_active=False), zone=diner)

    assert busy.level == 161
    assert 78 <= quiet.level <= 81
    assert quiet.level < busy.level


def test_a_zone_with_no_diminish_is_unaffected(house, light):
    area = RoomSettings(name="Kitchen")
    hallway = ZoneSettings(zone_id="hallway", name="Hallway", diminish_pct=0.0)
    result = solve(house, area, light, _input(diminish_active=True), zone=hallway)
    assert result.level == 161


def test_merging_preserves_every_computed_level(house, light):
    """The merge pushes each old AREA bias down into its new ZONE bias. That is what
    makes folding three subentries into one a no-op for the bulbs — otherwise the merge
    would silently re-light the house."""
    # v1: three separate areas, each with its own bias.
    before = {
        name: solve(house, RoomSettings(name=name, bias_stops=bias), light, _input()).level
        for name, bias in (("Office", 0.5), ("Sitting", 0.0), ("Ceiling", -1.0))
    }
    # v2: one area at 0, each old area now a zone carrying its bias.
    merged = RoomSettings(name="Living", bias_stops=0.0)
    after = {
        name: solve(
            house, merged, light, _input(),
            zone=ZoneSettings(zone_id=name.lower(), name=name, bias_stops=bias),
        ).level
        for name, bias in (("Office", 0.5), ("Sitting", 0.0), ("Ceiling", -1.0))
    }
    assert before == after
