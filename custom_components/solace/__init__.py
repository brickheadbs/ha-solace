"""Solace — a lighting calculation engine for Home Assistant.

Rooms are added *inside* the integration as config subentries, not as one automation per
light. The maths lives in ``engine.py`` / ``colour.py`` / ``fade.py``, which import
nothing from Home Assistant and are unit-tested with plain pytest — everything else here
is plumbing.
"""

from __future__ import annotations

import logging

from homeassistant.core import HomeAssistant

from . import panel, websocket_api
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

    # The panel and its API. Registered after runtime_data exists — the WebSocket
    # commands look the entry up by that attribute, so registering earlier would give a
    # window where the panel loads and every command answers "not_loaded".
    websocket_api.async_register(hass)
    try:
        await panel.async_register_panel(hass)
    except Exception:  # noqa: BLE001
        # A panel that will not register must never cost the house its lighting engine.
        _LOGGER.exception("Solace: the settings panel failed to register")
    return True


async def async_unload_entry(hass: HomeAssistant, entry: SolaceConfigEntry) -> bool:
    panel.async_remove_panel(hass)
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _async_settings_changed(hass: HomeAssistant, entry: SolaceConfigEntry) -> None:
    """Clock 1 — recalculate the moment a setting moves.

    A **refresh**, deliberately not a reload. Reloading on every slider drag would tear
    down and rebuild the entities mid-gesture; the 2026-07 build's 30-second settings
    poll is the opposite failure and felt just as broken.
    """
    coordinator = entry.runtime_data.coordinator
    # Entity links (sleep toggle, alarm, DND, presence, lights) may have changed, and the
    # listeners were bound to the OLD ones. Rebind before recalculating, or the new
    # entity is configured-but-unwatched — which is exactly how the sleep toggle came up
    # silently dead the first time it was set.
    coordinator.async_resubscribe()
    # This refresh is a slider moving, not the world moving — so its writes use the
    # setting-change transition rather than the 10 s mode glide.
    coordinator.async_note_tuning()
    await coordinator.async_request_refresh()
