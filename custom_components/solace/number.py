"""Every tunable, as a `number` entity.

This is the interim control surface until the Lit panel lands — and it is not throwaway
work. The panel will write the same config entry these do, so the two are always
consistent, and a knob that exists here can be put on a dashboard card today.

**Nothing is hardcoded.** Every one of these is generated from the settings table in
``const.py``; a value that cannot be changed from the UI is a bug.
"""

from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import (
    HOUSE_SETTINGS,
    ROOM_SETTINGS,
    SUBENTRY_TYPE_ROOM,
    Setting,
)
from .coordinator import SolaceConfigEntry, SolaceCoordinator
from .entity import SolaceEntity, SolaceRoomEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SolaceConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data.coordinator

    async_add_entities(SolaceHouseNumber(coordinator, s) for s in HOUSE_SETTINGS)

    for subentry_id, subentry in entry.subentries.items():
        if subentry.subentry_type != SUBENTRY_TYPE_ROOM:
            continue
        async_add_entities(
            [
                SolaceRoomNumber(coordinator, subentry_id, subentry.title, s)
                for s in ROOM_SETTINGS
            ],
            # Ties the entity to that subentry's device.
            config_subentry_id=subentry_id,
        )
        async_add_entities(
            [SolaceManualLevel(coordinator, subentry_id, subentry.title)],
            config_subentry_id=subentry_id,
        )


class _SolaceNumberBase(NumberEntity):
    _attr_mode = NumberMode.BOX

    def _configure(self, setting: Setting) -> None:
        self._setting = setting
        self._attr_name = setting.name
        self._attr_native_min_value = setting.minimum
        self._attr_native_max_value = setting.maximum
        self._attr_native_step = setting.step
        self._attr_native_unit_of_measurement = setting.unit
        self._attr_icon = setting.icon


class SolaceHouseNumber(SolaceEntity, _SolaceNumberBase):
    """A house-wide tunable, stored in the config entry so it survives a restart."""

    def __init__(self, coordinator: SolaceCoordinator, setting: Setting) -> None:
        super().__init__(coordinator, f"house_{setting.key}")
        self._configure(setting)

    @property
    def native_value(self) -> float:
        return float(
            self.coordinator.config_entry.options.get(
                self._setting.key, self._setting.default
            )
        )

    async def async_set_native_value(self, value: float) -> None:
        options = {**self.coordinator.config_entry.options, self._setting.key: value}
        # Writing the entry fires the update listener, which refreshes the coordinator
        # immediately — clock 1. The slider takes effect now, not on the next poll.
        self.hass.config_entries.async_update_entry(
            self.coordinator.config_entry, options=options
        )


class SolaceRoomNumber(SolaceRoomEntity, _SolaceNumberBase):
    """A per-room tunable, stored in the room's subentry."""

    def __init__(
        self,
        coordinator: SolaceCoordinator,
        subentry_id: str,
        room_name: str,
        setting: Setting,
    ) -> None:
        super().__init__(coordinator, subentry_id, room_name, setting.key)
        self._configure(setting)

    @property
    def _subentry(self):
        return self.coordinator.config_entry.subentries[self._subentry_id]

    @property
    def native_value(self) -> float:
        return float(self._subentry.data.get(self._setting.key, self._setting.default))

    async def async_set_native_value(self, value: float) -> None:
        subentry = self._subentry
        self.hass.config_entries.async_update_subentry(
            self.coordinator.config_entry,
            subentry,
            data={**subentry.data, self._setting.key: value},
        )
        await self.coordinator.async_request_refresh()


class SolaceManualLevel(SolaceRoomEntity, NumberEntity):
    """The manual slider a room reveals when it is in manual.

    Per **room**, not per light — that is a settled decision. Setting it takes the room
    manual and holds it, exactly as a physical touch would.
    """

    _attr_name = "Manual level"
    _attr_icon = "mdi:brightness-6"
    _attr_native_min_value = 0
    _attr_native_max_value = 254
    _attr_native_step = 1
    _attr_mode = NumberMode.SLIDER

    def __init__(self, coordinator: SolaceCoordinator, subentry_id: str, room_name: str) -> None:
        super().__init__(coordinator, subentry_id, room_name, "manual_level")
        self._value: float = 0

    @property
    def native_value(self) -> float:
        return self._value

    async def async_set_native_value(self, value: float) -> None:
        from homeassistant.util import dt as dt_util

        self._value = value
        room = self.room
        if room is not None:
            room.manual_touched = True
            room.manual_since = dt_util.utcnow().timestamp()
            await self.coordinator.async_persist()

        subentry = self.coordinator.config_entry.subentries[self._subentry_id]
        for entity_id in subentry.data.get("lights", []):
            if value <= 0:
                await self.coordinator.writer.async_turn_off(
                    entity_id, self.coordinator.house.transition_off_s
                )
            else:
                await self.coordinator.writer.async_set_brightness(
                    entity_id,
                    int(value),
                    # The setting-change transition — this fires while the slider is
                    # being dragged, so a long glide here is unusable.
                    self.coordinator.house.transition_setting_s,
                )
        self.async_write_ha_state()
