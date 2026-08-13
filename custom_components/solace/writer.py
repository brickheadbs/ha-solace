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
from .fade import colour_transition_is_safe
from .models import Family, LightSettings

_LOGGER = logging.getLogger(__name__)


def infer_family(state: State) -> Family:
    """Infer the bulb family from what the registry actually reports.

    Read, never guessed — the max Kelvin is the discriminator and it comes straight off
    the live entity:

    ==============  ====================  ==============
    max_color_temp  family                count in house
    ==============  ====================  ==============
    4000 K          IKEA TRADFRI          5
    6535 K          Aqara CCT             6
    9009 K          Aqara RGB             12
    ==============  ====================  ==============

    The IKEA count matters: a note in this repo once "corrected" 5 → 4 in the wrong
    direction and ``living_sitting_ne`` kept getting missed. Deriving it from the
    registry means the count cannot go stale again.
    """
    max_kelvin = state.attributes.get("max_color_temp_kelvin") or 0
    if max_kelvin <= 4200:
        return Family.IKEA
    if max_kelvin <= 7000:
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
        step_mired: int,
        step_transition_s: float,
    ) -> int | None:
        """Move colour one **short, bounded step** toward the target.

        This is the mechanism the hardware forces. A long ``color_temp`` transition
        underflows a 6-bit fixed-point accumulator and the bulb stalls on a hardware
        rail, permanently, with no error. A small absolute write with a *short* fade
        sits far inside the safe window (R ≈ 1.25 mired/s against a 0.156 floor) and is
        verified clean over 18+ consecutive steps.

        Returns the Kelvin actually commanded, or ``None`` if nothing was sent.
        """
        if current_kelvin is None:
            return None

        # 🔴 IKEA: a colour step FREEZES an in-flight brightness fade. Measured — Entry
        # Ceiling stalled at 84 for 420 s while a same-family control tracked exactly.
        # Serialise rather than risk a silently stuck fade.
        if light.family is Family.IKEA and self._is_busy(entity_id):
            _LOGGER.debug("%s: deferring colour step, brightness fade in flight", entity_id)
            return None

        current_mired = kelvin_to_mired(current_kelvin)
        target_mired = kelvin_to_mired(target_kelvin)
        delta = target_mired - current_mired
        if delta == 0:
            return None

        # Never overshoot, and never send a step so small it underflows its own fade.
        size = min(abs(delta), max(step_mired, 1))
        next_mired = current_mired + (size if delta > 0 else -size)

        if not colour_transition_is_safe(size, step_transition_s):
            _LOGGER.warning(
                "%s: refusing colour step of %s mired over %ss — below the underflow "
                "floor; widen colour_step_mired or shorten colour_step_fade",
                entity_id,
                size,
                step_transition_s,
            )
            return None

        kelvin = max(light.min_kelvin, min(light.max_kelvin, mired_to_kelvin(next_mired)))
        await self.hass.services.async_call(
            LIGHT_DOMAIN,
            SERVICE_TURN_ON,
            {
                ATTR_ENTITY_ID: entity_id,
                ATTR_COLOR_TEMP_KELVIN: kelvin,
                ATTR_TRANSITION: step_transition_s,
            },
            blocking=False,
            context=self.new_context(),
        )
        return kelvin

    def _is_busy(self, entity_id: str) -> bool:
        until = self._busy_until.get(entity_id)
        return until is not None and self.hass.loop.time() < until
