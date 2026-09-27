"""Tests for RemoteDispatcher event handling, turn_on action, and Living Room Guest Mode."""

from __future__ import annotations

import pytest
from homeassistant.config_entries import ConfigSubentryData
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
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
                    "button_left": "resume_auto",
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
    """Test that event.* entities trigger button actions, resume_auto, and turn_on works."""
    assert await hass.config_entries.async_setup(multi_room_entry.entry_id)
    await hass.async_block_till_done()

    coordinator = multi_room_entry.runtime_data.coordinator
    living_subentry = next(s for s in coordinator._subentries() if s.title == "Living")
    room = coordinator.rooms[living_subentry.subentry_id]

    # Verify normalization of remotes
    configured = coordinator.remotes.get_configured_remotes()
    assert configured[0]["action_entity"] == "event.living_office_control_action"

    # The entity's restored state (old_state None) must not dispatch — see replay test.
    hass.states.async_set(
        "event.living_office_control_action",
        "2026-09-26T15:00:00.000+00:00",
        {"event_type": "arrow_right_click"},
    )
    await hass.async_block_till_done()

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

    # Simulate button_left (resume_auto / Auto Override) via event entity
    hass.states.async_set(
        "event.living_office_control_action",
        "2026-09-26T16:00:02.000+00:00",
        {"event_type": "arrow_left_click"},
    )
    await hass.async_block_till_done()

    # Room returned to auto. (If auto solves to 0 here, the 127 fallback is held as a
    # timed touch so the next tick does not switch it straight back off.)
    assert room.manual_switch is False
    assert room.manual_level is None

    # Simulate hold_down (turn_off) again
    hass.states.async_set(
        "event.living_office_control_action",
        "2026-09-26T16:00:04.000+00:00",
        {"event_type": "brightness_move_down"},
    )
    await hass.async_block_till_done()
    assert room.manual_level == 0

    # Simulate hold_up (turn_on) via event entity
    hass.states.async_set(
        "event.living_office_control_action",
        "2026-09-26T16:00:06.000+00:00",
        {"event_type": "brightness_move_up"},
    )
    await hass.async_block_till_done()

    # Room manual off cleared, returned to auto and occupied
    assert room.manual_switch is False
    assert room.manual_level is None
    assert room.occupied is True

    # The fallback write lit the bulb (the test double has to be told).
    hass.states.async_set(LIGHT, "on", {**hass.states.get(LIGHT).attributes, "brightness": 127})
    await hass.async_block_till_done()

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


REMOTE = "event.living_office_control_action"


def _press(hass: HomeAssistant, stamp: str, event_type: str) -> None:
    hass.states.async_set(REMOTE, f"2026-09-27T20:00:{stamp}.000+00:00", {"event_type": event_type})


def _set_remote(hass: HomeAssistant, entry: MockConfigEntry, **mapping: str) -> None:
    remote = {
        "remote_id": "living_office_control",
        "name": "Living Office Control",
        "room_name": "Living",
        "action_entity": REMOTE,
        **mapping,
    }
    hass.config_entries.async_update_entry(entry, options={**entry.options, CONF_REMOTES: [remote]})


async def _living(hass: HomeAssistant, entry: MockConfigEntry):
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    coordinator = entry.runtime_data.coordinator
    sub = next(s for s in coordinator._subentries() if s.title == "Living")
    # Prime the event entity the way a restore does (old_state None → ignored).
    _press(hass, "00", "on")
    await hass.async_block_till_done()
    return coordinator, sub, coordinator.rooms[sub.subentry_id]


async def test_restored_event_state_is_not_replayed(hass: HomeAssistant, multi_room_entry: MockConfigEntry) -> None:
    """A restored / reconnected event entity must not re-fire its last press."""
    coordinator, sub, room = await _living(hass, multi_room_entry)
    assert room.manual_level is None  # the priming "on" did nothing

    hass.states.async_set(REMOTE, "unavailable")
    await hass.async_block_till_done()
    # z2m reconnect restores the same last press — from unavailable, so ignored.
    hass.states.async_set(REMOTE, "2026-09-27T20:00:05.000+00:00", {"event_type": "brightness_move_down"})
    await hass.async_block_till_done()
    assert room.manual_level is None
    assert room.manual_touched is False


async def test_hold_up_wakes_a_room_latched_dark_by_the_switch(
    hass: HomeAssistant, multi_room_entry: MockConfigEntry
) -> None:
    """The live failure 2026-09-27: manual_switch on, manual_level None, lights off.
    Hold-up only nudged bias; the room stayed dark and the bias climbed."""
    coordinator, sub, room = await _living(hass, multi_room_entry)
    room.manual_switch = True
    room.manual_level = None
    bias_before = float(sub.data.get("bias_stops", 0.0))

    _press(hass, "10", "brightness_move_up")  # hold_up → turn_on in this fixture
    await hass.async_block_till_done()
    assert room.manual_switch is False

    # Same state, but hold_up mapped to nudge_bias_up (the live Living mapping).
    _set_remote(hass, multi_room_entry, hold_up="nudge_bias_up", button_up="resume_auto")
    await hass.async_block_till_done()
    coordinator = multi_room_entry.runtime_data.coordinator
    room = coordinator.rooms[sub.subentry_id]
    _press(hass, "11", "on")  # re-prime after reload
    await hass.async_block_till_done()
    room.manual_switch = True
    room.manual_touched = False
    room.manual_level = None
    hass.states.async_set(LIGHT, "off", hass.states.get(LIGHT).attributes)

    _press(hass, "12", "brightness_move_up")
    await hass.async_block_till_done()
    assert room.manual_switch is False
    assert multi_room_entry.subentries[sub.subentry_id].data["bias_stops"] == bias_before


async def test_turn_off_latches_only_with_a_tap_resume(hass: HomeAssistant, multi_room_entry: MockConfigEntry) -> None:
    """Off stays off indefinitely only where one press brings Auto back."""
    _set_remote(hass, multi_room_entry, button_down="turn_off", button_up="nudge_bias_up")
    coordinator, sub, room = await _living(hass, multi_room_entry)

    _press(hass, "20", "off")
    await hass.async_block_till_done()
    assert room.manual_level == 0
    assert room.manual_switch is False  # timed hold, not a forever latch
    # ...and the timed hold is actually live (same clock as the coordinator).
    assert room.is_manual(30.0, dt_util.utcnow().timestamp()) is True

    _set_remote(hass, multi_room_entry, button_down="turn_off", button_up="resume_auto")
    await hass.async_block_till_done()
    room = multi_room_entry.runtime_data.coordinator.rooms[sub.subentry_id]
    _press(hass, "21", "on")  # re-prime; "on" → resume_auto
    await hass.async_block_till_done()
    _press(hass, "22", "off")
    await hass.async_block_till_done()
    assert room.manual_switch is True


async def test_turn_off_elsewhere_leaves_work_mode_alone(hass: HomeAssistant, multi_room_entry: MockConfigEntry) -> None:
    await async_setup_component(hass, "input_boolean", {"input_boolean": {"work_mode": {"initial": True}}})
    _set_remote(hass, multi_room_entry, button_down="turn_off")
    await _living(hass, multi_room_entry)
    _press(hass, "30", "off")
    await hass.async_block_till_done()
    # The fixture's Living light is not an office fixture.
    assert hass.states.get("input_boolean.work_mode").state == "on"


async def test_preset_cycle_writes_without_crashing(hass: HomeAssistant, multi_room_entry: MockConfigEntry) -> None:
    """Entry's "on" button: HouseSettings.transition_setting_s no longer exists (2026-08-15),
    so the preset cycle raised AttributeError after latching the room manual."""
    _set_remote(hass, multi_room_entry, button_on="cycle_preset_levels", button_up="cycle_preset_levels")
    coordinator, sub, room = await _living(hass, multi_room_entry)
    coordinator.remotes._unsub  # noqa: B018 — dispatcher is registered
    await coordinator.remotes._async_execute_action(
        "cycle_preset_levels", coordinator.remotes.get_configured_remotes()[0]
    )
    assert room.manual_level == 127
