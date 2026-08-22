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

from custom_components.solace.const import DOMAIN, HOUSE_SETTINGS

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
    """Nothing is hardcoded: **every** tunable must be reachable from the UI.

    Keyed on ``unique_id``, not ``entity_id``. Two reasons, and the second one bit:

    1. It checks the whole table rather than a hand-picked six, so a new setting cannot
       be added without a control.
    2. ``entity_id`` is slugified from the *friendly name*, so renaming a setting's label
       moves it. ``unique_id`` is keyed on the setting key and does not — which is also
       why a rename does not strand the live house: HA keeps the existing entity_id for a
       known unique_id and only the displayed name changes.
    """
    from homeassistant.helpers import entity_registry as er

    assert await _setup(hass, entry)
    registry = er.async_get(hass)
    have = {
        e.unique_id
        for e in er.async_entries_for_config_entry(registry, entry.entry_id)
        if e.domain == "number"
    }
    missing = [
        s.key for s in HOUSE_SETTINGS if f"{entry.entry_id}_house_{s.key}" not in have
    ]
    assert not missing, f"settings with no number entity: {missing}"


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


async def test_daylight_switches_the_room_off_via_demand(hass: HomeAssistant, entry, world) -> None:
    """Full daylight ⇒ 0, and it is DEMAND that does it, not the ambience threshold.

    This used to pass at 400 lx because the 50/80 ambience pair was ANDed into normal
    lighting. It no longer is (2026-08-13), so the room stays lit at 400 lx and goes dark
    where the demand curve actually ends: lux_full + lux_window.
    """
    world(lux=400.0)
    assert await _setup(hass, entry)
    assert int(hass.states.get("sensor.kitchen_target_level").state) > 0

    world(lux=5000.0)
    await entry.runtime_data.coordinator.async_refresh()
    await hass.async_block_till_done()
    assert int(hass.states.get("sensor.kitchen_target_level").state) == 0


async def test_the_target_sensor_exposes_the_full_trace(hass: HomeAssistant, entry) -> None:
    """"Why is the kitchen at 97?" has to be answerable from the dashboard."""
    assert await _setup(hass, entry)
    state = hass.states.get("sensor.kitchen_target_level")
    per_light = state.attributes["per_light"][LIGHT]
    assert per_light["level"] == 161
    assert "demand" in per_light["trace"]
    assert "clamped" in per_light["trace"]


async def test_external_light_state_change_does_not_trip_manual_mode(
    hass: HomeAssistant, entry, world
) -> None:
    """Automatic manual detection is removed; external light changes do not engage manual mode."""
    world(light_on=True)
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
    assert room.manual_touched is False
    assert room.manual_switch is False
    assert hass.states.get("binary_sensor.kitchen_manual_active").state == "off"


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
# Owner, 2026-08-13: "When in priority only it means I'm sleeping."
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
# The night LATCH — replayed against a real, measured DND sequence
# --------------------------------------------------------------------------------
#
# The shape that matters, taken from 72 h of a real phone's DND sensor:
#
#   late evening   priority_only   goes to bed
#   early morning  off             GETS OUT OF BED  <- night must NOT end here
#   shortly after  priority_only   back to bed
#   later          off             up for the day
#
# Night mode is latched: it starts on sleep and ends on the world's terms (outdoor lux,
# or the lead-in to the next alarm), never on the sleeper's posture. A phone's DND clears
# the moment someone stands up, so "night = DND is on right now" relights the house at
# full demand on a 3 am trip to the bathroom.


async def test_night_latches_on_and_survives_getting_up(hass: HomeAssistant, entry, world) -> None:
    world(lux=1.0, occupied=True)
    assert await _setup(hass, entry)
    co = entry.runtime_data.coordinator

    assert await _mode(hass, entry, "priority_only") == "night"
    assert co._night_latched is True

    # Early morning — they get out of bed and the phone clears DND by itself.
    assert await _mode(hass, entry, "off") == "night", "night ended when they stood up"
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


async def test_dragging_a_setting_uses_the_tuning_transition(
    hass: HomeAssistant, entry, world
) -> None:
    """⚠️ Regression. `transition_setting_s` existed, was documented as the fourth
    transition, and was wired to nothing but the manual slider — so moving a house
    setting produced a 10-second fade per drag step, which is the exact "unusable" case
    the brief names when it asks for four speeds.
    """
    world(light_on=True)
    assert await _setup(hass, entry)

    calls: list[dict] = []
    hass.bus.async_listen(
        "call_service",
        lambda e: calls.append(e.data) if e.data.get("domain") == "light" else None,
    )

    # Move a house setting the way the panel does — through the config entry, which is
    # what fires clock 1.
    hass.config_entries.async_update_entry(
        entry, options={**entry.options, "bias_stops": -1.5}
    )
    await hass.async_block_till_done()

    turn_ons = [c for c in calls if c["service"] == "turn_on"]
    assert turn_ons, "the settings change produced no write at all"
    house = entry.runtime_data.coordinator.house
    assert turn_ons[-1]["service_data"]["transition"] == house.transition_manual_s

    # And the tuning flag is one tick only — the next ordinary tick must not snap.
    assert entry.runtime_data.coordinator._tuning is False


async def test_walking_into_an_ambient_room_uses_the_occupancy_transition(
    hass: HomeAssistant, entry, world
) -> None:
    """⚠️ Regression, found 2026-08-16 from the live house.

    `_async_apply_light` wrote `room.last_source[entity_id] = solution.source` and then
    read it straight back into `last_src`. The two were therefore always equal, so every
    "what changed" arm of the transition ladder — ambience→demand, demand→diminish,
    diminish→ambience — was unreachable and all of them fell through to
    `transition_automatic_s`.

    On the live house that meant walking into a room already lit at its ambience floor
    asked for a 300 s fade instead of a 2 s one. The lights *were* moving; they were
    moving so slowly it read as the automation being dead. It only looked fixed when a
    setting was dragged, because that path takes the separate `_tuning` branch.

    Nothing covered this: every existing transition test starts from an OFF bulb, which
    takes the `was_off` branch above the ladder and never consults `last_src` at all.
    """
    # Dark and EMPTY: the room settles on its ambience floor with source "ambience".
    world(lux=10.0, occupied=False, light_on=True)
    hass.config_entries.async_update_entry(
        entry, options={**entry.options, "ambience_level": 20, "ambience_ignores_occupancy": True}
    )
    assert await _setup(hass, entry)

    coordinator = entry.runtime_data.coordinator
    room = next(iter(coordinator.rooms.values()))
    assert room.last_source.get(LIGHT) == "ambience", (
        f"precondition failed — room is not resting on ambience "
        f"(source={room.last_source.get(LIGHT)!r})"
    )

    calls: list[dict] = []
    hass.bus.async_listen(
        "call_service",
        lambda e: calls.append(e.data) if e.data.get("domain") == "light" else None,
    )

    # Now walk in. Presence flips, clock 1 fires, and the light must step up briskly.
    world(lux=10.0, occupied=True, light_on=True)
    await hass.async_block_till_done()

    turn_ons = [c for c in calls if c["service"] == "turn_on"]
    assert turn_ons, "entering the room produced no write at all"

    house = coordinator.house
    got = turn_ons[-1]["service_data"]["transition"]
    assert got == house.transition_up_occupancy_s, (
        f"ambience→demand used {got}s; expected the occupancy transition "
        f"{house.transition_up_occupancy_s}s, not the tracking fade "
        f"{house.transition_automatic_s}s"
    )
    assert room.last_source.get(LIGHT) == "demand"


async def test_a_settings_change_rebinds_listeners_without_accumulating_them(
    hass: HomeAssistant, entry
) -> None:
    """Changing a setting must re-derive the clocks, and must not leave the old ones running.

    Both halves have bitten this codebase. Re-binding is why the sleep toggle stopped
    being silently dead. Tearing down first is what stops a slider drag from leaving a
    second colour ticker behind — twenty drags would mean twenty writers on one bulb,
    which is the exact contamination that invalidated a night of hardware measurements.
    """
    assert await _setup(hass, entry)
    coordinator = entry.runtime_data.coordinator
    before = len(coordinator._unsubscribes)
    assert before, "nothing is listening at all"

    for _ in range(5):
        coordinator.async_resubscribe()
    assert len(coordinator._unsubscribes) == before


async def test_the_colour_clock_interval(hass: HomeAssistant, entry) -> None:
    """The colour interval provides regular periodic hardware transition updates."""
    assert await _setup(hass, entry)
    coordinator = entry.runtime_data.coordinator
    assert coordinator._colour_interval() == 600.0


async def test_a_stale_alarm_does_not_unlatch_night_mode(hass: HomeAssistant, entry) -> None:
    """⚠️ THE 3 AM BLASTER. Verified against the live sensor's own history: the phone
    only republishes `next_alarm` after an alarm fires, so on a night with no alarm set
    it holds yesterday's time. Unbounded, `_alarm_released` is then True forever — the
    latch engages when he falls asleep and is released on the very next tick, and the
    house lights at full demand the moment he gets up in the dark.
    """
    from custom_components.solace.const import CONF_ALARM_ENTITY

    hass.states.async_set("sensor.next_alarm", "2020-01-01T06:00:00+00:00")
    hass.config_entries.async_update_entry(
        entry, options={**entry.options, CONF_ALARM_ENTITY: "sensor.next_alarm"}
    )
    assert await _setup(hass, entry)
    coordinator = entry.runtime_data.coordinator

    coordinator._update_night_latch(asleep=True, lux=0.0, house=coordinator.house)
    assert coordinator._night_active() is True

    coordinator._update_night_latch(asleep=False, lux=0.0, house=coordinator.house)
    assert coordinator._night_active() is True, "a stale alarm unlatched night mode"


async def test_a_real_upcoming_alarm_still_ends_night_mode(hass: HomeAssistant, entry) -> None:
    """The bound must not break the feature it is protecting."""
    from datetime import timedelta

    from homeassistant.util import dt as dt_util

    from custom_components.solace.const import CONF_ALARM_ENTITY

    soon = dt_util.utcnow() + timedelta(minutes=10)
    hass.states.async_set("sensor.next_alarm", soon.isoformat())
    hass.config_entries.async_update_entry(
        entry, options={**entry.options, CONF_ALARM_ENTITY: "sensor.next_alarm"}
    )
    assert await _setup(hass, entry)
    coordinator = entry.runtime_data.coordinator

    coordinator._update_night_latch(asleep=True, lux=0.0, house=coordinator.house)
    coordinator._update_night_latch(asleep=False, lux=0.0, house=coordinator.house)
    assert coordinator._night_active() is False, "the alarm lead-in stopped working"


async def test_sleep_toggle_clears_automatically_at_dawn(hass: HomeAssistant, entry, world) -> None:
    """Manual sleep toggle must be auto-cleared when dawn arrives so daylight is not trapped in night mode."""
    from custom_components.solace.const import CONF_SLEEP_TOGGLE

    world(lux=0.0)
    hass.states.async_set("input_boolean.solace_sleep", "on")
    hass.config_entries.async_update_entry(
        entry, options={**entry.options, CONF_SLEEP_TOGGLE: "input_boolean.solace_sleep"}
    )
    assert await _setup(hass, entry)
    coordinator = entry.runtime_data.coordinator
    assert coordinator._night_active() is True

    # Sunrise arrives (1000 lx) -> latch must release and sleep toggle auto-turn off
    coordinator._update_night_latch(asleep=True, lux=1000.0, house=coordinator.house)
    await hass.async_block_till_done()
    assert coordinator._night_active() is False


async def test_away_mode_triggers_instant_shutoff(hass: HomeAssistant, entry, world) -> None:
    """Arming away_mode shuts off all rooms immediately."""
    from custom_components.solace.const import CONF_AWAY_ENTITY

    world(lux=5.0)
    hass.states.async_set("input_boolean.away_mode", "off")
    hass.config_entries.async_update_entry(
        entry, options={**entry.options, CONF_AWAY_ENTITY: "input_boolean.away_mode"}
    )
    assert await _setup(hass, entry)

    # Arm away
    hass.states.async_set("input_boolean.away_mode", "on")
    await hass.async_block_till_done()
    coordinator = entry.runtime_data.coordinator
    assert coordinator._away() is True


async def test_watch_bedtime_mode_engages_sleep(hass: HomeAssistant, entry, world) -> None:
    """Pixel Watch bedtime mode sensor is detected as asleep."""
    world(lux=1.0)
    hass.states.async_set("binary_sensor.google_pixel_watch_2_bedtime_mode", "off")
    assert await _setup(hass, entry)
    coordinator = entry.runtime_data.coordinator
    assert coordinator._dnd() is False

    hass.states.async_set("binary_sensor.google_pixel_watch_2_bedtime_mode", "on")
    assert coordinator._dnd() is True


async def test_remote_dispatcher_executes_actions(hass: HomeAssistant, entry, world) -> None:
    """Remote actions (nudge, toggle) execute directly from Zigbee sensor states."""
    from custom_components.solace.const import CONF_REMOTES

    assert await _setup(hass, entry)
    coordinator = entry.runtime_data.coordinator
    subentry = next(iter(entry.subentries.values()))
    initial_bias = float(subentry.data.get("bias_stops", 0.0))

    # Send action event via sensor.kitchen_control_action
    hass.states.async_set("sensor.kitchen_control_action", "brightness_move_up")
    await hass.async_block_till_done()

    new_bias = float(entry.subentries[subentry.subentry_id].data.get("bias_stops", 0.0))
    assert new_bias == initial_bias + 0.5


async def test_work_mode_overrides_office_lights_and_auto_clears(hass: HomeAssistant, entry, world) -> None:
    """Work mode overrides office lights with manual levels and auto-clears on sleep."""
    world(lux=50.0)
    await async_setup_component(hass, "input_boolean", {"input_boolean": {"work_mode": None}})
    hass.states.async_set("input_boolean.work_mode", "off")
    hass.states.async_set("binary_sensor.living_presence_occupancy", "on")
    assert await _setup(hass, entry)
    coordinator = entry.runtime_data.coordinator
    assert coordinator._work_mode() is False

    # Turn on Work Mode
    hass.states.async_set("input_boolean.work_mode", "on")
    await hass.async_block_till_done()
    assert coordinator._work_mode() is True

    # Test auto-clearing on night mode / sleep
    coordinator._clear_work_mode()
    await hass.async_block_till_done()
    assert hass.states.get("input_boolean.work_mode").state == "off"


async def test_occupied_room_turning_on_due_to_falling_lux_uses_automatic_transition(
    hass: HomeAssistant, entry, world
) -> None:
    """When a room is already occupied during daytime and lights turn on from 0 due to

    falling lux, use transition_automatic_s (slow continuous glide), not
    transition_up_occupancy_s (which is for freshly entering the room).
    """
    # 1. Daytime + occupied: lights are off due to full daylight demand = 0.
    world(lux=5000.0, occupied=True, light_on=False)
    assert await _setup(hass, entry)
    coordinator = entry.runtime_data.coordinator
    room = next(iter(coordinator.rooms.values()))
    assert room.occupied is True
    assert room.fresh_occupancy is True  # initial tick set it

    # 2. Advance to next tick: room is still occupied, fresh_occupancy clears to False.
    world(lux=5000.0, occupied=True, light_on=False)
    await coordinator.async_refresh()
    await hass.async_block_till_done()
    assert room.occupied is True
    assert room.fresh_occupancy is False

    calls: list[dict] = []
    hass.bus.async_listen(
        "call_service",
        lambda e: calls.append(e.data) if e.data.get("domain") == "light" else None,
    )

    # 3. Outdoor lux falls to 10 lx. Demand rises, turning the light on from 0.
    world(lux=10.0, occupied=True, light_on=False)
    await coordinator.async_refresh()
    await hass.async_block_till_done()

    turn_ons = [c for c in calls if c["service"] == "turn_on"]
    assert turn_ons, "Solace never wrote to the light on lux drop"
    got = turn_ons[-1]["service_data"]["transition"]
    assert got == coordinator.house.transition_automatic_s, (
        f"lux drop while occupied used {got}s; expected transition_automatic_s "
        f"({coordinator.house.transition_automatic_s}s)"
    )


async def test_fresh_occupancy_turning_on_from_off_uses_occupancy_transition(
    hass: HomeAssistant, entry, world
) -> None:
    """Entering a dark unoccupied room uses the fast transition_up_occupancy_s."""
    # 1. Dark + unoccupied: lights are off (ambience level is 0).
    world(lux=10.0, occupied=False, light_on=False)
    assert await _setup(hass, entry)
    coordinator = entry.runtime_data.coordinator
    room = next(iter(coordinator.rooms.values()))
    assert room.occupied is False

    calls: list[dict] = []
    hass.bus.async_listen(
        "call_service",
        lambda e: calls.append(e.data) if e.data.get("domain") == "light" else None,
    )

    # 2. Walk in: presence becomes True.
    world(lux=10.0, occupied=True, light_on=False)
    await coordinator.async_refresh()
    await hass.async_block_till_done()

    turn_ons = [c for c in calls if c["service"] == "turn_on"]
    assert turn_ons, "entering dark room never wrote to light"
    got = turn_ons[-1]["service_data"]["transition"]
    assert got == coordinator.house.transition_up_occupancy_s, (
        f"fresh occupancy used {got}s; expected transition_up_occupancy_s "
        f"({coordinator.house.transition_up_occupancy_s}s)"
    )


async def test_dnd_sensor_in_entry_data_is_subscribed_and_engages_night_mode(
    hass: HomeAssistant, entry, world
) -> None:
    """Phone DND sensor configured in entry.data must be subscribed and latch night mode on priority_only."""
    from custom_components.solace.const import CONF_DND_ENTITY

    hass.config_entries.async_update_entry(
        entry,
        data={**entry.data, CONF_DND_ENTITY: "sensor.pixel_8a_do_not_disturb_sensor"},
        options={k: v for k, v in entry.options.items() if k != CONF_DND_ENTITY},
    )
    hass.states.async_set("sensor.pixel_8a_do_not_disturb_sensor", "off")
    world(lux=5.0, occupied=True, light_on=True)

    assert await _setup(hass, entry)
    coordinator = entry.runtime_data.coordinator
    assert coordinator._phone_dnd() is False
    assert coordinator._night_latched is False

    # Simulate Pixel 8a switching to priority_only (event triggers _on_world_change).
    hass.states.async_set("sensor.pixel_8a_do_not_disturb_sensor", "priority_only")
    await hass.async_block_till_done()

    assert coordinator._phone_dnd() is True
    assert coordinator._night_latched is True




