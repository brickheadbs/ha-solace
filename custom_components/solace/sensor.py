"""Diagnostic sensors — the engine showing its work.

These exist so the answer is never a bare number. "Why is the kitchen at 97?" should be
answerable from the dashboard without reading the log or the source: demand, stops, mode
and the full step trace are all here.
"""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .colour import resolve_colour
from .const import SUBENTRY_TYPE_ROOM
from .coordinator import SolaceConfigEntry, SolaceCoordinator
from .entity import SolaceEntity, SolaceRoomEntity
from .models import LightSettings


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SolaceConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data.coordinator
    async_add_entities([SolaceColourSensor(coordinator)])

    for subentry_id, subentry in entry.subentries.items():
        if subentry.subentry_type != SUBENTRY_TYPE_ROOM:
            continue
        async_add_entities(
            [
                SolaceDemandSensor(coordinator, subentry_id, subentry.title),
                SolaceTargetSensor(coordinator, subentry_id, subentry.title),
                SolaceModeSensor(coordinator, subentry_id, subentry.title),
            ],
            config_subentry_id=subentry_id,
        )


class SolaceColourSensor(SolaceEntity, SensorEntity):
    """The house-wide colour target, before the per-bulb clamp.

    One value for the whole house, anchored to civil dusk. What each bulb *achieves* can
    differ — five stop at 4000 K — and that divergence shows up per light, not here.
    """

    _attr_name = "Colour target"
    _attr_native_unit_of_measurement = "K"
    _attr_icon = "mdi:palette"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: SolaceCoordinator) -> None:
        super().__init__(coordinator, "colour_target")

    @property
    def native_value(self) -> int:
        from homeassistant.util import dt as dt_util

        now = dt_util.now()
        return resolve_colour(
            now.hour + now.minute / 60.0,
            self.coordinator._dusk_hour(),
            self.coordinator.house,
            LightSettings(min_kelvin=1000, max_kelvin=20000),
        ).kelvin


class SolaceDemandSensor(SolaceRoomEntity, SensorEntity):
    """Objective demand, 0-100 %. **Not a bias** — the only step that is not taste."""

    _attr_name = "Demand"
    _attr_native_unit_of_measurement = "%"
    _attr_icon = "mdi:brightness-percent"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: SolaceCoordinator, subentry_id: str, name: str) -> None:
        super().__init__(coordinator, subentry_id, name, "demand")

    @property
    def native_value(self) -> float | None:
        room = self.room
        if not room or not room.solutions:
            return None
        return round(next(iter(room.solutions.values())).demand * 100, 1)


class SolaceTargetSensor(SolaceRoomEntity, SensorEntity):
    """The level Solace wants for this room, plus the whole trace behind it."""

    _attr_name = "Target level"
    _attr_icon = "mdi:target"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: SolaceCoordinator, subentry_id: str, name: str) -> None:
        super().__init__(coordinator, subentry_id, name, "target")

    @property
    def native_value(self) -> int | None:
        room = self.room
        if not room or not room.solutions:
            return None
        return max(s.level for s in room.solutions.values())

    @property
    def extra_state_attributes(self) -> dict:
        room = self.room
        if not room:
            return {}
        house = self.coordinator.house
        return {
            "ambience_open": room.ambience_open,
            "per_light": {
                entity_id: {
                    "level": solution.level,
                    "stops": round(solution.stops, 3),
                    # Percent is the *display* unit; stops are the engine unit, because
                    # a stop is a doubling of light and that makes biases additive.
                    "light_percent": round(
                        (solution.level / 254) ** house.gamma * 100, 1
                    ),
                    "trace": dict(solution.trace),
                }
                for entity_id, solution in room.solutions.items()
            },
        }


class SolaceModeSensor(SolaceRoomEntity, SensorEntity):
    """normal / night. DND on ⇒ asleep ⇒ night."""

    _attr_name = "Mode"
    _attr_icon = "mdi:theme-light-dark"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: SolaceCoordinator, subentry_id: str, name: str) -> None:
        super().__init__(coordinator, subentry_id, name, "mode")

    @property
    def native_value(self) -> str | None:
        room = self.room
        if not room or not room.solutions:
            return None
        return next(iter(room.solutions.values())).mode.value
