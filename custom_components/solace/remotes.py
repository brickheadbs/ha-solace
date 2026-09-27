"""Remote control dispatcher for Solace.

Handles 4-button Zigbee remotes (such as IKEA Styrbar) to provide direct, low-friction
physical control of room bias, manual mode, sleep mode, and lighting state.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.util import dt as dt_util

from .const import CONF_REMOTES, CONF_SLEEP_TOGGLE

if TYPE_CHECKING:
    from .coordinator import SolaceCoordinator

_LOGGER = logging.getLogger(__name__)

DEFAULT_REMOTES: list[dict[str, Any]] = [
    {
        "remote_id": "entry_control",
        "name": "Entry Control",
        "room_name": "Entry",
        "action_entity": "event.entry_control_action",
        "button_on": "cycle_preset_levels",
        "button_off": "turn_off",
        "button_up": "nudge_bias_up",
        "button_down": "nudge_bias_down",
        "button_left": "resume_auto",
        "button_right": "toggle_sleep",
        "hold_up": "nudge_bias_up",
        "hold_down": "nudge_bias_down",
        "hold_left": "resume_auto",
        "hold_right": "leaving_5_min",
    },
    {
        "remote_id": "kitchen_control",
        "name": "Kitchen Control",
        "room_name": "Kitchen",
        "action_entity": "event.kitchen_control_action",
        "button_on": "cycle_preset_levels",
        "button_off": "turn_off",
        "button_up": "nudge_bias_up",
        "button_down": "nudge_bias_down",
        "button_left": "resume_auto",
        "button_right": "toggle_sleep",
        "hold_up": "nudge_bias_up",
        "hold_down": "nudge_bias_down",
        "hold_left": "resume_auto",
        "hold_right": "leaving_5_min",
    },
    {
        "remote_id": "bedroom_control",
        "name": "Bedroom Control",
        "room_name": "Bedroom",
        "action_entity": "event.bedroom_control_action",
        "button_on": "cycle_preset_levels",
        "button_off": "turn_off",
        "button_up": "nudge_bias_up",
        "button_down": "nudge_bias_down",
        "button_left": "resume_auto",
        "button_right": "toggle_sleep",
        "hold_up": "nudge_bias_up",
        "hold_down": "nudge_bias_down",
        "hold_left": "resume_auto",
        "hold_right": "leaving_5_min",
    },
    {
        "remote_id": "living_office_control",
        "name": "Living Office Control",
        "room_name": "Living",
        "action_entity": "event.living_office_control_action",
        "button_on": "resume_auto",
        "button_off": "turn_off",
        "button_up": "resume_auto",
        "button_down": "turn_off",
        "button_left": "resume_auto",
        "button_right": "toggle_sleep",
        "hold_up": "nudge_bias_up",
        "hold_down": "nudge_bias_down",
        "hold_left": "resume_auto",
        "hold_right": "leaving_5_min",
    },
]


# The office fixtures Work Mode drives (mirrors the list in coordinator._async_apply_light).
WORK_MODE_LIGHTS = frozenset(
    ("light.living_office_desk_lamp", "light.living_office_e", "light.living_office_w")
)
RESUME_ACTIONS = frozenset(("resume_auto", "auto", "turn_on"))


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
        entities: set[str] = set()
        for r in remotes:
            entity = r.get("action_entity")
            if entity:
                entities.add(entity)
                if entity.startswith("event."):
                    entities.add("sensor." + entity[6:])
                elif entity.startswith("sensor."):
                    entities.add("event." + entity[7:])
        if not entities:
            return

        @callback
        def _on_action(event: Event[EventStateChangedData]) -> None:
            new_state = event.data.get("new_state")
            old_state = event.data.get("old_state")
            if new_state is None:
                return
            entity_id = event.data.get("entity_id")
            # ⚠️ An event entity RESTORES its last press (state = timestamp, event_type
            # attribute) on every HA start, Solace reload and z2m reconnect. Without this
            # guard the last button pressed is replayed each time — a stale "on" re-latched
            # the Entry into manual. A real press always changes the timestamp from a
            # valid previous state.
            if entity_id.startswith("event."):
                if old_state is None or old_state.state in ("unknown", "unavailable"):
                    return
                if old_state.state == new_state.state:
                    return
            # Both twins are subscribed as a fallback; when the event entity exists the
            # legacy action sensor would dispatch every press a second time.
            elif entity_id.startswith("sensor.") and self.hass.states.get("event." + entity_id[7:]):
                return
            action = new_state.attributes.get("event_type") or new_state.state
            if not action or action in ("unknown", "unavailable", "", "None"):
                return
            self.hass.async_create_task(self._async_handle_action(entity_id, action))

        self._unsub = async_track_state_change_event(self.hass, list(entities), _on_action)

    @callback
    def async_unregister(self) -> None:
        """Cancel subscriptions."""
        if self._unsub:
            self._unsub()
            self._unsub = None

    @staticmethod
    def _has_tap_resume(remote: dict[str, Any]) -> bool:
        """Does a single press on this remote return the room to Auto?"""
        return any(
            remote.get(key) in RESUME_ACTIONS
            for key in ("button_up", "button_on", "button_left", "button_right")
        )

    def _held_dark(self, room: Any, subentry: Any) -> bool:
        """Is the room in a manual hold with every light off?"""
        if room.manual_level == 0:
            return True
        if not (room.manual_switch or room.manual_touched):
            return False
        for entity_id in subentry.data.get("lights", []):
            state = self.hass.states.get(entity_id)
            if state is not None and state.state == "on":
                return False
        return True

    async def _async_handle_action(self, entity_id: str, action: str) -> None:
        """Route button action from sensor to appropriate handler."""
        remotes = self.get_configured_remotes()
        remote = next(
            (
                r
                for r in remotes
                if r.get("action_entity") == entity_id
                or (entity_id.startswith("event.") and r.get("action_entity") == "sensor." + entity_id[6:])
                or (entity_id.startswith("sensor.") and r.get("action_entity") == "event." + entity_id[7:])
            ),
            None,
        )
        if remote is None:
            return

        _LOGGER.debug("Solace Remote [%s] triggered action: %s", remote.get("name"), action)

        # Map Styrbar / generic actions to logical buttons (Press vs Hold)
        button = None
        # --- Press Layer ---
        if action in ("on", "arrow_up_click"):
            button = remote.get("button_up") or remote.get("button_on")
        elif action in ("off", "arrow_down_click"):
            button = remote.get("button_down") or remote.get("button_off")
        elif action == "arrow_left_click":
            button = remote.get("button_left")
        elif action == "arrow_right_click":
            button = remote.get("button_right")
        # --- Hold Layer ---
        elif action in ("brightness_move_up", "brightness_step_up", "arrow_up_hold"):
            button = remote.get("hold_up") or remote.get("button_up") or remote.get("button_on")
        elif action in ("brightness_move_down", "brightness_step_down", "arrow_down_hold"):
            button = remote.get("hold_down") or remote.get("button_down") or remote.get("button_off")
        elif action == "arrow_left_hold":
            button = remote.get("hold_left") or remote.get("button_left")
        elif action == "arrow_right_hold":
            button = remote.get("hold_right") or remote.get("button_right")

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

        if action_name == "cycle_preset_levels" and subentry:
            # Auto (None) -> 50% (127) -> 80% (203) -> 100% (254) -> Auto
            PRESETS = [127, 203, 254]
            current_manual = room.manual_level if room else None
            is_manual_active = room.manual_switch or room.manual_touched if room else False
            if not is_manual_active or current_manual is None:
                next_level = PRESETS[0]
                if room:
                    room.manual_switch = True
                    room.manual_level = next_level
                _LOGGER.info("Solace Remote: Preset cycle -> 50%% (%s) for %s", next_level, subentry.title)
            else:
                idx = -1
                for i, p in enumerate(PRESETS):
                    if abs(current_manual - p) <= 20:
                        idx = i
                        break
                if idx == -1 or idx == len(PRESETS) - 1:
                    if room:
                        room.manual_switch = False
                        room.manual_touched = False
                        room.manual_level = None
                        room.manual_since = None
                    _LOGGER.info("Solace Remote: Preset cycle -> Auto for %s", subentry.title)
                else:
                    next_level = PRESETS[idx + 1]
                    if room:
                        room.manual_switch = True
                        room.manual_level = next_level
                    _LOGGER.info("Solace Remote: Preset cycle -> %s for %s", next_level, subentry.title)
            if room and room.manual_switch and room.manual_level:
                for entity_id in subentry.data.get("lights", []):
                    await self.coordinator.writer.async_set_brightness(
                        entity_id,
                        room.manual_level,
                        self.coordinator.house.transition_manual_s,
                    )
            await self.coordinator.async_persist()
            await self.coordinator.async_request_refresh()

        elif action_name in ("resume_auto", "auto", "turn_on") and subentry:
            if room:
                room.manual_switch = False
                room.manual_touched = False
                room.manual_level = None
                room.manual_since = None
                room.occupied = True
                room.occupied_since = dt_util.utcnow().timestamp()
                self.coordinator._last_presence[subentry.subentry_id] = dt_util.utcnow().timestamp()
                for entity_id in subentry.data.get("lights", []):
                    room.last_written[entity_id] = 0
                    room.last_source[entity_id] = "auto"
                _LOGGER.info("Solace Remote: Full Auto resumed for %s", subentry.title)
            await self.coordinator.async_persist()
            await self.coordinator.async_request_refresh()
            # If auto calculated <= 0 (e.g. extreme night latch or solar threshold), ensure lights turn on.
            # The fallback level is then held as a TIMED manual touch: without the hold the
            # very next tick re-solves to 0 and turns the lights straight back off.
            forced = False
            for entity_id in subentry.data.get("lights", []):
                sol = room.solutions.get(entity_id) if room else None
                if not sol or sol.level <= 0:
                    await self.coordinator.writer.async_set_brightness(
                        entity_id,
                        127,
                        getattr(self.coordinator.house, "transition_up_occupancy_s", 2.0),
                    )
                    forced = True
                    if room:
                        room.last_written[entity_id] = 127
            if forced and room:
                room.manual_touched = True
                room.manual_since = dt_util.utcnow().timestamp()
                await self.coordinator.async_persist()

        elif action_name == "toggle_auto_manual" and room and subentry:
            if room.manual_switch or room.manual_touched:
                room.manual_switch = False
                room.manual_touched = False
                room.manual_level = None
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
            lights = list(subentry.data.get("lights", []))
            # "Off, stay off" latches indefinitely ONLY where the same remote has a one-tap
            # way back (a press mapped to resume_auto/turn_on), or when the Living room is
            # in guest mode. Everywhere else it is a timed hold (manual_hold_minutes):
            # latching an Entry off forever meant motion never lit it again.
            latch = self._has_tap_resume(remote) or (
                "living" in subentry.title.lower() and self.coordinator._living_guest_mode()  # noqa: SLF001
            )
            if room:
                room.manual_touched = True
                room.manual_level = 0
                room.manual_since = dt_util.utcnow().timestamp()
                room.manual_switch = latch
                for entity_id in lights:
                    room.last_written[entity_id] = 0
                    room.last_source[entity_id] = "off"
            if lights:
                await self.coordinator.writer.async_turn_off(
                    lights, getattr(self.coordinator.house, "transition_down_off_s", 4.0), is_acute=True
                )
            # Work Mode drives the office lights; switching THAT room off ends it. Any
            # other room's off button must not.
            work_mode = self.hass.states.get("input_boolean.work_mode")
            if work_mode and work_mode.state == "on" and any(l in WORK_MODE_LIGHTS for l in lights):
                await self.hass.services.async_call(
                    "input_boolean",
                    "turn_off",
                    {"entity_id": "input_boolean.work_mode"},
                    context=self.coordinator.writer.new_context(),
                )
            await self.coordinator.async_persist()
            await self.coordinator.async_request_refresh()

        elif action_name in ("nudge_bias_up", "nudge_bias_down") and subentry:
            delta = 0.5 if action_name == "nudge_bias_up" else -0.5
            current_bias = float(subentry.data.get("bias_stops", 0.0))
            new_bias = round(max(-4.0, min(4.0, current_bias + delta)), 2)
            # Up on a room that is held dark WAKES it instead of nudging. The old test was
            # ``manual_level == 0`` only, which a hold set by the switch entity, the panel
            # or a preset never satisfies (manual_level stays None): the room stayed dark
            # and every press silently ratcheted the bias up another half stop.
            if action_name == "nudge_bias_up" and room and self._held_dark(room, subentry):
                _LOGGER.info("Solace Remote: Up woke %s from a dark manual hold", subentry.title)
                await self._async_execute_action("resume_auto", remote)
                return
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

        elif action_name == "leaving_5_min":
            _LOGGER.info("Solace Remote: Triggered Leaving in 5 minutes countdown")
            if self.hass.services.has_service("input_button", "press"):
                await self.hass.services.async_call(
                    "input_button",
                    "press",
                    {"entity_id": "input_button.leaving_soon"},
                    context=self.coordinator.writer.new_context(),
                )
            elif self.hass.services.has_service("input_boolean", "turn_on"):
                await self.hass.services.async_call(
                    "input_boolean",
                    "turn_on",
                    {"entity_id": "input_boolean.leaving_pending"},
                    context=self.coordinator.writer.new_context(),
                )
