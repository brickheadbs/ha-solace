"""Options flow — it must actually open. A broken one is invisible until you try."""

from __future__ import annotations

from homeassistant.core import HomeAssistant

from custom_components.solace.const import HOUSE_SETTINGS


async def test_options_flow_opens_and_lists_every_tunable(hass: HomeAssistant, entry, world):
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] == "form", result
    keys = {str(k) for k in result["data_schema"].schema}
    for setting in HOUSE_SETTINGS:
        assert setting.key in keys, setting.key


async def test_options_flow_saves(hass: HomeAssistant, entry, world):
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    result = await hass.config_entries.options.async_init(entry.entry_id)
    submitted = {s.key: s.default for s in HOUSE_SETTINGS}
    submitted["night_level"] = 51
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], user_input=submitted
    )
    assert result["type"] == "create_entry", result
    assert entry.options["night_level"] == 51


async def test_setup_survives_a_missing_lux_sensor(hass: HomeAssistant, entry):
    """A missing sensor must not fail the entry — it is a reading, not a dependency."""
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is entry.state.LOADED


async def test_a_room_can_be_reconfigured(hass: HomeAssistant, entry, world):
    """Reconfigure must finish with `async_update_and_abort`.

    Reusing the create path raises `ValueError: Source is reconfigure, expected user`
    at the very last call — after the user has filled in both forms.
    """
    from homeassistant.config_entries import SOURCE_RECONFIGURE

    from .conftest import LIGHT, PRESENCE

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    subentry_id = next(iter(entry.subentries))

    result = await hass.config_entries.subentries.async_init(
        (entry.entry_id, "room"),
        context={"source": SOURCE_RECONFIGURE, "subentry_id": subentry_id},
    )
    result = await hass.config_entries.subentries.async_configure(
        result["flow_id"],
        {
            "name": "Kitchen",
            "lights": [LIGHT],
            "presence": [PRESENCE],
            "night_off": True,
            "bias_stops": -1.0,
            "zone_bias_stops": 0.0,
            "diminish_pct": 0.0,
            "manual_hold_minutes": 30.0,
        },
    )
    slug = LIGHT.replace(".", "_")
    result = await hass.config_entries.subentries.async_configure(
        result["flow_id"],
        {f"light_{slug}": {"bias_stops": 0.0, "clamp_min": 10, "clamp_max": 10}},
    )
    assert result["type"] == "abort"
    assert result["reason"] == "reconfigure_successful"

    stored = entry.subentries[subentry_id].data
    assert stored["night_off"] is True
    assert stored["bias_stops"] == -1.0
    assert stored["per_light"][LIGHT]["clamp_max"] == 10
