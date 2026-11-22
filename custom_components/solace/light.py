"""House brightness — a voice-friendly light that drives the house bias.

Google Home (via the Matter Hub bridge) understands lights, not a "bias in stops" number.
This entity translates:

* **Brightness** 1-255 (Google: 1-100 %) maps linearly onto ``bias_stops`` -2 … +2 (half is neutral). The
  engine keeps following the sun; only the house bias moves. Bias outside ±2 (set from the
  panel) reads as the lowest or highest level.
* **Off** takes every room manual at level 0, exactly as touching each room down would
  (same code path as the room's Manual level slider, so the manual hold applies).
* **On** (without a brightness) releases those rooms back to Solace.

It owns no state of its own: brightness is read from the config entry, on/off from the
rooms, so the panel and this entity can never disagree.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.light import ATTR_BRIGHTNESS, ColorMode, LightEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import DOMAIN, SUBENTRY_TYPE_ROOM
from .coordinator import SolaceConfigEntry, SolaceCoordinator
from .entity import SolaceEntity

BIAS_KEY = "bias_stops"
VOICE_RANGE_STOPS = 2.0
BIAS_STEP = 0.05


def bias_to_brightness(bias: float) -> int:
    """House bias in stops -> HA brightness 1-255. 128 is neutral, 1 is -2, 255 is +2."""
    level = 128 + (bias / VOICE_RANGE_STOPS) * 127
    return max(1, min(255, round(level)))


def brightness_to_bias(brightness: int) -> float:
    """HA brightness 1-255 -> house bias in stops, clamped to ±2 and the 0.05 step."""
    bias = (max(1, min(255, brightness)) - 128) / 127 * VOICE_RANGE_STOPS
    bias = max(-VOICE_RANGE_STOPS, min(VOICE_RANGE_STOPS, bias))
    return round(round(bias / BIAS_STEP) * BIAS_STEP, 2)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SolaceConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    async_add_entities([SolaceHouseBrightness(entry.runtime_data.coordinator)])


class SolaceHouseBrightness(SolaceEntity, LightEntity):
    """Voice handle on the house bias; off/on = rooms manual-off / back to Solace."""

    _attr_name = "House brightness"
    _attr_icon = "mdi:brightness-auto"
    _attr_color_mode = ColorMode.BRIGHTNESS
    _attr_supported_color_modes = {ColorMode.BRIGHTNESS}

    def __init__(self, coordinator: SolaceCoordinator) -> None:
        super().__init__(coordinator, "house_brightness")

    # -- helpers ---------------------------------------------------------------------
    def _room_ids(self) -> list[str]:
        entry = self.coordinator.config_entry
        return [
            sid
            for sid, sub in entry.subentries.items()
            if sub.subentry_type == SUBENTRY_TYPE_ROOM and sub.data.get("lights")
        ]

    def _room_entity(self, domain: str, subentry_id: str, key: str) -> str | None:
        uid = f"{self.coordinator.config_entry.entry_id}_{subentry_id}_{key}"
        return er.async_get(self.hass).async_get_entity_id(domain, DOMAIN, uid)

    # -- state -----------------------------------------------------------------------
    @property
    def brightness(self) -> int:
        bias = float(self.coordinator.config_entry.options.get(BIAS_KEY, 0.0))
        return bias_to_brightness(bias)

    @property
    def is_on(self) -> bool:
        rooms = [self.coordinator.rooms.get(sid) for sid in self._room_ids()]
        rooms = [r for r in rooms if r is not None]
        if not rooms:
            return True
        # Off only when every room was taken manual to 0 (what turn_off does).
        return not all(
            (r.manual_touched or r.manual_switch) and (r.manual_level or 0) <= 0 for r in rooms
        )

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "house_bias_stops": float(self.coordinator.config_entry.options.get(BIAS_KEY, 0.0)),
            "voice_range_stops": VOICE_RANGE_STOPS,
        }

    # -- commands --------------------------------------------------------------------
    async def async_turn_on(self, **kwargs: Any) -> None:
        if ATTR_BRIGHTNESS in kwargs:
            bias = brightness_to_bias(int(kwargs[ATTR_BRIGHTNESS]))
            options = {**self.coordinator.config_entry.options, BIAS_KEY: bias}
            self.hass.config_entries.async_update_entry(
                self.coordinator.config_entry, options=options
            )
        if not self.is_on:
            # Back to Solace: same as flipping each room's Manual switch off.
            targets = [
                eid
                for sid in self._room_ids()
                if (eid := self._room_entity("switch", sid, "manual"))
            ]
            if targets:
                await self.hass.services.async_call(
                    "switch", "turn_off", {"entity_id": targets}, blocking=True
                )
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        targets = [
            eid
            for sid in self._room_ids()
            if (eid := self._room_entity("number", sid, "manual_level"))
        ]
        if targets:
            await self.hass.services.async_call(
                "number", "set_value", {"entity_id": targets, "value": 0}, blocking=True
            )
        self.async_write_ha_state()
