"""The sole writer to lights.

Everything that touches a bulb goes through here. That is deliberate: one writer means
one place that stamps context, one place that clamps Kelvin, and one place that knows
the hardware rules from ``fade.py``. The 2026-08-12 test round was invalidated by two
uncoordinated writers on one bulb — *"one bulb, one writer"* is a rule that came out of
losing a night's data.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from homeassistant.components.light import (
    ATTR_BRIGHTNESS,
    ATTR_COLOR_TEMP_KELVIN,
    ATTR_TRANSITION,
    DOMAIN as LIGHT_DOMAIN,
)
from homeassistant.const import ATTR_ENTITY_ID, SERVICE_TURN_OFF, SERVICE_TURN_ON
from homeassistant.core import Context, HomeAssistant, State, callback
from homeassistant.util import ulid as ulid_util

from .colour import kelvin_to_mired, mired_to_kelvin
from .const import CONTEXT_PREFIX
from .fade import FadeProfile, colour_transition_is_safe
from .models import Family, LightSettings

_LOGGER = logging.getLogger(__name__)


def infer_family(
    state, *, cct_max_kelvin: int = 4200, rgb_max_kelvin: int = 7000
) -> Family:
    """Infer the bulb family from what the registry actually reports.

    Read, never guessed — the max Kelvin is the discriminator and it comes straight off
    the live entity:

    ==============  ====================
    max_color_temp  family
    ==============  ====================
    4000 K          IKEA TRADFRI
    6535 K          Aqara CCT
    9009 K          Aqara RGB
    ==============  ====================

    ⚠️ **No bulb counts here, deliberately.** This docstring used to carry "5 / 6 / 12",
    and on 2026-08-13 a live registry probe made all three wrong (6 / 6 / 15 counting
    group members individually). A count in a comment is a hardcoded fact about one
    house at one moment, and the whole reason this function reads the registry is that
    such facts rot — a note in this repo once "corrected" the IKEA count in the *wrong*
    direction and ``living_sitting_ne`` kept getting missed as a result. The panel shows
    the live count; nothing needs to remember it.
    """
    max_kelvin = state.attributes.get("max_color_temp_kelvin") or 0
    if max_kelvin <= cct_max_kelvin:
        return Family.IKEA
    if max_kelvin <= rgb_max_kelvin:
        return Family.AQARA_CCT
    return Family.AQARA_RGB


@dataclass
class LightWriter:
    """Issues every light command, and remembers what it sent."""

    hass: HomeAssistant
    _context_ids: set[str] = field(default_factory=set)
    _busy_until: dict[str, float] = field(default_factory=dict)
    """entity_id → monotonic timestamp when its in-flight brightness fade ends."""

    # ------------------------------------------------------------------ context

    def new_context(self) -> Context:
        """Stamp our own context so we can recognise our own echoes.

        ⚠️ **``context.user_id`` cannot do this job.** Measured on live HA 2026.8.1: a
        REST ``light.turn_on`` authenticated with a long-lived token carried
        ``user_id = 8e1cbd33…`` — because the token belongs to a user. ``user_id`` means
        *"attributable to a user account"*, not *"came from the frontend"*. Scripts, MCP
        tools and Node-RED all look identical to a dashboard tap.

        HA context ids cap at **36 characters**, hence the short prefix.
        """
        context_id = f"{CONTEXT_PREFIX}_{ulid_util.ulid_now()}"[:36]
        self._context_ids.add(context_id)
        if len(self._context_ids) > 512:
            self._context_ids = set(list(self._context_ids)[-256:])
        return Context(id=context_id)

    @callback
    def is_our_context(self, context: Context | None) -> bool:
        return bool(context and context.id in self._context_ids)

    # ------------------------------------------------------------------ writes

    async def async_turn_off(self, entity_id: str, transition_s: float) -> None:
        """Off, with an explicit transition. Always explicit — every bulb in this house
        carries ``transition: 4`` in z2m's configuration.yaml, so omitting it inherits a
        hidden 4 s fade and reads as sluggish."""
        await self.hass.services.async_call(
            LIGHT_DOMAIN,
            SERVICE_TURN_OFF,
            {ATTR_ENTITY_ID: entity_id, ATTR_TRANSITION: transition_s},
            blocking=False,
            context=self.new_context(),
        )
        self._busy_until.pop(entity_id, None)

    async def async_set_brightness(
        self,
        entity_id: str,
        level: int,
        transition_s: float,
        *,
        wake_kelvin: int | None = None,
    ) -> None:
        """Brightness as **one long hardware transition** — the safe, free channel.

        ``genLevelCtrl`` is verified linear to 40 minutes with no rate floor found, so
        there is nothing to plan around here. The bulb does the interpolation; we send
        one command and no per-tick traffic.

        ``wake_kelvin`` rides along **only when the light is currently off**. An off bulb
        *rejects* a colour command (measured: sent 4000 K while off, it woke at its old
        2801 K), so colour has to be in the same turn-on. There is no fade to break when
        coming from off. While the light is already on, colour is sent separately —
        brightness + colour in one payload is
        `z2m#19186 <https://github.com/Koenkk/zigbee2mqtt/issues/19186>`_ (they don't
        fade together; closed won't-fix).
        """
        data: dict = {
            ATTR_ENTITY_ID: entity_id,
            ATTR_BRIGHTNESS: int(level),
            ATTR_TRANSITION: transition_s,
        }
        if wake_kelvin is not None:
            data[ATTR_COLOR_TEMP_KELVIN] = int(wake_kelvin)

        await self.hass.services.async_call(
            LIGHT_DOMAIN,
            SERVICE_TURN_ON,
            data,
            blocking=False,
            context=self.new_context(),
        )
        loop_now = self.hass.loop.time()
        self._busy_until[entity_id] = loop_now + max(transition_s, 0.0)

    async def async_step_colour(
        self,
        entity_id: str,
        current_kelvin: int | None,
        target_kelvin: int,
        light: LightSettings,
        *,
        profile: FadeProfile | None = None,
        transition_s: float | None = None,
        r_crit: float | None = None,
        safety: float | None = None,
    ) -> int | None:
        """Start a smooth hardware colour transition toward the target."""
        if current_kelvin is None:
            return None

        # A colour step FREEZES an in-flight brightness fade on IKEA if sent concurrently.
        if profile is not None and not profile.concurrent and self._is_busy(entity_id):
            _LOGGER.debug("%s: deferring colour step, brightness fade in flight", entity_id)
            return None

        # Clamp target strictly to hardware limits (ha-hardware-truth)
        kelvin = max(light.min_kelvin, min(light.max_kelvin, target_kelvin))

        # Check tolerance (e.g. within 25 K of current is treated as settled)
        if abs(kelvin - current_kelvin) < 25:
            return None

        actual_transition = (
            transition_s
            if transition_s is not None
            else (profile.step_transition_s if profile is not None else 600.0)
        )

        await self.hass.services.async_call(
            LIGHT_DOMAIN,
            SERVICE_TURN_ON,
            {
                ATTR_ENTITY_ID: entity_id,
                ATTR_COLOR_TEMP_KELVIN: kelvin,
                ATTR_TRANSITION: actual_transition,
            },
            blocking=False,
            context=self.new_context(),
        )
        return kelvin

    def _is_busy(self, entity_id: str) -> bool:
        until = self._busy_until.get(entity_id)
        return until is not None and self.hass.loop.time() < until
