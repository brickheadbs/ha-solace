"""Binary sensors — the gate, and whether a room is currently hands-off."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import SUBENTRY_TYPE_ROOM
from .coordinator import SolaceConfigEntry, SolaceCoordinator
from .entity import SolaceRoomEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SolaceConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data.coordinator
    for subentry_id, subentry in entry.subentries.items():
        if subentry.subentry_type != SUBENTRY_TYPE_ROOM:
            continue
        async_add_entities(
            [
                SolaceGateSensor(coordinator, subentry_id, subentry.title),
                SolaceManualActiveSensor(coordinator, subentry_id, subentry.title),
            ],
            config_subentry_id=subentry_id,
        )


class SolaceGateSensor(SolaceRoomEntity, BinarySensorEntity):
    """On = dark enough for lights to run at all.

    Hysteretic and independent of demand: this answers *may lights run*, demand answers
    *how much light*. The two windows must be tuned as a pair — with the starting values
    the gate is far narrower than the demand curve, so most of the curve is unreachable.
    That is a tuning fact worth seeing, not a bug to paper over.
    """

    _attr_name = "Ambient gate"
    _attr_icon = "mdi:theme-light-dark"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: SolaceCoordinator, subentry_id: str, name: str) -> None:
        super().__init__(coordinator, subentry_id, name, "gate")

    @property
    def is_on(self) -> bool:
        room = self.room
        return bool(room and room.ambience_open)


class SolaceManualActiveSensor(SolaceRoomEntity, BinarySensorEntity):
    """On = Solace is not writing to this room right now."""

    _attr_name = "Manual active"
    _attr_icon = "mdi:hand-back-right-outline"

    def __init__(self, coordinator: SolaceCoordinator, subentry_id: str, name: str) -> None:
        super().__init__(coordinator, subentry_id, name, "manual_active")

    @property
    def is_on(self) -> bool:
        room = self.room
        if room is None:
            return False
        subentry = self.coordinator.config_entry.subentries.get(self._subentry_id)
        if subentry is None:
            return False
        hold = self.coordinator.room_settings(subentry).manual_hold_minutes
        return room.is_manual(hold, dt_util.utcnow().timestamp())

    @property
    def extra_state_attributes(self) -> dict:
        room = self.room
        if room is None:
            return {}
        return {
            "held_by_switch": room.manual_switch,
            "touched": room.manual_touched,
            "touched_at": room.manual_since,
        }
