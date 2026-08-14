"""Remote control dispatcher for Solace.

Handles 4-button Zigbee remotes (such as IKEA Styrbar) to provide direct, low-friction
physical control of room bias, manual mode, sleep mode, and lighting state.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_track_state_change_event

from .const import CONF_REMOTES, CONF_SLEEP_TOGGLE

if TYPE_CHECKING:
    from .coordinator import SolaceCoordinator

_LOGGER = logging.getLogger(__name__)

DEFAULT_REMOTES: list[dict[str, Any]] = [
    {
        "remote_id": "entry_control",
        "name": "Entry Control",
        "room_name": "Entry",
        "action_entity": "sensor.entry_control_action",
        "button_on": "toggle_auto_manual",
        "button_off": "turn_off",
        "button_up": "nudge_bias_up",
        "button_down": "nudge_bias_down",
        "button_left": "toggle_manual",
        "button_right": "toggle_sleep",
    },
    {
        "remote_id": "kitchen_control",
        "name": "Kitchen Control",
        "room_name": "Kitchen",
        "action_entity": "sensor.kitchen_control_action",
        "button_on": "toggle_auto_manual",
        "button_off": "turn_off",
        "button_up": "nudge_bias_up",
        "button_down": "nudge_bias_down",
        "button_left": "toggle_manual",
        "button_right": "toggle_sleep",
    },
    {
        "remote_id": "bedroom_control",
        "name": "Bedroom Control",
        "room_name": "Bedroom",
        "action_entity": "sensor.bedroom_control_action",
        "button_on": "toggle_auto_manual",
        "button_off": "turn_off",
        "button_up": "nudge_bias_up",
        "button_down": "nudge_bias_down",
        "button_left": "toggle_manual",
        "button_right": "toggle_sleep",
    },
    {
        "remote_id": "living_office_control",
        "name": "Living Office Control",
        "room_name": "Living",
        "action_entity": "sensor.living_office_control_action",
        "button_on": "toggle_auto_manual",
        "button_off": "turn_off",
        "button_up": "nudge_bias_up",
        "button_down": "nudge_bias_down",
        "button_left": "toggle_manual",
        "button_right": "toggle_sleep",
    },
]


class RemoteDispatcher:
    """Listens to remote action sensors and dispatches commands."""

    def __init__(self, coordinator: SolaceCoordinator) -> None:
        self.coordinator = coordinator
        self.hass: HomeAssistant = coordinator.hass
        self._unsub: Any = None

    def get_configured_remotes(self) -> list[dict[str, Any]]:
        """Return configured remotes with fallback to defaults."""
        stored = self.coordinator.config_entry.options.get(CONF_REMOTES)
        if stored and isinstance(stored, list):
            return stored
        return DEFAULT_REMOTES

    @callback
    def async_register(self) -> None:
        """Subscribe to action sensors for all configured remotes."""
        remotes = self.get_configured_remotes()
        entities = [r["action_entity"] for r in remotes if r.get("action_entity")]
        if not entities:
            return

        @callback
        def _on_action(event: Event[EventStateChangedData]) -> None:
            new_state = event.data.get("new_state")
            if new_state is None:
                return
            action = new_state.state
            if not action or action in ("unknown", "unavailable", "", "None"):
                return
            entity_id = event.data.get("entity_id")
            self.hass.async_create_task(self._async_handle_action(entity_id, action))

        self._unsub = async_track_state_change_event(self.hass, entities, _on_action)

    @callback
    def async_unregister(self) -> None:
        """Cancel subscriptions."""
        if self._unsub:
            self._unsub()
            self._unsub = None

    async def _async_handle_action(self, entity_id: str, action: str) -> None:
        """Route button action from sensor to appropriate handler."""
        remotes = self.get_configured_remotes()
        remote = next((r for r in remotes if r.get("action_entity") == entity_id), None)
        if remote is None:
            return

        _LOGGER.debug("Solace Remote [%s] triggered action: %s", remote.get("name"), action)

        # Map Styrbar / generic actions to logical buttons
        button = None
        if action in ("on", "arrow_up_click", "arrow_up_hold", "brightness_move_up", "brightness_step_up"):
            button = remote.get("button_up") or remote.get("button_on")
        elif action in ("off", "arrow_down_click", "arrow_down_hold", "brightness_move_down", "brightness_step_down"):
            button = remote.get("button_down") or remote.get("button_off")
        elif action in ("arrow_left_click", "arrow_left_hold"):
            button = remote.get("button_left")
        elif action in ("arrow_right_click", "arrow_right_hold"):
            button = remote.get("button_right")

        if not button or button == "none":
            return

        await self._async_execute_action(button, remote)

    async def _async_execute_action(self, action_name: str, remote: dict[str, Any]) -> None:
        """Execute the configured action for a remote."""
        room_name = remote.get("room_name") or ""
        subentry = None
        for s in self.coordinator._subentries():
            if s.title.lower() == room_name.lower() or s.subentry_id == remote.get("room_id"):
                subentry = s
                break

        room = self.coordinator.rooms.get(subentry.subentry_id) if subentry else None

        if action_name == "toggle_auto_manual" and room and subentry:
            if room.manual_switch or room.manual_touched:
                room.manual_switch = False
                room.manual_touched = False
                room.manual_since = None
                _LOGGER.info("Solace Remote: Resumed auto for %s", subentry.title)
            else:
                room.manual_switch = True
                _LOGGER.info("Solace Remote: Enabled manual switch for %s", subentry.title)
            await self.coordinator.async_persist()
            await self.coordinator.async_request_refresh()

        elif action_name == "toggle_manual" and room and subentry:
            room.manual_switch = not room.manual_switch
            await self.coordinator.async_persist()
            await self.coordinator.async_request_refresh()

        elif action_name == "turn_off" and subentry:
            if room:
                room.manual_touched = True
                room.manual_since = self.hass.loop.time()
            for entity_id in subentry.data.get("lights", []):
                await self.coordinator.writer.async_turn_off(
                    entity_id, self.coordinator.house.transition_off_s
                )
            await self.coordinator.async_persist()
            await self.coordinator.async_request_refresh()

        elif action_name in ("nudge_bias_up", "nudge_bias_down") and subentry:
            delta = 0.5 if action_name == "nudge_bias_up" else -0.5
            current_bias = float(subentry.data.get("bias_stops", 0.0))
            new_bias = round(max(-4.0, min(4.0, current_bias + delta)), 2)
            _LOGGER.info("Solace Remote: Nudged bias for %s from %s to %s stops", subentry.title, current_bias, new_bias)
            self.hass.config_entries.async_update_subentry(
                self.coordinator.config_entry,
                subentry,
                data={**subentry.data, "bias_stops": new_bias},
            )
            await self.coordinator.async_request_refresh()

        elif action_name == "toggle_sleep":
            sleep_entity = (
                self.coordinator.config_entry.options.get(CONF_SLEEP_TOGGLE)
                or self.coordinator.config_entry.data.get(CONF_SLEEP_TOGGLE)
                or "input_boolean.solace_sleep"
            )
            domain = sleep_entity.split(".")[0]
            _LOGGER.info("Solace Remote: Toggling sleep helper %s", sleep_entity)
            await self.hass.services.async_call(
                domain,
                "toggle",
                {"entity_id": sleep_entity},
                context=self.coordinator.writer.new_context(),
            )
