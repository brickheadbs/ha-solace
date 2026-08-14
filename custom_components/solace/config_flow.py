"""Config flow — one entry for the house, one **subentry** per room.

Subentries are the intended way to let a user add N of something inside a single
integration. The alternative an agent reaches for from memory — hand-rolling a
``.storage`` file, or one config entry per room — is neither, and neither survives a
core upgrade well.

Constraints worth knowing before designing around them:

* Subentry flows support only ``user`` and ``reconfigure`` steps — no discovery, no reauth.
* Since 2026-07-21 a device belongs to one config entry and at most one subentry.
* The parent entry holds everything global.
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    SOURCE_RECONFIGURE,
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    ConfigSubentryFlow,
    OptionsFlow,
    SubentryFlowResult,
)
from homeassistant.core import callback
from homeassistant.data_entry_flow import section
from homeassistant.helpers.selector import (
    BooleanSelector,
    EntitySelector,
    EntitySelectorConfig,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
)

from .const import (
    CONF_ALARM_ENTITY,
    CONF_AWAY_ENTITY,
    CONF_DND_ENTITY,
    CONF_LIGHTS,
    CONF_LUX_SENSOR,
    CONF_NEAR_PRESENCE,
    CONF_PER_LIGHT,
    CONF_PRESENCE,
    CONF_SLEEP_TOGGLE,
    DEFAULT_LUX_SENSOR,
    DOMAIN,
    HOUSE_SETTINGS,
    ROOM_SETTINGS,
    SUBENTRY_TYPE_ROOM,
    Setting,
)


def _number(setting: Setting) -> NumberSelector:
    """Build a number selector for one setting.

    ⚠️ `unit_of_measurement` must be **omitted**, never passed as None — voluptuous
    validates it as `str` and a None raises `MultipleInvalid` while *building the
    schema*. The failure is nasty: the whole options flow refuses to open, HA reports it
    only as a generic 400, and nothing lands in the log. The room flow was unaffected
    purely because every room setting happens to have a unit, which is exactly the kind
    of coincidence that hides a bug.
    """
    config: dict = {
        "min": setting.minimum,
        "max": setting.maximum,
        "step": setting.step,
        "mode": NumberSelectorMode.BOX,
    }
    if setting.unit:
        config["unit_of_measurement"] = setting.unit
    return NumberSelector(NumberSelectorConfig(**config))


class SolaceConfigFlow(ConfigFlow, domain=DOMAIN):
    """The house-level flow. One entry per installation."""

    # v2 added the per-area `zones` list. See `async_migrate_entry`.
    VERSION = 3

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        if user_input is not None:
            return self.async_create_entry(title="Solace", data=user_input)

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    # There is exactly one illuminance sensor in this house, and no
                    # indoor ones — per-room daylight is estimated, never measured.
                    vol.Required(
                        CONF_LUX_SENSOR, default=DEFAULT_LUX_SENSOR
                    ): EntitySelector(
                        EntitySelectorConfig(domain=["sensor"], device_class="illuminance")
                    ),
                    # DND is the definition of "asleep". ⚠️ `sensor` MUST be in this
                    # list: the Pixel's DND entity is `sensor.pixel_8a_do_not_disturb_
                    # sensor`, a four-value enum, not a binary_sensor. Leaving `sensor`
                    # out makes the real entity unpickable — which is exactly what
                    # happened on the first attempt.
                    vol.Optional(CONF_DND_ENTITY): EntitySelector(
                        EntitySelectorConfig(
                            domain=["sensor", "binary_sensor", "input_boolean", "switch"]
                        )
                    ),
                    # A manual sleep switch, OR-ed with the phone. There is deliberately
                    # NO "awake" override — the phone already clears DND when he gets out
                    # of bed, and night mode is latched so getting up does not end it.
                    vol.Optional(CONF_SLEEP_TOGGLE): EntitySelector(
                        EntitySelectorConfig(domain=["input_boolean", "switch", "binary_sensor"])
                    ),
                    # Night mode ends `alarm_lead_minutes` before this.
                    vol.Optional(CONF_ALARM_ENTITY): EntitySelector(
                        EntitySelectorConfig(domain=["sensor"], device_class="timestamp")
                    ),
                    # Away mode — turns off all lights immediately when armed.
                    vol.Optional(CONF_AWAY_ENTITY): EntitySelector(
                        EntitySelectorConfig(domain=["input_boolean", "switch", "binary_sensor"])
                    ),
                }
            ),
        )

    @classmethod
    @callback
    def async_get_supported_subentry_types(
        cls, config_entry: ConfigEntry
    ) -> dict[str, type[ConfigSubentryFlow]]:
        return {SUBENTRY_TYPE_ROOM: RoomSubentryFlowHandler}

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return SolaceOptionsFlow()


class SolaceOptionsFlow(OptionsFlow):
    """House-wide tunables.

    ⚠️ Plain ``OptionsFlow``, and ``self.config_entry`` is **only read, never assigned**.
    Assigning it raises ``AttributeError: property 'config_entry' … has no setter`` — it
    is a read-only property, and that exact line broke HACS, LocalTuya and
    better_thermostat when it landed.

    Deliberately *not* ``OptionsFlowWithReload``: this integration wants a **refresh** on
    a settings change, not a teardown-and-rebuild. The two are mutually exclusive.
    """

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data={**self.config_entry.options, **user_input})

        current = self.config_entry.options
        data = self.config_entry.data
        schema: dict[Any, Any] = {}
        for key in (CONF_SLEEP_TOGGLE, CONF_ALARM_ENTITY, CONF_AWAY_ENTITY):
            existing = current.get(key, data.get(key))
            field = (
                vol.Optional(key, description={"suggested_value": existing})
                if existing
                else vol.Optional(key)
            )
            domains = (
                ["sensor"]
                if key == CONF_ALARM_ENTITY
                else ["input_boolean", "switch", "binary_sensor"]
            )
            schema[field] = EntitySelector(EntitySelectorConfig(domain=domains))
        for setting in HOUSE_SETTINGS:
            schema[
                vol.Required(setting.key, default=current.get(setting.key, setting.default))
            ] = _number(setting)
        return self.async_show_form(step_id="init", data_schema=vol.Schema(schema))


class RoomSubentryFlowHandler(ConfigSubentryFlow):
    """Add a room: pick its lights and sensors, then dial in each light."""

    def __init__(self) -> None:
        self._room: dict[str, Any] = {}

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        if user_input is not None:
            self._room = dict(user_input)
            return await self.async_step_lights()

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required("name"): str,
                    # Groups appear here as single entities — a group is a real lock, so
                    # its members must never be addressed independently.
                    vol.Required(CONF_LIGHTS): EntitySelector(
                        EntitySelectorConfig(domain="light", multiple=True)
                    ),
                    # A LIST, any-on. "Either kitchen sensor turning on lights the whole
                    # kitchen" cannot be expressed with a single sensor per room.
                    vol.Optional(CONF_PRESENCE): EntitySelector(
                        EntitySelectorConfig(domain="binary_sensor", multiple=True)
                    ),
                    # Kitchen only. The *near* sub-zone reading clear is what triggers
                    # diminish — a reduction that stays, never an off.
                    vol.Optional(CONF_NEAR_PRESENCE): EntitySelector(
                        EntitySelectorConfig(domain="binary_sensor", multiple=True)
                    ),
                    # The bedroom's rule: asleep ⇒ fully off, not dimmed.
                    vol.Required("night_off", default=False): BooleanSelector(),
                    **{
                        vol.Required(s.key, default=s.default): _number(s)
                        for s in ROOM_SETTINGS
                    },
                }
            ),
        )

    async def async_step_lights(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Per-light overrides, one row per light chosen in the previous step.

        The schema is built in Python from those choices — a dynamic per-entity list is
        ordinary code, not a missing framework feature.

        The overrides are **additive offsets**, not absolute values: ``house + room +
        zone + light``. Absolute per-light values would make the room dial dead.
        """
        lights: list[str] = self._room.get(CONF_LIGHTS, [])

        if user_input is not None:
            per_light: dict[str, dict[str, float]] = {}
            for entity_id in lights:
                slug = entity_id.replace(".", "_")
                block = user_input.get(f"light_{slug}", {})
                per_light[entity_id] = {
                    "bias_stops": float(block.get("bias_stops", 0.0)),
                    "clamp_min": int(block.get("clamp_min", 0)),
                    "clamp_max": int(block.get("clamp_max", 254)),
                }
            title = self._room.pop("name")
            data = {**self._room, CONF_PER_LIGHT: per_light}

            # ⚠️ A reconfigure must NOT finish with `async_create_entry` — HA raises
            # `ValueError: Source is reconfigure, expected user`. Reusing the create
            # path for reconfigure is the obvious way to avoid duplicating the form,
            # and it fails at the very last call.
            if self.source == SOURCE_RECONFIGURE:
                return self.async_update_and_abort(
                    self._get_entry(),
                    self._get_reconfigure_subentry(),
                    title=title,
                    data=data,
                )
            return self.async_create_entry(title=title, data=data)

        schema: dict[Any, Any] = {}
        for entity_id in lights:
            slug = entity_id.replace(".", "_")
            schema[vol.Required(f"light_{slug}")] = section(
                vol.Schema(
                    {
                        vol.Required("bias_stops", default=0.0): NumberSelector(
                            NumberSelectorConfig(
                                min=-4, max=4, step=0.05, mode=NumberSelectorMode.SLIDER
                            )
                        ),
                        # The clamp is the LAST step of the pipeline and must survive
                        # every upstream stage — that is what makes the living ceiling's
                        # glare cap a hard rule rather than a suggestion.
                        vol.Required("clamp_min", default=0): NumberSelector(
                            NumberSelectorConfig(min=0, max=254, step=1)
                        ),
                        vol.Required("clamp_max", default=254): NumberSelector(
                            NumberSelectorConfig(min=1, max=254, step=1)
                        ),
                    }
                ),
                {"collapsed": True},
            )

        return self.async_show_form(step_id="lights", data_schema=vol.Schema(schema))

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Same two-step form as adding a room, pre-filled with what is stored.

        Subentry flows support only `user` and `reconfigure` — there is no discovery or
        reauth step to fall back on, so this is the single edit path.
        """
        if user_input is None:
            self._room = dict(self._get_reconfigure_subentry().data)
        return await self.async_step_user(user_input)
