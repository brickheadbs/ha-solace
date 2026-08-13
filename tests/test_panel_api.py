"""The panel's WebSocket contract.

A panel is the one part of an integration that fails *silently* — a snapshot that
raises, or one that grows a key the frontend does not expect, renders as a blank page
with nothing in the log the user would think to look at. So the snapshot is tested like
an API, because that is what it is.
"""

from __future__ import annotations

import pytest
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

from custom_components.solace.const import CONF_PER_LIGHT, HOUSE_SETTINGS, ROOM_SETTINGS

from .conftest import LIGHT

pytestmark = pytest.mark.usefixtures("world")


async def _setup(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


_next_id = 0


def _id() -> int:
    """HA's WebSocket API requires strictly increasing ids per connection."""
    global _next_id
    _next_id += 1
    return _next_id


async def _get(client) -> dict:
    await client.send_json({"id": _id(), "type": "solace/get"})
    msg = await client.receive_json()
    assert msg["success"], msg
    return msg["result"]


async def test_snapshot_carries_everything_the_panel_renders(
    hass: HomeAssistant, entry, hass_ws_client: WebSocketGenerator
) -> None:
    await _setup(hass, entry)
    snap = await _get(await hass_ws_client(hass))

    # Every tunable must reach the panel — a setting the panel cannot see is a setting
    # that cannot be changed, which the brief calls a bug.
    for setting in HOUSE_SETTINGS:
        assert setting.key in snap["house"], setting.key
    assert {s["key"] for s in snap["house_schema"]} == {s.key for s in HOUSE_SETTINGS}
    assert {s["key"] for s in snap["room_schema"]} == {s.key for s in ROOM_SETTINGS}

    room = snap["rooms"][0]
    assert room["name"] == "Kitchen"
    assert room["lights"][0]["entity_id"] == LIGHT
    # The trace is what lets the panel show the consequence beside the control.
    assert room["lights"][0]["trace"]["demand"] > 0
    assert room["level"] == 161

    world = snap["world"]
    assert world["latitude"] == hass.config.latitude
    assert world["healthy"] is True
    # The evening ramp reaches the panel as a list — it is editable, not two fixed phases.
    assert len(snap["ramp"]) == 2


async def test_the_snapshot_is_json_serialisable(
    hass: HomeAssistant, entry, hass_ws_client: WebSocketGenerator
) -> None:
    """A stray dataclass or Enum in the payload kills the whole page, not one field."""
    import json

    await _setup(hass, entry)
    json.dumps(await _get(await hass_ws_client(hass)))


async def test_setting_a_house_value_lands_in_the_config_entry(
    hass: HomeAssistant, entry, hass_ws_client: WebSocketGenerator
) -> None:
    await _setup(hass, entry)
    client = await hass_ws_client(hass)
    await client.send_json(
        {"id": _id(), "type": "solace/set_house", "values": {"bias_stops": -1.25}}
    )
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    assert entry.options["bias_stops"] == -1.25
    assert entry.runtime_data.coordinator.house.bias_stops == -1.25


async def test_an_unknown_house_key_is_refused(
    hass: HomeAssistant, entry, hass_ws_client: WebSocketGenerator
) -> None:
    """A stray key would land in the options dict, and `HouseSettings(**options)` is a
    TypeError at the next tick — i.e. the whole engine stops over a typo."""
    await _setup(hass, entry)
    client = await hass_ws_client(hass)
    await client.send_json({"id": _id(), "type": "solace/set_house", "values": {"nonsense": 1}})
    msg = await client.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "unknown_key"


async def test_the_ramp_is_editable_and_stays_ordered(
    hass: HomeAssistant, entry, hass_ws_client: WebSocketGenerator
) -> None:
    """The brief's ordered-list ramp was unreachable before the panel: nothing wrote
    CONF_RAMP, so two points were effectively hardcoded."""
    await _setup(hass, entry)
    client = await hass_ws_client(hass)
    await client.send_json(
        {
            "id": _id(),
            "type": "solace/set_ramp",
            # Deliberately out of order and with a third point.
            "ramp": [
                {"hour": 23.0, "stops": -2.0},
                {"hour": 20.0, "stops": -0.5},
                {"hour": 21.5, "stops": -1.0},
            ],
        }
    )
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()

    ramp = entry.runtime_data.coordinator.house.ramp
    assert [p.hour for p in ramp] == [20.0, 21.5, 23.0]
    assert len(ramp) == 3


async def test_per_light_clamps_round_trip_and_clear_to_unset(
    hass: HomeAssistant, entry, hass_ws_client: WebSocketGenerator
) -> None:
    """`null` means unset, which is genuinely different from a stored 0 — an unset min is
    no floor, and a set 0 is also no floor, but only one of them should read as
    configured in the UI."""
    await _setup(hass, entry)
    client = await hass_ws_client(hass)
    subentry_id = next(iter(entry.subentries))

    await client.send_json(
        {
            "id": _id(),
            "type": "solace/set_light",
            "subentry_id": subentry_id,
            "entity_id": LIGHT,
            "values": {"clamp_max": 10, "bias_stops": 0.5},
        }
    )
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    stored = entry.subentries[subentry_id].data[CONF_PER_LIGHT][LIGHT]
    assert stored["clamp_max"] == 10
    assert stored["bias_stops"] == 0.5

    await client.send_json(
        {
            "id": _id(),
            "type": "solace/set_light",
            "subentry_id": subentry_id,
            "entity_id": LIGHT,
            "values": {"clamp_max": None},
        }
    )
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    stored = entry.subentries[subentry_id].data[CONF_PER_LIGHT][LIGHT]
    assert "clamp_max" not in stored
    snap = await _get(client)
    assert snap["rooms"][0]["lights"][0]["clamp_max"] is None


async def test_manual_and_resume_round_trip(
    hass: HomeAssistant, entry, hass_ws_client: WebSocketGenerator
) -> None:
    await _setup(hass, entry)
    client = await hass_ws_client(hass)
    subentry_id = next(iter(entry.subentries))

    await client.send_json(
        {"id": _id(), "type": "solace/room_action", "subentry_id": subentry_id, "action": "manual"}
    )
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    assert (await _get(client))["rooms"][0]["manual"]["switch"] is True

    await client.send_json(
        {"id": _id(), "type": "solace/room_action", "subentry_id": subentry_id, "action": "auto"}
    )
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    manual = (await _get(client))["rooms"][0]["manual"]
    # "Resume now" clears the touch timer too, or a stale touch keeps holding the room
    # and the button looks like it did nothing.
    assert manual["switch"] is False and manual["touched"] is False


async def test_subscribe_pushes_a_snapshot(
    hass: HomeAssistant, entry, hass_ws_client: WebSocketGenerator
) -> None:
    await _setup(hass, entry)
    client = await hass_ws_client(hass)
    await client.send_json({"id": _id(), "type": "solace/subscribe"})
    assert (await client.receive_json())["success"]
    pushed = await client.receive_json()
    assert pushed["type"] == "event"
    assert pushed["event"]["rooms"][0]["name"] == "Kitchen"


async def test_a_room_ambience_override_reaches_the_engine(
    hass: HomeAssistant, entry, hass_ws_client: WebSocketGenerator
) -> None:
    """0 means "follow the house", not "off in this room" — the handoff's rule that a
    control at zero is simply unmodified."""
    await _setup(hass, entry)
    client = await hass_ws_client(hass)
    subentry_id = next(iter(entry.subentries))

    await client.send_json(
        {
            "id": _id(),
            "type": "solace/set_room",
            "subentry_id": subentry_id,
            "values": {"ambience_level": 40},
        }
    )
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    subentry = entry.subentries[subentry_id]
    settings = entry.runtime_data.coordinator.room_settings(subentry)
    assert settings.ambience_level == 40
