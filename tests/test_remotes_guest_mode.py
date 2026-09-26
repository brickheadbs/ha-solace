"""Tests for RemoteDispatcher event handling, turn_on action, and Living Room Guest Mode."""

from __future__ import annotations

import pytest
from homeassistant.config_entries import ConfigSubentryData
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

from custom_components.solace.const import (
    CONF_DND_ENTITY,
    CONF_LIGHTS,
    CONF_LUX_SENSOR,
    CONF_REMOTES,
    DOMAIN,
    SUBENTRY_TYPE_ROOM,
)

from .conftest import DND, LIGHT, LUX

pytestmark = pytest.mark.usefixtures("world")


@pytest.fixture
def multi_room_entry(hass: HomeAssistant) -> MockConfigEntry:
    """A config entry with Kitchen and Living rooms."""
    config_entry = MockConfigEntry(
        domain=DOMAIN,
        title="Solace",
        unique_id=DOMAIN,
        data={CONF_LUX_SENSOR: LUX, CONF_DND_ENTITY: DND},
        options={
            CONF_LUX_SENSOR: LUX,
            CONF_DND_ENTITY: DND,
            CONF_REMOTES: [
                {
                    "remote_id": "living_office_control",
                    "name": "Living Office Control",
                    "room_name": "Living",
                    "action_entity": "event.living_office_control_action",
                    "button_up": "nudge_bias_up",
                    "button_down": "nudge_bias_down",
                    "hold_up": "turn_on",
                    "hold_down": "turn_off",
                    "button_left": "toggle_manual",
                    "button_right": "toggle_sleep",
                }
            ],
        },
        subentries_data=[
            ConfigSubentryData(
                subentry_type=SUBENTRY_TYPE_ROOM,
                title="Kitchen",
                unique_id=None,
                data={
                    CONF_LIGHTS: [LIGHT],
                    "bias_stops": 0.0,
                    "night_off": False,
                },
            ),
            ConfigSubentryData(
                subentry_type=SUBENTRY_TYPE_ROOM,
                title="Living",
                unique_id=None,
                data={
                    CONF_LIGHTS: [LIGHT],
                    "bias_stops": 0.0,
                    "night_off": False,
                },
            ),
        ],
    )
    config_entry.add_to_hass(hass)
    return config_entry


async def test_remotes_event_handling_and_turn_on(hass: HomeAssistant, multi_room_entry: MockConfigEntry) -> None:
    """Test that event.* entities trigger button actions and turn_on works."""
    assert await hass.config_entries.async_setup(multi_room_entry.entry_id)
    await hass.async_block_till_done()

    coordinator = multi_room_entry.runtime_data.coordinator
    living_subentry = next(s for s in coordinator._subentries() if s.title == "Living")
    room = coordinator.rooms[living_subentry.subentry_id]

    # Verify normalization of remotes
    configured = coordinator.remotes.get_configured_remotes()
    assert configured[0]["action_entity"] == "event.living_office_control_action"

    # Simulate hold_down (turn_off) via event entity with attributes["event_type"]
    hass.states.async_set(
        "event.living_office_control_action",
        "2026-09-26T16:00:00.000+00:00",
        {"event_type": "brightness_move_down"},
    )
    await hass.async_block_till_done()

    # Room should be in manual off
    assert room.manual_touched is True
    assert room.manual_level == 0

    # Simulate hold_up (turn_on) via event entity
    hass.states.async_set(
        "event.living_office_control_action",
        "2026-09-26T16:00:05.000+00:00",
        {"event_type": "brightness_move_up"},
    )
    await hass.async_block_till_done()

    # Room manual off cleared
    assert room.manual_switch is False
    assert room.manual_level != 0

    # Simulate button_up (nudge_bias_up)
    old_bias = float(living_subentry.data.get("bias_stops", 0.0))
    hass.states.async_set(
        "event.living_office_control_action",
        "2026-09-26T16:00:10.000+00:00",
        {"event_type": "on"},
    )
    await hass.async_block_till_done()

    # Bias should increase by 0.5
    updated_subentry = multi_room_entry.subentries[living_subentry.subentry_id]
    assert updated_subentry.data["bias_stops"] == round(old_bias + 0.5, 2)


async def test_living_guest_mode_night_off_override(hass: HomeAssistant, multi_room_entry: MockConfigEntry) -> None:
    """Test that input_boolean.living_guest_mode overrides night_off for Living room."""
    assert await hass.config_entries.async_setup(multi_room_entry.entry_id)
    await hass.async_block_till_done()
    coordinator = multi_room_entry.runtime_data.coordinator
    living_subentry = next(s for s in coordinator._subentries() if s.title == "Living")

    # Guest mode is off by default
    hass.states.async_set("input_boolean.living_guest_mode", "off")
    await hass.async_block_till_done()
    settings = coordinator.room_settings(living_subentry)
    assert settings.night_off is False

    # Turn guest mode on
    hass.states.async_set("input_boolean.living_guest_mode", "on")
    await hass.async_block_till_done()
    settings_guest = coordinator.room_settings(living_subentry)
    assert settings_guest.night_off is True


async def test_websocket_toggle_guest_mode(
    hass: HomeAssistant, multi_room_entry: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """Test WebSocket command solace/toggle_guest_mode."""
    await async_setup_component(hass, "input_boolean", {"input_boolean": {"living_guest_mode": {}}})
    await hass.async_block_till_done()

    assert await hass.config_entries.async_setup(multi_room_entry.entry_id)
    await hass.async_block_till_done()

    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "solace/toggle_guest_mode"})
    msg = await client.receive_json()
    assert msg["success"] is True
    assert msg["result"]["guest_mode"] is True

    # Snapshot includes guest_mode
    await client.send_json({"id": 2, "type": "solace/get"})
    snap_msg = await client.receive_json()
    assert snap_msg["success"] is True
    assert "guest_mode" in snap_msg["result"]["world"]
    assert snap_msg["result"]["world"]["guest_mode"] is True
