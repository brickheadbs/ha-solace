"""Solace — a lighting calculation engine for Home Assistant.

Rooms are added *inside* the integration as config subentries, not as one automation per
light. The maths lives in ``engine.py`` / ``colour.py`` / ``fade.py``, which import
nothing from Home Assistant and are unit-tested with plain pytest — everything else here
is plumbing.
"""

from __future__ import annotations

import logging

from homeassistant.core import HomeAssistant

from .const import PLATFORMS
from .coordinator import SolaceConfigEntry, SolaceCoordinator, SolaceData

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: SolaceConfigEntry) -> bool:
    coordinator = SolaceCoordinator(hass, entry)
    await coordinator.async_prepare()
    await coordinator.async_config_entry_first_refresh()

    # `entry.runtime_data`, not `hass.data[DOMAIN][entry.entry_id]` — the latter has been
    # legacy since 2025.1.
    entry.runtime_data = SolaceData(coordinator=coordinator)

    # Register teardown at setup time, while we still hold the handle.
    entry.async_on_unload(coordinator.async_shutdown_listeners)
    entry.async_on_unload(entry.add_update_listener(_async_settings_changed))

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: SolaceConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _async_settings_changed(hass: HomeAssistant, entry: SolaceConfigEntry) -> None:
    """Clock 1 — recalculate the moment a setting moves.

    A **refresh**, deliberately not a reload. Reloading on every slider drag would tear
    down and rebuild the entities mid-gesture; the 2026-07 build's 30-second settings
    poll is the opposite failure and felt just as broken.
    """
    await entry.runtime_data.coordinator.async_request_refresh()
