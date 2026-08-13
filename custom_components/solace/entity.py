"""Shared entity base.

``_attr_has_entity_name = True`` is mandatory for new integrations: the entity name
identifies only the data point, never the device or the domain. The device supplies the
rest, so a room's demand sensor reads "Kitchen Demand" without anyone concatenating
strings.
"""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import SolaceCoordinator


class SolaceEntity(CoordinatorEntity[SolaceCoordinator]):
    """Base for every Solace entity."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: SolaceCoordinator, key: str) -> None:
        super().__init__(coordinator)
        self._key = key
        self._attr_unique_id = f"{coordinator.config_entry.entry_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, coordinator.config_entry.entry_id)},
            name="Solace",
            manufacturer="Solace",
            entry_type=None,
        )


class SolaceRoomEntity(SolaceEntity):
    """Base for entities that belong to a room subentry.

    The room's device is keyed on the **subentry id**, which is also a natural stable
    ``unique_id``. Entities are attached with ``config_subentry_id=`` at
    ``async_add_entities`` time — that kwarg is the whole trick.
    """

    def __init__(self, coordinator: SolaceCoordinator, subentry_id: str, name: str, key: str) -> None:
        super().__init__(coordinator, f"{subentry_id}_{key}")
        self._subentry_id = subentry_id
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, subentry_id)},
            name=name,
            manufacturer="Solace",
            via_device=(DOMAIN, coordinator.config_entry.entry_id),
        )

    @property
    def room(self):
        return self.coordinator.rooms.get(self._subentry_id)
