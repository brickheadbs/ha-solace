"""The manual/auto switch — per room, not per light.

A *touch* holds manual for ``manual_hold_minutes`` then auto resumes; this *switch*
holds indefinitely. Both are persisted, because an in-memory flag means a restart either
steals the lights back mid-evening or locks them in manual forever.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

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
            [SolaceManualSwitch(coordinator, subentry_id, subentry.title)],
            config_subentry_id=subentry_id,
        )


class SolaceManualSwitch(SolaceRoomEntity, SwitchEntity):
    """On = this room is mine, hands off. Off = Solace drives it."""

    _attr_name = "Manual"
    _attr_icon = "mdi:hand-back-right"

    def __init__(self, coordinator: SolaceCoordinator, subentry_id: str, room_name: str) -> None:
        super().__init__(coordinator, subentry_id, room_name, "manual")

    @property
    def is_on(self) -> bool:
        room = self.room
        return bool(room and room.manual_switch)

    async def async_turn_on(self, **kwargs: Any) -> None:
        if room := self.room:
            room.manual_switch = True
            await self.coordinator.async_persist()
            self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Returning to auto also clears the touch timer.

        Without this, flipping the switch off would leave a stale touch still holding the
        room manual for the rest of its hold window — the switch would look like it did
        nothing.
        """
        if room := self.room:
            room.manual_switch = False
            room.manual_touched = False
            room.manual_since = None
            await self.coordinator.async_persist()
            self.async_write_ha_state()
            await self.coordinator.async_request_refresh()
