"""The panel's data contract.

The panel is a single page that has to show *everything the engine is doing right now*
— per-room demand, settled level, per-light trace, the gate, the colour target — and
write back to three different stores (config entry options, room subentry data, and the
per-light block inside that data). Reading that off entity states would mean the panel
reverse-engineering `sensor.*_target`'s attribute blob and guessing which `number.*`
maps to which setting.

So: one snapshot command, one subscription, and four typed setters. The snapshot is the
**same shape** the panel renders, which is what keeps the "render the consequence beside
the control" rule cheap — every consequence is already computed here by the engine that
will actually run it, not re-derived in TypeScript.

⚠️ Writes go through the same paths the `number` entities use
(``async_update_entry`` / ``async_update_subentry``), never straight into
``.storage``. That is what makes clock 1 fire: the entry update listener refreshes the
coordinator immediately, so a slider takes effect *now*.
"""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.util import dt as dt_util

from .colour import resolve_colour
from .const import (
    CONF_ALARM_ENTITY,
    CONF_DND_ENTITY,
    CONF_LIGHTS,
    CONF_LUX_SENSOR,
    CONF_NEAR_PRESENCE,
    CONF_PER_LIGHT,
    CONF_PRESENCE,
    CONF_RAMP,
    CONF_SLEEP_TOGGLE,
    CONF_ZONES,
    DOMAIN,
    HOUSE_DEFAULTS,
    HOUSE_SETTINGS,
    ROOM_DEFAULTS,
    ROOM_SETTINGS,
    SUBENTRY_TYPE_ROOM,
    Setting,
)
from .coordinator import SolaceConfigEntry, SolaceCoordinator
from .models import Family

_LOGGER = logging.getLogger(__name__)

HOUSE_KEYS = {s.key for s in HOUSE_SETTINGS}
ROOM_KEYS = {s.key for s in ROOM_SETTINGS}
LIGHT_KEYS = {"bias_stops", "clamp_min", "clamp_max"}


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register every command. Idempotent — HA tolerates a repeat registration."""
    websocket_api.async_register_command(hass, ws_get)
    websocket_api.async_register_command(hass, ws_subscribe)
    websocket_api.async_register_command(hass, ws_set_house)
    websocket_api.async_register_command(hass, ws_set_ramp)
    websocket_api.async_register_command(hass, ws_set_room)
    websocket_api.async_register_command(hass, ws_set_light)
    websocket_api.async_register_command(hass, ws_room_action)
    websocket_api.async_register_command(hass, ws_set_zones)
    websocket_api.async_register_command(hass, ws_merge_areas)


# ---------------------------------------------------------------------------- helpers


def _entry(hass: HomeAssistant) -> SolaceConfigEntry | None:
    for entry in hass.config_entries.async_entries(DOMAIN):
        if getattr(entry, "runtime_data", None) is not None:
            return entry
    return None


def _schema_row(setting: Setting) -> dict[str, Any]:
    return {
        "key": setting.key,
        "name": setting.name,
        "min": setting.minimum,
        "max": setting.maximum,
        "step": setting.step,
        "default": setting.default,
        "unit": setting.unit,
        "icon": setting.icon,
    }


def _friendly(hass: HomeAssistant, entity_id: str) -> str:
    state = hass.states.get(entity_id)
    if state is None:
        return entity_id
    return state.attributes.get("friendly_name") or entity_id


def _hour(value: Any) -> float | None:
    """Parse an ISO timestamp into a local decimal clock hour."""
    parsed = dt_util.parse_datetime(value) if value else None
    if parsed is None:
        return None
    local = dt_util.as_local(parsed)
    return local.hour + local.minute / 60.0


def _snapshot(hass: HomeAssistant, coordinator: SolaceCoordinator) -> dict[str, Any]:
    """Everything the panel renders, in one object."""
    entry = coordinator.config_entry
    house = coordinator.house
    options = {**HOUSE_DEFAULTS, **entry.options}
    now = dt_util.now()
    clock_hour = now.hour + now.minute / 60.0
    dusk_hour = coordinator._dusk_hour()  # noqa: SLF001 — same package, no public alias

    sun = hass.states.get("sun.sun")
    sun_attrs = sun.attributes if sun else {}

    from .models import LightSettings

    house_colour = resolve_colour(
        clock_hour, dusk_hour, house, LightSettings(min_kelvin=1000, max_kelvin=20000)
    )

    rooms: list[dict[str, Any]] = []
    for subentry in entry.subentries.values():
        if subentry.subentry_type != SUBENTRY_TYPE_ROOM:
            continue
        state = coordinator.rooms.get(subentry.subentry_id)
        settings = coordinator.room_settings(subentry)
        per_light = subentry.data.get(CONF_PER_LIGHT) or {}

        zones_raw = list(subentry.data.get(CONF_ZONES) or [])
        zone_of = {
            light_id: z.get("zone_id")
            for z in zones_raw
            for light_id in (z.get("lights") or [])
        }

        lights: list[dict[str, Any]] = []
        for entity_id in subentry.data.get(CONF_LIGHTS, []):
            light = coordinator.light_settings(entity_id, subentry)
            overrides = per_light.get(entity_id, {})
            solution = state.solutions.get(entity_id) if state else None
            live = hass.states.get(entity_id)
            members = (live.attributes.get("entity_id") if live else None) or []
            colour = resolve_colour(clock_hour, dusk_hour, house, light)
            lights.append(
                {
                    "entity_id": entity_id,
                    "name": _friendly(hass, entity_id),
                    "zone_id": zone_of.get(entity_id),
                    "available": live is not None and live.state not in ("unavailable", "unknown"),
                    "group_size": len(members) if isinstance(members, (list, tuple)) else 0,
                    "family": light.family.value,
                    "bias_stops": float(overrides.get("bias_stops", 0.0)),
                    # None, not 0/254 — the handoff draws an em-dash for "unset" and a
                    # bordered box for "set", and 0/254 are legitimate *set* values.
                    "clamp_min": overrides.get("clamp_min"),
                    "clamp_max": overrides.get("clamp_max"),
                    "min_kelvin": light.min_kelvin,
                    "max_kelvin": light.max_kelvin,
                    "kelvin": colour.kelvin,
                    "kelvin_clamped": colour.was_clamped,
                    "level": solution.level if solution else None,
                    "stops": round(solution.stops, 3) if solution else None,
                    "trace": dict(solution.trace) if solution else {},
                    "current_level": int((live.attributes.get("brightness") or 0)) if live else 0,
                    "is_on": bool(live and live.state == "on"),
                }
            )

        hold = settings.manual_hold_minutes
        manual_active = bool(
            state and state.is_manual(hold, dt_util.utcnow().timestamp())
        )
        remaining = None
        if state and state.manual_touched and state.manual_since and not state.manual_switch:
            remaining = max(
                0, int(hold * 60 - (dt_util.utcnow().timestamp() - state.manual_since))
            )

        first = next(iter(state.solutions.values()), None) if state and state.solutions else None
        rooms.append(
            {
                "subentry_id": subentry.subentry_id,
                "name": subentry.title,
                "settings": {
                    **{key: subentry.data.get(key, ROOM_DEFAULTS[key]) for key in ROOM_KEYS},
                    "night_off": bool(subentry.data.get("night_off", False)),
                },
                "presence": subentry.data.get(CONF_PRESENCE) or [],
                "near_presence": subentry.data.get(CONF_NEAR_PRESENCE) or [],
                "occupied": coordinator._any_on(  # noqa: SLF001
                    subentry.data.get(CONF_PRESENCE), default=True
                ),
                "near_clear": not coordinator._any_on(  # noqa: SLF001
                    subentry.data.get(CONF_NEAR_PRESENCE), default=True
                ),
                "has_near": bool(subentry.data.get(CONF_NEAR_PRESENCE)),
                "gate_open": bool(state.gate_open) if state else False,
                "demand": round(first.demand, 4) if first else None,
                "stops": round(first.stops, 3) if first else None,
                "mode": first.mode.value if first else None,
                "level": max((s.level for s in state.solutions.values()), default=None)
                if state and state.solutions
                else None,
                "manual": {
                    "active": manual_active,
                    "switch": bool(state.manual_switch) if state else False,
                    "touched": bool(state.manual_touched) if state else False,
                    "remaining_s": remaining,
                    "hold_minutes": hold,
                },
                "lights": lights,
                "zones": [
                    {
                        "zone_id": z.get("zone_id"),
                        "name": z.get("name"),
                        "lights": list(z.get("lights") or []),
                        "presence": list(z.get("presence") or []),
                        "bias_stops": float(z.get("bias_stops", 0.0)),
                        "diminish_pct": float(z.get("diminish_pct", 0.0)),
                        # Live state, so the panel can show clear/occupied per zone.
                        "clear": not coordinator._any_on(  # noqa: SLF001
                            z.get("presence"), default=True
                        )
                        if z.get("presence")
                        else None,
                    }
                    for z in zones_raw
                ],
            }
        )

    return {
        "entry_id": entry.entry_id,
        "house": {key: options.get(key, HOUSE_DEFAULTS[key]) for key in HOUSE_KEYS},
        "ramp": [
            {"hour": point.hour, "stops": point.stops} for point in house.ramp
        ],
        "house_schema": [_schema_row(s) for s in HOUSE_SETTINGS],
        "room_schema": [_schema_row(s) for s in ROOM_SETTINGS],
        "links": {
            key: entry.options.get(key) or entry.data.get(key)
            for key in (CONF_LUX_SENSOR, CONF_DND_ENTITY, CONF_SLEEP_TOGGLE, CONF_ALARM_ENTITY)
        },
        "world": {
            "lux": coordinator._lux(),  # noqa: SLF001
            "clock_hour": round(clock_hour, 4),
            "dusk_hour": round(dusk_hour, 4),
            "sunrise_hour": _hour(sun_attrs.get("next_rising")),
            "sunset_hour": _hour(sun_attrs.get("next_setting")),
            "elevation": sun_attrs.get("elevation"),
            "kelvin": house_colour.kelvin,
            "asleep": coordinator._asleep(),  # noqa: SLF001
            "night_active": coordinator._night_active(),  # noqa: SLF001
            "latitude": hass.config.latitude,
            # Longitude and the timezone NAME are both needed by the year chart, not just
            # latitude: a crossing computed from solar geometry is in *solar* time, and
            # turning that into a clock time needs the longitude offset, the equation of
            # time, and the zone's DST rules for that day. Without them the chart was
            # nearly two hours early and put "lighting starts" before sunset.
            "longitude": hass.config.longitude,
            "time_zone": str(hass.config.time_zone),
            "year": now.year,
            "day_of_year": now.timetuple().tm_yday,
            "updated_at": coordinator.last_tick.isoformat() if coordinator.last_tick else None,
            "interval_s": coordinator.update_interval.total_seconds()
            if coordinator.update_interval
            else None,
            "healthy": coordinator.last_update_success,
        },
        # How each family present in the house walks the colour curve. Families sharing
        # one clock take different-sized steps, and without this the panel would show a
        # single "colour step size" that is true for none of them.
        "fade": {
            "interval_s": round(coordinator._colour_interval(), 1),  # noqa: SLF001
            "families": [
                {
                    "family": family.value,
                    "count": count,
                    "step_mired": profile.step_mired,
                    "max_step_mired": profile.max_step_mired,
                    "step_transition_s": profile.step_transition_s,
                    "concurrent": profile.concurrent,
                    "reason": profile.reason,
                }
                for family, count, profile in _families_present(coordinator, rooms)
            ],
        },
        "rooms": rooms,
    }


def _families_present(
    coordinator: SolaceCoordinator, rooms: list[dict[str, Any]]
) -> list[tuple[Family, int, Any]]:
    """Families actually installed, in a stable order, with their fade profile.

    Derived from the live lights rather than listed — the same reason ``infer_family``
    reads the registry: a hand-maintained count of "5 IKEA bulbs" already went stale once
    in this house and quietly excluded a bulb.
    """
    counts: dict[Family, int] = {}
    for room in rooms:
        for light in room["lights"]:
            family = Family(light["family"])
            counts[family] = counts.get(family, 0) + 1
    return [
        (family, counts[family], coordinator.fade_profile_for(family))
        for family in Family
        if family in counts
    ]


# ---------------------------------------------------------------------------- commands


@websocket_api.websocket_command({vol.Required("type"): "solace/get"})
@websocket_api.async_response
async def ws_get(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    entry = _entry(hass)
    if entry is None:
        connection.send_error(msg["id"], "not_loaded", "Solace is not set up")
        return
    connection.send_result(msg["id"], _snapshot(hass, entry.runtime_data.coordinator))


@websocket_api.websocket_command({vol.Required("type"): "solace/subscribe"})
@callback
def ws_subscribe(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """Push a fresh snapshot every time the coordinator finishes a tick.

    The panel could poll, but the whole point of clock 1 is that a change is visible
    *now*; a polling panel would reintroduce the 30-second lag from the other end.
    """
    entry = _entry(hass)
    if entry is None:
        connection.send_error(msg["id"], "not_loaded", "Solace is not set up")
        return
    coordinator = entry.runtime_data.coordinator

    @callback
    def _push() -> None:
        connection.send_message(
            websocket_api.event_message(msg["id"], _snapshot(hass, coordinator))
        )

    connection.subscriptions[msg["id"]] = coordinator.async_add_listener(_push)
    connection.send_result(msg["id"])
    _push()


@websocket_api.websocket_command(
    {
        vol.Required("type"): "solace/set_house",
        vol.Required("values"): {cv.string: vol.Any(float, int, str, None)},
    }
)
@websocket_api.async_response
async def ws_set_house(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    entry = _entry(hass)
    if entry is None:
        connection.send_error(msg["id"], "not_loaded", "Solace is not set up")
        return
    # Reject unknown keys rather than silently storing junk in the entry — an options
    # dict is also what `HouseSettings` is built from, and a stray key there is a
    # TypeError at the next tick, i.e. the whole engine stops.
    unknown = set(msg["values"]) - HOUSE_KEYS
    if unknown:
        connection.send_error(msg["id"], "unknown_key", f"unknown settings: {sorted(unknown)}")
        return
    hass.config_entries.async_update_entry(
        entry, options={**entry.options, **msg["values"]}
    )
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): "solace/set_ramp",
        vol.Required("ramp"): [
            {vol.Required("hour"): vol.Coerce(float), vol.Required("stops"): vol.Coerce(float)}
        ],
    }
)
@websocket_api.async_response
async def ws_set_ramp(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """The evening ramp — an ordered list of N points, never two fixed phases.

    Sorted on write so the engine never has to defend against an out-of-order list, and
    so dragging a point past its neighbour in the panel does the obvious thing.
    """
    entry = _entry(hass)
    if entry is None:
        connection.send_error(msg["id"], "not_loaded", "Solace is not set up")
        return
    ramp = sorted(
        ({"hour": p["hour"] % 24.0, "stops": p["stops"]} for p in msg["ramp"]),
        key=lambda p: (p["hour"] - 18.0) % 24.0,
    )
    hass.config_entries.async_update_entry(entry, options={**entry.options, CONF_RAMP: ramp})
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): "solace/set_room",
        vol.Required("subentry_id"): cv.string,
        vol.Required("values"): {cv.string: vol.Any(float, int, bool, str, None)},
    }
)
@websocket_api.async_response
async def ws_set_room(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    entry = _entry(hass)
    if entry is None:
        connection.send_error(msg["id"], "not_loaded", "Solace is not set up")
        return
    subentry = entry.subentries.get(msg["subentry_id"])
    if subentry is None:
        connection.send_error(msg["id"], "unknown_room", "no such room")
        return
    unknown = set(msg["values"]) - ROOM_KEYS - {"night_off"}
    if unknown:
        connection.send_error(msg["id"], "unknown_key", f"unknown settings: {sorted(unknown)}")
        return
    hass.config_entries.async_update_subentry(
        entry, subentry, data={**subentry.data, **msg["values"]}
    )
    await entry.runtime_data.coordinator.async_request_refresh()
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): "solace/set_light",
        vol.Required("subentry_id"): cv.string,
        vol.Required("entity_id"): cv.entity_id,
        vol.Required("values"): {cv.string: vol.Any(float, int, None)},
    }
)
@websocket_api.async_response
async def ws_set_light(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """Per-light overrides live inside the room's subentry, under ``per_light``."""
    entry = _entry(hass)
    if entry is None:
        connection.send_error(msg["id"], "not_loaded", "Solace is not set up")
        return
    subentry = entry.subentries.get(msg["subentry_id"])
    if subentry is None:
        connection.send_error(msg["id"], "unknown_room", "no such room")
        return
    unknown = set(msg["values"]) - LIGHT_KEYS
    if unknown:
        connection.send_error(msg["id"], "unknown_key", f"unknown settings: {sorted(unknown)}")
        return

    per_light = {k: dict(v) for k, v in (subentry.data.get(CONF_PER_LIGHT) or {}).items()}
    block = per_light.setdefault(msg["entity_id"], {})
    for key, value in msg["values"].items():
        if value is None:
            # Clearing a clamp means "unset", and unset is the neutral value the engine
            # already treats as no-op — not a stored 0, which would be a real floor.
            block.pop(key, None)
            if key == "clamp_min":
                block.pop("clamp_min", None)
        else:
            block[key] = int(value) if key.startswith("clamp") else float(value)

    hass.config_entries.async_update_subentry(
        entry, subentry, data={**subentry.data, CONF_PER_LIGHT: per_light}
    )
    await entry.runtime_data.coordinator.async_request_refresh()
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): "solace/room_action",
        vol.Required("subentry_id"): cv.string,
        vol.Required("action"): vol.In(["manual", "auto", "level"]),
        vol.Optional("level"): vol.All(vol.Coerce(int), vol.Range(min=0, max=254)),
    }
)
@websocket_api.async_response
async def ws_room_action(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """Manual/auto and the manual level — per **room**, which is the settled decision."""
    entry = _entry(hass)
    if entry is None:
        connection.send_error(msg["id"], "not_loaded", "Solace is not set up")
        return
    coordinator = entry.runtime_data.coordinator
    subentry = entry.subentries.get(msg["subentry_id"])
    room = coordinator.rooms.get(msg["subentry_id"])
    if subentry is None or room is None:
        connection.send_error(msg["id"], "unknown_room", "no such room")
        return

    action = msg["action"]
    if action == "manual":
        room.manual_switch = True
    elif action == "auto":
        # "Resume now" clears the touch timer as well as the switch — otherwise a stale
        # touch keeps holding the room and the button looks like it did nothing.
        room.manual_switch = False
        room.manual_touched = False
        room.manual_since = None
    else:
        level = msg.get("level", 0)
        room.manual_touched = True
        room.manual_since = dt_util.utcnow().timestamp()
        house = coordinator.house
        for entity_id in subentry.data.get(CONF_LIGHTS, []):
            if level <= 0:
                await coordinator.writer.async_turn_off(entity_id, house.transition_off_s)
            else:
                # The setting-change transition — this fires while the slider is being
                # dragged, so a long glide here is unusable.
                await coordinator.writer.async_set_brightness(
                    entity_id, int(level), house.transition_setting_s
                )

    await coordinator.async_persist()
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): "solace/set_zones",
        vol.Required("subentry_id"): cv.string,
        vol.Required("zones"): [
            {
                vol.Required("zone_id"): cv.string,
                vol.Required("name"): cv.string,
                vol.Optional("lights", default=[]): [cv.entity_id],
                vol.Optional("presence", default=[]): [cv.entity_id],
                vol.Optional("bias_stops", default=0.0): vol.Coerce(float),
                vol.Optional("diminish_pct", default=0.0): vol.All(
                    vol.Coerce(float), vol.Range(min=0, max=100)
                ),
            }
        ],
    }
)
@websocket_api.async_response
async def ws_set_zones(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """Replace an area's zone list.

    ⚠️ Every light in the area must belong to exactly one zone, and every zone light must
    be in the area. An unassigned light silently falls back to the *area's* zone bias,
    which looks like the zone dial not working — so it is rejected here rather than
    debugged later.
    """
    entry = _entry(hass)
    if entry is None:
        connection.send_error(msg["id"], "not_loaded", "Solace is not set up")
        return
    subentry = entry.subentries.get(msg["subentry_id"])
    if subentry is None:
        connection.send_error(msg["id"], "unknown_room", "no such area")
        return

    area_lights = set(subentry.data.get(CONF_LIGHTS) or [])
    assigned: list[str] = [l for z in msg["zones"] for l in z["lights"]]
    duplicated = {l for l in assigned if assigned.count(l) > 1}
    if duplicated:
        connection.send_error(
            msg["id"], "duplicate_light", f"in more than one zone: {sorted(duplicated)}"
        )
        return
    stray = set(assigned) - area_lights
    if stray:
        connection.send_error(
            msg["id"], "stray_light", f"not in this area: {sorted(stray)}"
        )
        return
    ids = [z["zone_id"] for z in msg["zones"]]
    if len(set(ids)) != len(ids):
        connection.send_error(msg["id"], "duplicate_zone", "zone ids must be unique")
        return

    hass.config_entries.async_update_subentry(
        entry, subentry, data={**subentry.data, CONF_ZONES: msg["zones"]}
    )
    await entry.runtime_data.coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"unassigned": sorted(area_lights - set(assigned))})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "solace/merge_areas",
        vol.Required("into"): cv.string,
        vol.Required("subentry_ids"): [cv.string],
        vol.Optional("title"): cv.string,
    }
)
@websocket_api.async_response
async def ws_merge_areas(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """Fold several areas into one, each becoming a zone of the survivor.

    This is the v1 → v2 move that no migration could make for itself: "Living Office",
    "Living Sitting" and "Living Ceiling" are one set of four walls, and only a human
    knows that. Bias is preserved by pushing each old area's own ``bias_stops`` down into
    its new zone, so the merge does not change a single computed level.
    """
    entry = _entry(hass)
    if entry is None:
        connection.send_error(msg["id"], "not_loaded", "Solace is not set up")
        return
    survivor = entry.subentries.get(msg["into"])
    if survivor is None:
        connection.send_error(msg["id"], "unknown_room", "no such area")
        return
    sources = [entry.subentries.get(sid) for sid in msg["subentry_ids"]]
    if any(s is None for s in sources):
        connection.send_error(msg["id"], "unknown_room", "one of the areas does not exist")
        return

    lights: list[str] = list(survivor.data.get(CONF_LIGHTS) or [])
    presence: list[str] = list(survivor.data.get(CONF_PRESENCE) or [])
    zones: list[dict[str, Any]] = list(survivor.data.get(CONF_ZONES) or [])
    per_light: dict[str, Any] = dict(survivor.data.get(CONF_PER_LIGHT) or {})

    for source in sources:
        if source is None or source.subentry_id == survivor.subentry_id:
            continue
        src_lights = list(source.data.get(CONF_LIGHTS) or [])
        # The merged area's zone bias carries the old AREA bias, so levels are unchanged.
        carried = float(source.data.get("bias_stops", 0.0)) + float(
            source.data.get("zone_bias_stops", 0.0)
        )
        zones.append(
            {
                "zone_id": source.subentry_id[-8:],
                "name": source.title,
                "lights": src_lights,
                "presence": list(source.data.get(CONF_NEAR_PRESENCE) or []),
                "bias_stops": carried,
                "diminish_pct": float(source.data.get("diminish_pct", 0.0)),
            }
        )
        lights.extend(l for l in src_lights if l not in lights)
        presence.extend(
            p for p in (source.data.get(CONF_PRESENCE) or []) if p not in presence
        )
        per_light.update(source.data.get(CONF_PER_LIGHT) or {})

    hass.config_entries.async_update_subentry(
        entry,
        survivor,
        title=msg.get("title", survivor.title),
        data={
            **survivor.data,
            CONF_LIGHTS: lights,
            CONF_PRESENCE: presence,
            CONF_ZONES: zones,
            CONF_PER_LIGHT: per_light,
        },
    )
    for source in sources:
        if source is not None and source.subentry_id != survivor.subentry_id:
            hass.config_entries.async_remove_subentry(entry, source.subentry_id)

    await entry.runtime_data.coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"zones": len(zones), "lights": len(lights)})
