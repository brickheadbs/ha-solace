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
from .const import (
    CONF_LIGHTS,
    CONF_NEAR_PRESENCE,
    CONF_ZONES,
    PLATFORMS,
    SUBENTRY_TYPE_ROOM,
)
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


async def async_migrate_entry(hass: HomeAssistant, entry: SolaceConfigEntry) -> bool:
    """v1 → v2: every area gains a ``zones`` list.

    ⚠️ **Deliberately behaviour-preserving, and deliberately not clever.** The v1 layout
    made every zone its own subentry — Living Office, Living Sitting and Living Ceiling
    were three "rooms" that are one set of four walls. Merging them is the whole point of
    v2, but *which* subentries merge into *which* area is a fact about a particular house
    that no migration can infer, and guessing it would silently re-point lights.

    So this migration gives each existing area a single zone holding all of its lights,
    carrying the old ``zone_bias_stops`` and ``diminish_pct`` across unchanged. The
    result computes byte-identical levels to v1. Merging areas is then a deliberate,
    visible act in the panel.
    """
    if entry.version >= 2:
        return True

    for subentry in list(entry.subentries.values()):
        if subentry.subentry_type != SUBENTRY_TYPE_ROOM or subentry.data.get(CONF_ZONES):
            continue
        data = dict(subentry.data)
        data[CONF_ZONES] = [
            {
                "zone_id": "main",
                "name": subentry.title,
                "lights": list(data.get(CONF_LIGHTS) or []),
                "presence": list(data.get(CONF_NEAR_PRESENCE) or []),
                "bias_stops": float(data.get("zone_bias_stops", 0.0)),
                "diminish_pct": float(data.get("diminish_pct", 0.0)),
            }
        ]
        hass.config_entries.async_update_subentry(entry, subentry, data=data)

    hass.config_entries.async_update_entry(entry, version=2)
    _LOGGER.info("Solace: migrated %s areas to the v2 zone layout", len(entry.subentries))
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
