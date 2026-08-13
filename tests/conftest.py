"""Shared fixtures for the integration tests."""

from __future__ import annotations

import pytest
from homeassistant.config_entries import ConfigSubentryData
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.solace.const import (
    CONF_DND_ENTITY,
    CONF_LIGHTS,
    CONF_LUX_SENSOR,
    CONF_PRESENCE,
    DOMAIN,
    SUBENTRY_TYPE_ROOM,
)

LUX = "sensor.entry_exterior_illuminance"
DND = "input_boolean.dnd"
PRESENCE = "binary_sensor.kitchen_diner_occupancy"
LIGHT = "light.kitchen_diner_floor_se"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Required for HA to load anything out of custom_components/."""
    return


@pytest.fixture(autouse=True)
async def fixed_clock(hass: HomeAssistant, freezer):
    """Pin the clock and the timezone.

    A lighting engine reads the wall clock — the evening ramp, the colour glide and the
    morning release all key off it. Without freezing, this suite would pass in the
    afternoon and fail after 20:00 when the ramp opens, which is the worst kind of flaky.
    14:00 sits outside the ramp, so bias comes only from the settings under test.
    """
    await hass.config.async_update(time_zone="UTC")
    freezer.move_to("2026-08-13 14:00:00+00:00")


@pytest.fixture
def entry(hass: HomeAssistant) -> MockConfigEntry:
    """A house with one room, wired to the fake entities set up in `world`."""
    config_entry = MockConfigEntry(
        domain=DOMAIN,
        title="Solace",
        unique_id=DOMAIN,
        data={CONF_LUX_SENSOR: LUX, CONF_DND_ENTITY: DND},
        options={CONF_LUX_SENSOR: LUX, CONF_DND_ENTITY: DND},
        subentries_data=[
            ConfigSubentryData(
                subentry_type=SUBENTRY_TYPE_ROOM,
                title="Kitchen",
                unique_id=None,
                data={
                    CONF_LIGHTS: [LIGHT],
                    CONF_PRESENCE: PRESENCE,
                    "bias_stops": 0.0,
                    "zone_bias_stops": 0.0,
                    "diminish_pct": 0.0,
                    "manual_hold_minutes": 30.0,
                },
            )
        ],
    )
    config_entry.add_to_hass(hass)
    return config_entry


@pytest.fixture(autouse=True)
async def light_domain(hass: HomeAssistant):
    """Solace calls `light.turn_on`, so the domain has to exist for the call to land."""
    from homeassistant.setup import async_setup_component

    await async_setup_component(hass, "light", {"light": []})
    await hass.async_block_till_done()


@pytest.fixture
def world(hass: HomeAssistant):
    """A dark, occupied, awake house with one Aqara CCT bulb, currently off."""

    def _set(lux: float = 10.0, occupied: bool = True, dnd: bool = False, light_on: bool = False):
        hass.states.async_set(LUX, str(lux), {"device_class": "illuminance"})
        hass.states.async_set(PRESENCE, "on" if occupied else "off")
        hass.states.async_set(DND, "on" if dnd else "off")
        hass.states.async_set(
            LIGHT,
            "on" if light_on else "off",
            {
                "brightness": 120 if light_on else None,
                "color_temp_kelvin": 4000 if light_on else None,
                # Aqara CCT — the family is inferred from these, never guessed.
                "min_color_temp_kelvin": 2702,
                "max_color_temp_kelvin": 6535,
                "supported_color_modes": ["color_temp"],
            },
        )

    _set()
    return _set
