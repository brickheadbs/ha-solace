"""Sidebar panel registration.

The panel is a **built** bundle committed at ``frontend/solace-panel.js`` — HACS copies
files, it does not run a build, so an un-built source tree installs as a blank page. The
TypeScript sources live in ``panel/`` at the repo root and are not shipped.

``?v=`` on the module URL is not decoration: HA's frontend caches panel modules hard, and
without a version bump an updated bundle keeps serving the old one from the browser cache
until a hard reload. The query string is the version from ``manifest.json``, so a release
invalidates it automatically.
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

PANEL_URL_PATH = "solace"
"""The sidebar route: /solace."""

STATIC_URL = f"/{DOMAIN}_frontend"
WEBCOMPONENT = "solace-panel"


async def async_register_panel(hass: HomeAssistant) -> None:
    """Serve the bundle and put Solace in the sidebar. Safe to call twice.

    ⚠️ Every failure in here is swallowed by the caller on purpose, and ``frontend`` /
    ``panel_custom`` are **after_dependencies**, not dependencies. The panel is a
    convenience; the engine drives the house. Declaring a hard dependency means a
    frontend that fails to set up takes the lighting engine down with it — trading the
    thing that matters for the thing that is nice to have.
    """
    integration = await async_get_integration(hass, DOMAIN)
    version = integration.version or "dev"
    source = Path(__file__).parent / "frontend"

    if not (source / f"{WEBCOMPONENT}.js").is_file():
        # Fail loudly here rather than leaving a sidebar item that opens a blank page —
        # a missing build is the single most likely way this goes wrong, and a blank
        # panel gives the user nothing to search for.
        _LOGGER.error(
            "Solace: %s/%s.js is missing — the panel bundle was not built. "
            "Run `npm ci && npm run build` in panel/ and commit the output",
            source,
            WEBCOMPONENT,
        )
        return

    if not hass.data.get(f"{DOMAIN}_static_registered"):
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(
                    STATIC_URL,
                    str(source),
                    # The bundle is versioned by query string, so long-lived cache headers
                    # would only make a stale build harder to shift during development.
                    cache_headers=False,
                )
            ]
        )
        hass.data[f"{DOMAIN}_static_registered"] = True

    if PANEL_URL_PATH in hass.data.get("frontend_panels", {}):
        return

    # Imported here, not at module scope: `panel_custom` is an after_dependency, so at
    # import time it may not be loaded and a top-level import would fail the whole module.
    from homeassistant.components import panel_custom  # noqa: PLC0415

    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=WEBCOMPONENT,
        module_url=f"{STATIC_URL}/{WEBCOMPONENT}.js?v={version}",
        sidebar_title="Lighting Engine",
        sidebar_icon="mdi:tune",
        # Not admin-only: this is the house's light switch, and locking it to admins is
        # how a guest ends up unable to turn a room up.
        require_admin=False,
        config={"version": version},
    )


def async_remove_panel(hass: HomeAssistant) -> None:
    """Take the sidebar item away when the entry is removed.

    The static path stays registered — HA has no public deregistration for it, and
    leaving a directory served is harmless.
    """
    if PANEL_URL_PATH not in hass.data.get("frontend_panels", {}):
        return
    from homeassistant.components import frontend  # noqa: PLC0415

    frontend.async_remove_panel(hass, PANEL_URL_PATH)
