"""Integration tests — the plumbing, against a real Home Assistant instance.

``engine.py`` is covered by pure unit tests. These cover the half that only breaks
inside HA: setup, subentry-scoped entities, the writer's service calls, and manual
detection. An integration is not done until the entities read what you intended.
"""

from __future__ import annotations

import pytest
from homeassistant.core import Context, HomeAssistant
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed

from custom_components.solace.const import DOMAIN

from .conftest import LIGHT

pytestmark = pytest.mark.usefixtures("world")


async def _setup(hass: HomeAssistant, entry: MockConfigEntry) -> bool:
    ok = await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return ok


async def test_entry_sets_up_and_loads(hass: HomeAssistant, entry) -> None:
    assert await _setup(hass, entry)
    assert entry.state is entry.state.LOADED
    assert entry.runtime_data.coordinator is not None


async def test_runtime_data_not_hass_data(hass: HomeAssistant, entry) -> None:
    """`entry.runtime_data`, not `hass.data[DOMAIN][entry.entry_id]` — the latter has
    been legacy since 2025.1."""
    assert await _setup(hass, entry)
    assert hass.data.get(DOMAIN) in (None, {})
    assert hasattr(entry, "runtime_data")


async def test_house_settings_become_number_entities(hass: HomeAssistant, entry) -> None:
    """Nothing is hardcoded: every tunable must be reachable from the UI."""
    assert await _setup(hass, entry)
    for entity_id in (
        "number.solace_gate_start_lux",
        "number.solace_demand_window",
        "number.solace_night_level",
        "number.solace_colour_step_size",
        "number.solace_colour_step_fade",
        "number.solace_house_bias",
    ):
        assert hass.states.get(entity_id) is not None, entity_id


async def test_room_entities_are_scoped_to_the_subentry(hass: HomeAssistant, entry) -> None:
    """Entities are attached with `config_subentry_id=`, which ties them to that
    subentry's device rather than the hub."""
    from homeassistant.helpers import entity_registry as er

    assert await _setup(hass, entry)
    registry = er.async_get(hass)
    subentry_id = next(iter(entry.subentries))
    scoped = [
        e for e in registry.entities.values() if e.config_subentry_id == subentry_id
    ]
    assert scoped, "no entities were attached to the room subentry"
    names = {e.entity_id for e in scoped}
    assert any("manual" in n for n in names)
    assert any("target" in n for n in names)


async def test_a_dark_occupied_room_gets_written(hass: HomeAssistant, entry) -> None:
    """The end-to-end path: lux 10 → demand 0.634 → level 161 → one turn_on."""
    calls = []
    hass.bus.async_listen(
        "call_service",
        lambda e: calls.append(e.data) if e.data.get("domain") == "light" else None,
    )
    assert await _setup(hass, entry)
    await hass.async_block_till_done()

    turn_ons = [c for c in calls if c["service"] == "turn_on"]
    assert turn_ons, "Solace never wrote to the light"
    payload = turn_ons[-1]["service_data"]
    assert payload["brightness"] == 161
    # Every command carries an explicit transition — omitting it inherits the hidden
    # 4 s z2m fade that every bulb in this house is configured with.
    assert "transition" in payload
    # An OFF bulb rejects colour, so colour must ride in the same turn-on.
    assert "color_temp_kelvin" in payload


async def test_a_bright_room_is_gated_off(hass: HomeAssistant, entry, world) -> None:
    world(lux=400.0)
    assert await _setup(hass, entry)
    state = hass.states.get("sensor.kitchen_target_level")
    assert state is not None
    assert int(state.state) == 0


async def test_the_target_sensor_exposes_the_full_trace(hass: HomeAssistant, entry) -> None:
    """"Why is the kitchen at 97?" has to be answerable from the dashboard."""
    assert await _setup(hass, entry)
    state = hass.states.get("sensor.kitchen_target_level")
    per_light = state.attributes["per_light"][LIGHT]
    assert per_light["level"] == 161
    assert "demand" in per_light["trace"]
    assert "clamped" in per_light["trace"]


async def test_our_own_writes_are_not_mistaken_for_a_human(
    hass: HomeAssistant, entry, world
) -> None:
    """Context stamping. `context.user_id` cannot do this job — a REST call with a
    long-lived token carries one too, because the token belongs to a user."""
    assert await _setup(hass, entry)
    coordinator = entry.runtime_data.coordinator
    room = next(iter(coordinator.rooms.values()))
    room.manual_touched = False

    ours = coordinator.writer.new_context()
    hass.states.async_set(
        LIGHT,
        "on",
        {"brightness": 250, "min_color_temp_kelvin": 2702, "max_color_temp_kelvin": 6535},
        context=ours,
    )
    await hass.async_block_till_done()
    assert room.manual_touched is False


async def test_a_human_touch_takes_the_room_manual(hass: HomeAssistant, entry) -> None:
    assert await _setup(hass, entry)
    coordinator = entry.runtime_data.coordinator
    room = next(iter(coordinator.rooms.values()))
    room.manual_touched = False

    hass.states.async_set(
        LIGHT,
        "on",
        {"brightness": 250, "min_color_temp_kelvin": 2702, "max_color_temp_kelvin": 6535},
        context=Context(),
    )
    await hass.async_block_till_done()
    assert room.manual_touched is True
    assert hass.states.get("binary_sensor.kitchen_manual_active").state == "on"


async def test_a_small_echo_is_not_a_human_touch(hass: HomeAssistant, entry, world) -> None:
    """Compare with THRESHOLDS, not equality. Bulbs echo back values that differ from
    what was commanded; exact comparison flags every echo as a touch and the room locks
    itself into manual within a tick."""
    world(light_on=True)
    assert await _setup(hass, entry)
    coordinator = entry.runtime_data.coordinator
    room = next(iter(coordinator.rooms.values()))
    room.manual_touched = False

    hass.states.async_set(
        LIGHT,
        "on",
        {
            "brightness": 128,  # 8 levels off the 120 we "sent" — an echo, not a hand
            "color_temp_kelvin": 4000,
            "min_color_temp_kelvin": 2702,
            "max_color_temp_kelvin": 6535,
        },
        context=Context(),
    )
    await hass.async_block_till_done()
    assert room.manual_touched is False


async def test_manual_stops_solace_writing(hass: HomeAssistant, entry, world) -> None:
    world(light_on=True)
    assert await _setup(hass, entry)
    coordinator = entry.runtime_data.coordinator
    room = next(iter(coordinator.rooms.values()))
    room.manual_switch = True

    calls = []
    hass.bus.async_listen(
        "call_service",
        lambda e: calls.append(e.data) if e.data.get("domain") == "light" else None,
    )
    await coordinator.async_refresh()
    await hass.async_block_till_done()
    assert not calls


async def test_manual_state_survives_a_restart(hass: HomeAssistant, entry) -> None:
    """TRAP #2. Both the flag and the timestamp must persist — an in-memory flag means a
    restart either steals the lights back or locks them in manual forever."""
    assert await _setup(hass, entry)
    coordinator = entry.runtime_data.coordinator
    room = next(iter(coordinator.rooms.values()))
    room.manual_switch = True
    await coordinator.async_persist()

    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()

    restored = next(iter(entry.runtime_data.coordinator.rooms.values()))
    assert restored.manual_switch is True


async def test_a_fresh_boot_is_not_manual(hass: HomeAssistant, entry) -> None:
    """The other half of trap #2: age 0 must not read as "touched a moment ago"."""
    assert await _setup(hass, entry)
    room = next(iter(entry.runtime_data.coordinator.rooms.values()))
    assert room.manual_touched is False
    assert hass.states.get("binary_sensor.kitchen_manual_active").state == "off"


async def test_changing_a_setting_recalculates_immediately(
    hass: HomeAssistant, entry
) -> None:
    """Clock 1. The 2026-07 build polled settings every 30 s — a slider did nothing,
    then snapped. That single choice is most of why it felt broken."""
    assert await _setup(hass, entry)
    before = int(hass.states.get("sensor.kitchen_target_level").state)

    await hass.services.async_call(
        "number",
        "set_value",
        {"entity_id": "number.solace_house_bias", "value": -1.0},
        blocking=True,
    )
    await hass.async_block_till_done()

    after = int(hass.states.get("sensor.kitchen_target_level").state)
    assert after < before  # -1 stop halves the light, with no poll in between


async def test_unload_is_clean(hass: HomeAssistant, entry) -> None:
    assert await _setup(hass, entry)
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is entry.state.NOT_LOADED


# --------------------------------------------------------------------------------
# The DND enum — polarity, explicitly
# --------------------------------------------------------------------------------
#
# Brandon, 2026-08-13: "When in priority only it means I'm sleeping."
#
#   priority_only  ⇒ ASLEEP  ⇒ night mode, ambience OFF
#   off            ⇒ AWAKE   ⇒ normal mode, ambience allowed
#
# Getting this backwards is not a crash — it is a house that lights up when he goes to
# bed and goes dark when he gets up, with nothing in the log. It is also easy to invert
# while "tidying", so the polarity is pinned from both ends.

from .conftest import DND  # noqa: E402


async def _mode(hass, entry, dnd_state: str) -> str:
    hass.states.async_set(DND, dnd_state)
    await hass.async_block_till_done()
    await entry.runtime_data.coordinator.async_refresh()
    await hass.async_block_till_done()
    return hass.states.get("sensor.kitchen_mode").state


async def test_priority_only_means_asleep(hass: HomeAssistant, entry) -> None:
    assert await _setup(hass, entry)
    assert await _mode(hass, entry, "priority_only") == "night"


async def test_dnd_off_means_awake(hass: HomeAssistant, entry) -> None:
    assert await _setup(hass, entry)
    assert await _mode(hass, entry, "off") == "normal"


async def test_the_ambience_glow_ends_when_he_falls_asleep(hass: HomeAssistant, entry, world) -> None:
    """The user-visible consequence of the polarity, end to end."""
    world(lux=10.0, occupied=False)
    hass.config_entries.async_update_entry(
        entry, options={**entry.options, "ambience_level": 20, "night_level": 51}
    )
    assert await _setup(hass, entry)

    assert await _mode(hass, entry, "off") == "normal"
    assert int(hass.states.get("sensor.kitchen_target_level").state) == 20  # awake glow

    assert await _mode(hass, entry, "priority_only") == "night"
    assert int(hass.states.get("sensor.kitchen_target_level").state) == 0  # asleep, empty


async def test_alarms_only_and_total_silence_are_not_sleep(hass: HomeAssistant, entry) -> None:
    """He named priority_only specifically. The other two DND modes are daytime uses
    (a meeting, a call) and must not put the house to bed."""
    assert await _setup(hass, entry)
    assert await _mode(hass, entry, "alarms_only") == "normal"
    assert await _mode(hass, entry, "total_silence") == "normal"


async def test_an_unavailable_dnd_sensor_reads_as_awake(hass: HomeAssistant, entry) -> None:
    """A phone that drops off Wi-Fi must not put the house into night mode."""
    assert await _setup(hass, entry)
    assert await _mode(hass, entry, "unavailable") == "normal"


# --------------------------------------------------------------------------------
# Manual detection must ignore a z2m reconnect
# --------------------------------------------------------------------------------


async def test_a_reconnecting_bulb_is_not_a_human_touch(hass: HomeAssistant, entry, world) -> None:
    """A z2m reconnect drives a bulb unavailable -> on. Counting that as a touch parks
    the room in manual for the whole hold window every time the mesh hiccups."""
    world(light_on=True)
    assert await _setup(hass, entry)
    room = next(iter(entry.runtime_data.coordinator.rooms.values()))
    room.manual_touched = False

    attrs = {"min_color_temp_kelvin": 2702, "max_color_temp_kelvin": 6535}
    hass.states.async_set(LIGHT, "unavailable", attrs, context=Context())
    await hass.async_block_till_done()
    hass.states.async_set(LIGHT, "on", {**attrs, "brightness": 200}, context=Context())
    await hass.async_block_till_done()

    assert room.manual_touched is False


# --------------------------------------------------------------------------------
# The night LATCH — replayed against the measured 2026-08-13 DND sequence
# --------------------------------------------------------------------------------
#
#   22:49  priority_only   he goes to bed
#   05:59  off             HE GETS OUT OF BED  <- night must NOT end here
#   07:25  priority_only
#   07:58  off
#
# Night mode is latched: it starts on sleep and ends on the world's terms (outdoor lux,
# or the lead-in to his alarm), never on his posture.


async def test_night_latches_on_and_survives_him_getting_up(hass: HomeAssistant, entry, world) -> None:
    world(lux=1.0, occupied=True)
    assert await _setup(hass, entry)
    co = entry.runtime_data.coordinator

    assert await _mode(hass, entry, "priority_only") == "night"
    assert co._night_latched is True

    # 05:59 — he gets out of bed and the phone clears DND by itself.
    assert await _mode(hass, entry, "off") == "night", "night ended when he stood up"
    assert co._night_latched is True
    assert int(hass.states.get("sensor.kitchen_target_level").state) == co.house.night_level


async def test_night_ends_when_it_gets_light(hass: HomeAssistant, entry, world) -> None:
    world(lux=1.0)
    assert await _setup(hass, entry)
    co = entry.runtime_data.coordinator
    await _mode(hass, entry, "priority_only")
    await _mode(hass, entry, "off")
    assert co._night_latched is True

    # A 4 am summer sunrise: normal logic returns.
    world(lux=200.0)
    await hass.async_block_till_done()
    await co.async_refresh()
    await hass.async_block_till_done()
    assert hass.states.get("sensor.kitchen_mode").state == "normal"


async def test_night_survives_a_restart(hass: HomeAssistant, entry, world) -> None:
    """An HA restart at 3 am must not drop night mode and relight the house."""
    world(lux=1.0)
    assert await _setup(hass, entry)
    await _mode(hass, entry, "priority_only")
    await entry.runtime_data.coordinator.async_persist()

    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.runtime_data.coordinator._night_latched is True


async def test_a_normal_daytime_dnd_does_not_darken_the_house(hass: HomeAssistant, entry, world) -> None:
    """alarms_only in a bright house is a meeting, not bedtime."""
    world(lux=4000.0)
    assert await _setup(hass, entry)
    assert await _mode(hass, entry, "alarms_only") == "normal"
    assert entry.runtime_data.coordinator._night_latched is False


async def test_changing_an_entity_link_rebinds_the_listeners(hass: HomeAssistant, entry, world) -> None:
    """Configuring the sleep toggle AFTER setup must start watching it.

    Found live: the toggle was set from the options flow, stored correctly, and did
    nothing — because listeners were bound once at setup and nothing was watching it.
    """
    from custom_components.solace.const import CONF_SLEEP_TOGGLE

    world(lux=1.0)
    assert await _setup(hass, entry)
    hass.states.async_set("input_boolean.solace_sleep", "off")
    await hass.async_block_till_done()

    hass.config_entries.async_update_entry(
        entry, options={**entry.options, CONF_SLEEP_TOGGLE: "input_boolean.solace_sleep"}
    )
    await hass.async_block_till_done()

    # Now flip it — no coordinator tick, purely the state listener.
    hass.states.async_set("input_boolean.solace_sleep", "on")
    await hass.async_block_till_done()
    assert entry.runtime_data.coordinator._night_latched is True
    assert hass.states.get("sensor.kitchen_mode").state == "night"


async def test_the_lux_release_CLEARS_the_latch_not_just_masks_it(hass: HomeAssistant, entry, world) -> None:
    """Found live, the hard way.

    The first implementation kept `_night_latched` True and consulted a separate
    "released" flag per room. The latch therefore never cleared — so the next time it
    simply got dark, the house dropped back into night mode without him ever having gone
    to sleep. The test that caught it read `night` at dusk on a wide-awake house.
    """
    world(lux=1.0)
    assert await _setup(hass, entry)
    co = entry.runtime_data.coordinator

    await _mode(hass, entry, "priority_only")
    await _mode(hass, entry, "off")
    assert co._night_latched is True

    world(lux=200.0)                      # dawn
    await hass.async_block_till_done()
    await co.async_refresh()
    await hass.async_block_till_done()
    assert co._night_latched is False, "latch masked instead of cleared"

    world(lux=1.0)                        # dusk the same day — he has NOT gone to bed
    await hass.async_block_till_done()
    await co.async_refresh()
    await hass.async_block_till_done()
    assert co._night_latched is False
    assert hass.states.get("sensor.kitchen_mode").state == "normal"
