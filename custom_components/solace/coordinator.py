"""The coordinator — two clocks, one writer, and manual detection that survives a boot.

**Update cadence (decided in the brief):**

1. **Immediate on settings change.** A state listener fires a recalculation the moment a
   helper moves. *Not a poll.* The 2026-07 build read settings on a 30 s poll — a slider
   did nothing for up to 30 seconds and then snapped. It felt broken in both directions,
   and that single choice is most of why the last build "did not work well at all".
2. **Adaptive interval otherwise** — scaled to how fast the world is actually moving.

Colour runs on its own clock, because the hardware demands a different mechanism for it
(see ``fade.py``): brightness is one long hardware transition, colour is small stepped
absolutes.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry, ConfigSubentry
from homeassistant.const import STATE_ON
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.debounce import Debouncer
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util import dt as dt_util

from .colour import resolve_colour
from .const import (
    CONF_ALARM_ENTITY,
    CONF_AWAY_ENTITY,
    CONF_BRIGHTNESS_TIMELINE,
    CONF_COLOUR_TIMELINE,
    CONF_DND_ENTITY,
    CONF_DND_SLEEP_STATES,
    CONF_LIGHTS,
    CONF_LUX_CURVE,
    CONF_LUX_SENSOR,
    CONF_NEAR_PRESENCE,
    CONF_PER_LIGHT,
    CONF_PRESENCE,
    CONF_RAMP,
    CONF_REMOTES,
    CONF_SLEEP_TOGGLE,
    CONF_SUNRISE_CURVE,
    CONF_SUNSET_CURVE,
    CONF_WEATHER_ENTITY,
    CONF_ZONES,
    DEFAULT_DND_SLEEP_STATES,
    DEFAULT_MAX_INTERVAL_S,
    DEFAULT_MIN_INTERVAL_S,
    DEFAULT_WEATHER_ENTITY,
    DOMAIN,
    HOUSE_DEFAULTS,
    ROOM_DEFAULTS,
    SUBENTRY_TYPE_ROOM,
)
from .engine import ambience_threshold, debounce_ambience, solve
from .fade import FadeProfile, fade_profile
from .models import (
    EngineInput,
    Family,
    HouseSettings,
    LightSettings,
    Mode,
    RampPoint,
    RoomSettings,
    Solution,
    SplinePoint,
    ZoneSettings,
)
from .remotes import RemoteDispatcher
from .writer import LightWriter, infer_family

_LOGGER = logging.getLogger(__name__)

STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}.manual"

type SolaceConfigEntry = ConfigEntry[SolaceData]


@dataclass
class RoomState:
    """Everything mutable about one room. Persisted parts are marked."""

    subentry_id: str
    name: str
    manual_switch: bool = False
    """The switch holds manual indefinitely."""
    manual_touched: bool = False
    """⚠️ TRAP #2, persisted. Testing "minutes since touch < hold" *alone* means a fresh
    boot (age 0) reads as manual forever, because 0 is always less than the hold window.
    The explicit has-been-touched flag is what makes the age meaningful."""
    manual_since: float | None = None
    """UTC timestamp of the last human touch. Persisted alongside the flag."""
    solutions: dict[str, Solution] = field(default_factory=dict)
    last_written: dict[str, int] = field(default_factory=dict)
    last_source: dict[str, str] = field(default_factory=dict)
    """entity_id -> what drove its level last tick. See Solution.source."""
    ambience_open: bool = False
    ambience_pending_since: float | None = None
    last_mode: Mode = Mode.NORMAL
    occupied: bool = False
    occupied_since: float | None = None

    def is_manual(self, hold_minutes: float, now: float) -> bool:
        if self.manual_switch:
            return True
        if not self.manual_touched or self.manual_since is None:
            return False
        if hold_minutes <= 0:
            return False
        return (now - self.manual_since) < hold_minutes * 60.0


def _parse_spline_points(
    raw_list: Any,
    x_keys: tuple[str, ...] = ("x", "lux", "hour", "progress"),
    y_keys: tuple[str, ...] = ("y", "demand_pct", "demand", "level", "kelvin"),
    y_scale: float = 1.0,
) -> tuple[SplinePoint, ...]:
    if not raw_list:
        return ()
    out: list[SplinePoint] = []
    for p in raw_list:
        if isinstance(p, SplinePoint):
            out.append(p)
        elif isinstance(p, dict):
            x = 0.0
            for k in x_keys:
                if k in p:
                    x = float(p[k])
                    break
            y = 0.0
            for k in y_keys:
                if k in p:
                    y = float(p[k])
                    break
            if y_scale != 1.0 and y > 1.0:
                y = y * y_scale
            out.append(SplinePoint(x=x, y=y))
        elif isinstance(p, (list, tuple)) and len(p) >= 2:
            out.append(SplinePoint(x=float(p[0]), y=float(p[1])))
    return tuple(out)


@dataclass
class SolaceData:
    """Whatever the platforms need. Lives on ``entry.runtime_data``."""

    coordinator: SolaceCoordinator


class SolaceCoordinator(DataUpdateCoordinator[dict[str, RoomState]]):
    """Owns the calculation loop, the writes, and manual detection."""

    config_entry: SolaceConfigEntry

    def __init__(self, hass: HomeAssistant, entry: SolaceConfigEntry) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            config_entry=entry,
            update_interval=timedelta(seconds=DEFAULT_MIN_INTERVAL_S),
            # ⚠️ MUST be True here, despite `always_update=False` being the usual advice.
            # That flag makes the coordinator compare the previous data object to the
            # new one — and we return `self.rooms`, the *same mutable dict*, mutated in
            # place. Identity comparison then says "nothing changed" on every single
            # tick, so listeners never fire and every sensor freezes at its first value
            # while the lights carry on updating correctly. Caught by the integration
            # tests, which is the only place it shows: the writes look fine.
            always_update=True,
            # ⚠️ The default request-refresh debouncer is a **10 second cooldown with
            # immediate=False** — so a slider would do nothing for ten seconds and then
            # snap. That is precisely the failure the brief blames for the last build
            # ("a slider did nothing for up to 30 s and then snapped. Felt broken in
            # both directions"), and inheriting the default would have reproduced it
            # from the other direction. Fire immediately, then coalesce the rest of the
            # drag.
            request_refresh_debouncer=Debouncer(
                hass,
                _LOGGER,
                # Read straight off the entry: `self.house` needs `self.config_entry`,
                # which super().__init__ has not set yet.
                cooldown=float(
                    entry.options.get(
                        "refresh_debounce_s", HOUSE_DEFAULTS["refresh_debounce_s"]
                    )
                ),
                immediate=True,
            ),
        )
        self.writer = LightWriter(hass)
        self.remotes = RemoteDispatcher(self)
        self.rooms: dict[str, RoomState] = {}
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._lux_history: list[float] = []
        self._last_good_lux: float | None = None
        self._lux_warned = False
        self._night_latched = False
        self._unsubscribes: list[Any] = []
        self.last_tick: Any = None
        self._tuning = False

    # ------------------------------------------------------------------ settings

    @property
    def house(self) -> HouseSettings:
        """House settings, live from the config entry.

        Read fresh every time rather than cached — the whole point of clock 1 is that a
        slider takes effect *now*, and a cache is how that quietly stops being true.
        """
        options = {**HOUSE_DEFAULTS, **self.config_entry.options}
        ramp = options.get(CONF_RAMP) or [
            {"hour": 20.0, "stops": -0.5},
            {"hour": 22.5, "stops": -1.5},
        ]
        CURVE_KEYS = {
            "ramp",
            "lux_curve",
            "brightness_timeline",
            "colour_timeline",
            "sunrise_curve",
            "sunset_curve",
        }
        fields = {
            key: value
            for key, value in options.items()
            if key in HouseSettings.__slots__ and key not in CURVE_KEYS
        }
        fields["night_level"] = int(fields.get("night_level", 3))
        fields["night_release_lux"] = float(fields.get("night_release_lux", 10.0))
        fields["alarm_lead_minutes"] = float(fields.get("alarm_lead_minutes", 30.0))
        fields["ambience_level"] = int(fields.get("ambience_level", 0))
        # Carried as 0/1 in the settings table; the engine wants a real bool.
        for key in (
            "lux_history_samples",
            "manual_brightness_threshold",
            "manual_kelvin_threshold",
            "fallback_min_kelvin",
            "fallback_max_kelvin",
            "family_cct_max_kelvin",
            "family_rgb_max_kelvin",
            "demand_floor_level",
            "colour_step_mired_smooth",
            "colour_catch_up_steps",
        ):
            if key in fields:
                fields[key] = int(fields[key])
        fields["ambience_ignores_occupancy"] = bool(
            fields.get("ambience_ignores_occupancy", True)
        )
        fields["min_cutoff"] = int(fields.get("min_cutoff", 1))
        fields["rate_limit_step"] = int(fields.get("rate_limit_step", 0))
        fields["dead_zone"] = int(fields.get("dead_zone", 2))
        fields["day_kelvin"] = int(fields.get("day_kelvin", 4000))
        fields["night_kelvin"] = int(fields.get("night_kelvin", 2200))
        fields["colour_trim_kelvin"] = int(fields.get("colour_trim_kelvin", 0))
        fields["colour_step_mired"] = int(fields.get("colour_step_mired", 5))
        fields["transition_up_occupancy_s"] = float(fields.get("transition_up_occupancy_s", fields.get("transition_turn_on_l1_s", 2.0)))
        fields["transition_up_ambience_s"] = float(fields.get("transition_up_ambience_s", fields.get("transition_wake_l3_s", 10.0)))
        fields["transition_down_diminish_s"] = float(fields.get("transition_down_diminish_s", fields.get("transition_diminish_l2_s", 5.0)))
        fields["transition_down_ambience_s"] = float(fields.get("transition_down_ambience_s", fields.get("transition_clear_to_l3_s", 5.0)))
        fields["transition_down_off_s"] = float(fields.get("transition_down_off_s", fields.get("transition_clear_to_off_s", 4.0)))
        fields["transition_automatic_s"] = float(fields.get("transition_automatic_s", fields.get("transition_tracking_s", 15.0)))
        fields["transition_manual_s"] = float(fields.get("transition_manual_s", fields.get("transition_manual_drag_s", 0.5)))
        fields["ramp"] = tuple(
            RampPoint(hour=float(p["hour"]), stops=float(p["stops"])) for p in ramp
        )
        if CONF_LUX_CURVE in options and options[CONF_LUX_CURVE]:
            fields["lux_curve"] = _parse_spline_points(options[CONF_LUX_CURVE], y_scale=0.01)
        if CONF_BRIGHTNESS_TIMELINE in options and options[CONF_BRIGHTNESS_TIMELINE]:
            fields["brightness_timeline"] = _parse_spline_points(options[CONF_BRIGHTNESS_TIMELINE])
        if CONF_COLOUR_TIMELINE in options and options[CONF_COLOUR_TIMELINE]:
            fields["colour_timeline"] = _parse_spline_points(options[CONF_COLOUR_TIMELINE])
        if CONF_SUNRISE_CURVE in options and options[CONF_SUNRISE_CURVE]:
            fields["sunrise_curve"] = _parse_spline_points(options[CONF_SUNRISE_CURVE])
        if CONF_SUNSET_CURVE in options and options[CONF_SUNSET_CURVE]:
            fields["sunset_curve"] = _parse_spline_points(options[CONF_SUNSET_CURVE])
        return HouseSettings(**fields)

    def room_settings(self, subentry: ConfigSubentry) -> RoomSettings:
        data = {**ROOM_DEFAULTS, **subentry.data}
        return RoomSettings(
            name=subentry.title,
            bias_stops=float(data.get("bias_stops", 0.0)),
            zone_bias_stops=float(data.get("zone_bias_stops", 0.0)),
            diminish_stops=float(data.get("diminish_stops", 0.0)),
            diminish_pct=float(data.get("diminish_pct", 40.0 if data.get("diminish_stops", 0.0) <= 0 and "diminish_pct" not in data else data.get("diminish_pct", 0.0))),
            ambience_level=int(data.get("ambience_level", 0)),
            night_off=bool(data.get("night_off", False)),
            manual_hold_minutes=float(data.get("manual_hold_minutes", 30.0)),
            manual_mode=bool(data.get("manual_mode", False)),
            sunrise_enabled=bool(data.get("sunrise_enabled", False)),
            sunset_enabled=bool(data.get("sunset_enabled", False)),
            bedtime_dwell_enabled=bool(data.get("bedtime_dwell_enabled", False)),
            zones=tuple(
                ZoneSettings(
                    zone_id=str(z.get("zone_id") or z.get("name") or ""),
                    name=str(z.get("name") or z.get("zone_id") or "Zone"),
                    lights=tuple(z.get("lights") or ()),
                    bias_stops=float(z.get("bias_stops", 0.0)),
                    diminish_stops=float(z.get("diminish_stops", 0.0)),
                    diminish_pct=float(z.get("diminish_pct", 0.0)),
                )
                for z in (data.get(CONF_ZONES) or ())
            ),
        )

    def light_settings(self, entity_id: str, subentry: ConfigSubentry) -> LightSettings:
        """Per-light settings, with the hardware facts read from the live entity.

        Kelvin limits are **never guessed** — some bulbs here stop at 4000 K and others
        floor at 2702 K, and an out-of-range request is accepted, pinned, and logged as
        a success.
        """
        overrides = (subentry.data.get(CONF_PER_LIGHT) or {}).get(entity_id, {})
        state = self.hass.states.get(entity_id)
        house = self.house
        min_kelvin = house.fallback_min_kelvin
        max_kelvin = house.fallback_max_kelvin
        family = None
        if state is not None:
            min_kelvin = int(state.attributes.get("min_color_temp_kelvin") or min_kelvin)
            max_kelvin = int(state.attributes.get("max_color_temp_kelvin") or max_kelvin)
            family = infer_family(
                state,
                cct_max_kelvin=house.family_cct_max_kelvin,
                rgb_max_kelvin=house.family_rgb_max_kelvin,
            )
        return LightSettings(
            entity_id=entity_id,
            family=family or LightSettings().family,
            bias_stops=float(overrides.get("bias_stops", 0.0)),
            clamp_min=int(overrides.get("clamp_min", 0)),
            clamp_max=int(overrides.get("clamp_max", 254)),
            min_kelvin=min_kelvin,
            max_kelvin=max_kelvin,
        )

    def _subentries(self) -> list[ConfigSubentry]:
        return [
            sub
            for sub in self.config_entry.subentries.values()
            if sub.subentry_type == SUBENTRY_TYPE_ROOM
        ]

    # ------------------------------------------------------------------ lifecycle

    async def async_prepare(self) -> None:
        """Restore persisted manual state and wire up the listeners."""
        await self._async_restore()
        self._register_listeners()

    @callback
    def async_resubscribe(self) -> None:
        """Rebuild every state listener.

        ⚠️ Listeners are registered once from the entity links stored at the time. Point
        the integration at a different sleep toggle, alarm sensor, presence sensor or set
        of lights and the OLD ones stay watched and the new ones are invisible — until a
        restart. Caught live: the sleep toggle was configured after setup and silently
        did nothing, because nothing was listening to it.
        """
        self.async_shutdown_listeners()
        self._register_listeners()

    async def _async_restore(self) -> None:
        stored = await self._store.async_load() or {}
        # The latch must survive a restart — an HA restart at 3 am would otherwise drop
        # night mode and relight the house.
        self._night_latched = bool(stored.get("_night_latched", False))
        for subentry in self._subentries():
            saved = stored.get(subentry.subentry_id, {})
            self.rooms[subentry.subentry_id] = RoomState(
                subentry_id=subentry.subentry_id,
                name=subentry.title,
                manual_switch=bool(saved.get("manual_switch", False)),
                manual_touched=bool(saved.get("manual_touched", False)),
                manual_since=saved.get("manual_since"),
                ambience_open=bool(saved.get("ambience_open", False)),
            )

    @callback
    def _register_listeners(self) -> None:
        watched = [
            entity_id
            for subentry in self._subentries()
            for entity_id in subentry.data.get(CONF_LIGHTS, [])
        ]
        if watched:
            self._unsubscribes.append(
                async_track_state_change_event(self.hass, watched, self._on_light_change)
            )

        # Clock 1 — recalculate the instant the world moves, not on the next poll.
        triggers = [self._lux_entity()]
        if weather := self._weather_entity():
            triggers.append(weather)
        if dnd := self.config_entry.options.get(CONF_DND_ENTITY):
            triggers.append(dnd)
        for subentry in self._subentries():
            for key in (CONF_PRESENCE, CONF_NEAR_PRESENCE):
                value = subentry.data.get(key)
                if isinstance(value, str):
                    triggers.append(value)
                elif value:
                    triggers.extend(value)
            # Zone presence too. The tick READS these (per-zone diminish) but nothing
            # subscribed to them, so a zone sensor that is not also an area sensor moved
            # nothing until the next poll. Currently masked on this house — both kitchen
            # zone sensors are also area sensors — which is exactly why it needed finding
            # by reading rather than by watching.
            for zone in subentry.data.get(CONF_ZONES) or ():
                triggers.extend(zone.get("presence") or ())
        for key in (CONF_SLEEP_TOGGLE, CONF_ALARM_ENTITY, CONF_AWAY_ENTITY):
            if extra := (self.config_entry.options.get(key) or self.config_entry.data.get(key)):
                triggers.append(extra)
        # Always listen for away_mode helper and watch bedtime sensors if present in HA
        for extra_sensor in (
            "input_boolean.away_mode",
            "binary_sensor.google_pixel_watch_2_bedtime_mode",
            "sensor.google_pixel_watch_2_do_not_disturb_sensor",
        ):
            if extra_sensor not in triggers and self.hass.states.get(extra_sensor) is not None:
                triggers.append(extra_sensor)

        triggers = [t for t in triggers if t]
        if triggers:
            self._unsubscribes.append(
                async_track_state_change_event(self.hass, triggers, self._on_world_change)
            )

        # Register remote controller event listeners
        self.remotes.async_register()

        # Colour runs on its own clock — small stepped absolutes, never a long fade.
        self._unsubscribes.append(
            async_track_time_interval(
                self.hass, self._async_colour_tick, timedelta(seconds=self._colour_interval())
            )
        )

    @callback
    def async_shutdown_listeners(self) -> None:
        self.remotes.async_unregister()
        while self._unsubscribes:
            self._unsubscribes.pop()()

    async def async_persist(self) -> None:
        # The night latch is persisted alongside the per-room manual flags. An HA restart
        # at 3 am must not drop night mode and relight the house.
        payload: dict[str, Any] = {"_night_latched": self._night_latched}
        for room in self.rooms.values():
            payload[room.subentry_id] = {
                "manual_switch": room.manual_switch,
                "manual_touched": room.manual_touched,
                "manual_since": room.manual_since,
                # Hysteretic state: without it a restart resets to "bright", and a
                # restart at dusk with lux between the two thresholds (50-80) leaves the
                # glow suppressed until lux falls all the way past the *falling* edge.
                "ambience_open": room.ambience_open,
            }
        await self._store.async_save(payload)

    # ------------------------------------------------------------------ the loop

    async def _async_update_data(self) -> dict[str, RoomState]:
        house = self.house
        lux = self._lux()
        dnd = self._dnd()
        asleep = self._asleep()
        now = dt_util.utcnow()
        clock_hour = now.astimezone(dt_util.DEFAULT_TIME_ZONE).hour + now.astimezone(
            dt_util.DEFAULT_TIME_ZONE
        ).minute / 60.0
        loop_now = self.hass.loop.time()

        self._update_night_latch(asleep, lux, house)

        # Update room presence states first so dwell-based special modes have fresh data.
        for subentry in self._subentries():
            room = self.rooms.setdefault(
                subentry.subentry_id,
                RoomState(subentry_id=subentry.subentry_id, name=subentry.title),
            )
            is_occupied = self._any_on(subentry.data.get(CONF_PRESENCE), default=True)
            if is_occupied and not room.occupied:
                room.occupied_since = now.timestamp()
            elif not is_occupied:
                room.occupied_since = None
            room.occupied = is_occupied

        away = self._away()
        sunrise_progress = self._sunrise_progress(house)
        sunset_progress = self._sunset_progress(clock_hour, house)
        bedtime_dwell_active = self._bedtime_dwell_active(clock_hour, house)

        for subentry in self._subentries():
            room = self.rooms[subentry.subentry_id]
            settings = self.room_settings(subentry)
            occupied = room.occupied
            # Zone presence — "is THIS end of the room occupied", which is what drives diminish.
            zone_presence = {z.get("zone_id"): z.get("presence") for z in (subentry.data.get(CONF_ZONES) or ())}
            area_near_clear = not self._any_on(
                subentry.data.get(CONF_NEAR_PRESENCE), default=True
            )

            raw_gate = ambience_threshold(lux, room.ambience_open, house)
            room.ambience_open, room.ambience_pending_since = debounce_ambience(
                raw_gate, room.ambience_open, loop_now, room.ambience_pending_since, house
            )

            manual = room.is_manual(settings.manual_hold_minutes, now.timestamp())
            if not manual and room.manual_touched and not room.manual_switch:
                room.manual_touched = False
                room.manual_since = None

            zone_for = {
                light_id: zone
                for zone in settings.zones
                for light_id in zone.lights
            }
            for entity_id in subentry.data.get(CONF_LIGHTS, []):
                zone = zone_for.get(entity_id)
                if zone is not None and zone.zone_id in zone_presence:
                    near_clear = not self._any_on(
                        zone_presence.get(zone.zone_id), default=True
                    )
                else:
                    near_clear = area_near_clear
                try:
                    await self._async_apply_light(
                        entity_id, subentry, house, settings, room, lux, dnd, clock_hour,
                        occupied, near_clear, manual, asleep, away, sunrise_progress, sunset_progress, bedtime_dwell_active, zone,
                    )
                except Exception:  # noqa: BLE001
                    _LOGGER.exception("Solace: failed to apply %s", entity_id)

            if away:
                room.last_mode = Mode.AWAY
            elif sunrise_progress is not None:
                room.last_mode = Mode.SUNRISE
            elif sunset_progress is not None and not asleep:
                room.last_mode = Mode.SUNSET
            elif self._night_active():
                room.last_mode = Mode.NIGHT
            else:
                room.last_mode = Mode.NORMAL

        self._retune_interval(lux)
        self.last_tick = now
        self._tuning = False
        return self.rooms

    @callback
    def async_note_tuning(self) -> None:
        """Mark the next refresh as settings-driven (clock 1, slider in hand)."""
        self._tuning = True

    async def _async_apply_light(
        self,
        entity_id: str,
        subentry: ConfigSubentry,
        house: HouseSettings,
        settings: RoomSettings,
        room: RoomState,
        lux: float,
        dnd: bool,
        clock_hour: float,
        occupied: bool,
        near_clear: bool,
        manual: bool,
        asleep: bool,
        away: bool,
        sunrise_progress: float | None,
        sunset_progress: float | None,
        bedtime_dwell_active: bool,
        zone: ZoneSettings | None = None,
    ) -> None:
        state = self.hass.states.get(entity_id)
        if state is None:
            return

        light = self.light_settings(entity_id, subentry)
        current = int(state.attributes.get("brightness") or 0)
        if state.state != STATE_ON:
            current = 0

        diminish_pct = zone.diminish_pct if zone is not None else settings.diminish_pct
        solution = solve(
            house,
            settings,
            light,
            EngineInput(
                lux=lux,
                occupied=occupied,
                dnd=dnd,
                clock_hour=clock_hour,
                night_active=self._night_active(),
                asleep=asleep,
                away=away,
                sunrise_progress=sunrise_progress,
                sunset_progress=sunset_progress,
                bedtime_dwell_active=bedtime_dwell_active,
                ambience_open=room.ambience_open,
                ambience_resolved=room.ambience_open,
                diminish_active=near_clear and diminish_pct > 0,
                manual_level=current if manual else None,
                current_level=current,
                last_written_level=room.last_written.get(entity_id),
                last_source=room.last_source.get(entity_id),
                cloud_coverage=self._cloud_coverage(),
            ),
            zone=zone,
        )
        room.solutions[entity_id] = solution
        room.last_source[entity_id] = solution.source

        # Manual wins: compute and display, but never write.
        if manual or not solution.should_write:
            return

        if solution.level <= 0:
            if current > 0:
                await self.writer.async_turn_off(entity_id, house.transition_down_off_s)
                room.last_written[entity_id] = 0
            return

        was_off = current == 0
        last_src = room.last_source.get(entity_id)

        if was_off:
            if solution.source == "ambience":
                transition = house.transition_up_ambience_s
            else:
                transition = house.transition_up_occupancy_s
        elif self._tuning:
            # A slider is being dragged in the dashboard.
            transition = house.transition_manual_s
        elif solution.source == "diminish" and last_src == "demand":
            transition = house.transition_down_diminish_s
        elif solution.source == "ambience" and last_src in ("demand", "diminish"):
            transition = house.transition_down_ambience_s
        elif solution.source == "demand" and last_src in ("diminish", "ambience"):
            transition = house.transition_up_occupancy_s
        elif solution.mode is Mode.NIGHT and room.last_mode is not Mode.NIGHT:
            transition = house.transition_down_ambience_s
        else:
            # Automatic: steady-state lux / cloud / curve tracking
            transition = house.transition_automatic_s

        # An OFF bulb rejects a colour command — it wakes at its old colour. So colour
        # has to ride in the same turn-on, and only then.
        wake_kelvin = None
        if was_off:
            wake_kelvin = resolve_colour(
                clock_hour, self._dusk_hour(), house, light
            ).kelvin

        await self.writer.async_set_brightness(
            entity_id, solution.level, transition, wake_kelvin=wake_kelvin
        )
        room.last_written[entity_id] = solution.level

    # ------------------------------------------------------------------ colour clock

    async def _async_colour_tick(self, _now: Any) -> None:
        """One small colour step per bulb, toward the house curve."""
        house = self.house
        now = dt_util.now()
        clock_hour = now.hour + now.minute / 60.0
        dusk = self._dusk_hour()

        for subentry in self._subentries():
            room = self.rooms.get(subentry.subentry_id)
            if room is None:
                continue
            # ⚠️ **Manual does NOT stop colour.** Owner's spec: "In manual ALL lighting
            # automation stops (the color sync control keeps working)." Skipping the
            # colour tick here froze a manual room at whatever Kelvin it happened to
            # hold, so an evening spent on a manual level stayed at midday white while
            # the rest of the house warmed. Brightness is still frozen — that is what
            # manual means — and `_async_apply_light` is where that is enforced.
            for entity_id in subentry.data.get(CONF_LIGHTS, []):
                state = self.hass.states.get(entity_id)
                if state is None or state.state != STATE_ON:
                    continue  # an off bulb rejects colour; it gets it on wake instead
                light = self.light_settings(entity_id, subentry)
                target = resolve_colour(clock_hour, dusk, house, light)
                await self.writer.async_step_colour(
                    entity_id,
                    state.attributes.get("color_temp_kelvin"),
                    target.kelvin,
                    light,
                    profile=self.fade_profile_for(light.family),
                    r_crit=house.colour_rate_floor,
                    safety=house.colour_rate_safety,
                )

    def fade_profile_for(self, family: Family) -> FadeProfile:
        """The colour-walking strategy for one family, from live settings.

        Not cached: every value in it is a slider, and a cache is how "a setting takes
        effect now" quietly stops being true.
        """
        house = self.house
        return fade_profile(
            family,
            smooth_step_mired=house.colour_step_mired_smooth,
            stepped_step_mired=house.colour_step_mired,
            step_transition_s=house.colour_step_transition_s,
            catch_up_steps=house.colour_catch_up_steps,
            r_crit=house.colour_rate_floor,
            safety=house.colour_rate_safety,
        )

    def _colour_interval(self) -> float:
        """Derive the colour tick from the glide, never hardcode it.

        The full traverse divided into one step gives the number of steps; the glide
        duration divided by that gives the hold between them. Change the glide or the
        step size and the cadence follows.

        The tick is paced for the **finest** family in the house, because a shared clock
        can only ever be as fine as its fastest consumer. Coarser families are not
        over-driven by it: their own ``step_mired`` is a dead zone, so they simply decline
        the ticks where the curve has not yet moved far enough to be worth a write.
        """
        house = self.house
        from .colour import kelvin_to_mired

        span = abs(kelvin_to_mired(house.night_kelvin) - kelvin_to_mired(house.day_kelvin))
        finest = max(1, min(house.colour_step_mired, house.colour_step_mired_smooth))
        steps = max(1, span / finest)
        return max(house.colour_glide_minutes * 60.0 / steps, house.colour_step_transition_s * 2)

    def _clear_sleep_toggle(self) -> None:
        """Clear the manual sleep toggle helper when night mode ends."""
        entity_id = self.config_entry.options.get(
            CONF_SLEEP_TOGGLE
        ) or self.config_entry.data.get(CONF_SLEEP_TOGGLE)
        if not entity_id:
            return
        state = self.hass.states.get(entity_id)
        if state is not None and state.state == "on":
            _LOGGER.info("Solace: auto-clearing sleep toggle helper %s", entity_id)
            domain = entity_id.split(".")[0]
            if self.hass.services.has_service(domain, "turn_off"):
                self.hass.async_create_task(
                    self.hass.services.async_call(
                        domain,
                        "turn_off",
                        {"entity_id": entity_id},
                        context=self.writer.new_context(),
                    )
                )
            elif self.hass.services.has_service("homeassistant", "turn_off"):
                self.hass.async_create_task(
                    self.hass.services.async_call(
                        "homeassistant",
                        "turn_off",
                        {"entity_id": entity_id},
                        context=self.writer.new_context(),
                    )
                )
            else:
                self.hass.states.async_set(entity_id, "off")

    def _away(self) -> bool:
        """Is Away mode armed?"""
        entity_id = self.config_entry.options.get(
            CONF_AWAY_ENTITY
        ) or self.config_entry.data.get(CONF_AWAY_ENTITY) or "input_boolean.away_mode"
        return self._is_on(entity_id, default=False)

    def _sunrise_progress(self, house: HouseSettings) -> float | None:
        """0.0 to 1.0 progress through pre-alarm virtual sunrise fade."""
        if not house.sunrise_fade_enabled:
            return None
        entity_id = self.config_entry.options.get(
            CONF_ALARM_ENTITY
        ) or self.config_entry.data.get(CONF_ALARM_ENTITY)
        if not entity_id:
            return None
        state = self.hass.states.get(entity_id)
        if state is None or state.state in ("unknown", "unavailable"):
            return None
        alarm = dt_util.parse_datetime(state.state)
        if alarm is None:
            return None
        now = dt_util.utcnow()
        fade_window = timedelta(minutes=house.sunrise_fade_minutes)
        start = alarm - fade_window
        if start <= now <= alarm:
            total = fade_window.total_seconds()
            elapsed = (now - start).total_seconds()
            return max(0.0, min(1.0, elapsed / total if total > 0 else 1.0))
        return None

    def _sunset_progress(self, clock_hour: float, house: HouseSettings) -> float | None:
        """0.0 to 1.0 progress through bedtime virtual sunset fade.

        Trigger conditions:
        1. Inside the evening bedtime window: starts at bedtime_dwell_hour (e.g. 22:00) until hardcoded 04:00.
        2. Not away on holiday.
        3. Bedroom occupancy > sunset_dwell_minutes (e.g. 5 min continuous occupancy).
        4. Not already asleep or night latched.
        """
        if not house.sunset_fade_enabled or self._away() or self._asleep() or self._night_active():
            return None

        # Time window: start hour (e.g. 22.0) to hardcoded 04:00
        start_h = house.bedtime_dwell_hour
        end_h = 4.0
        in_window = (clock_hour >= start_h or clock_hour < end_h) if start_h > end_h else (start_h <= clock_hour < end_h)
        if not in_window:
            return None

        now_ts = dt_util.utcnow().timestamp()
        bedroom_room: RoomState | None = None
        for subentry in self._subentries():
            if subentry.title.lower() == "bedroom" or subentry.data.get("night_off") or subentry.data.get("sunset_enabled"):
                bedroom_room = self.rooms.get(subentry.subentry_id)
                break

        if not bedroom_room or not bedroom_room.occupied or bedroom_room.occupied_since is None:
            return None

        dwell_min = (now_ts - bedroom_room.occupied_since) / 60.0
        req_dwell_min = house.sunset_dwell_minutes
        if dwell_min < req_dwell_min:
            return None

        fade_dur_min = house.sunset_fade_minutes
        if fade_dur_min <= 0:
            return 1.0

        elapsed_fade_min = dwell_min - req_dwell_min
        return max(0.0, min(1.0, elapsed_fade_min / fade_dur_min))

    def _bedtime_dwell_active(self, clock_hour: float, house: HouseSettings) -> bool:
        """Is bedtime wind-down active in bedroom?"""
        if not house.bedtime_dwell_enabled:
            return False
        if self._night_active() or self._asleep():
            return False
        anchor = house.evening_axis_hour
        axis = (clock_hour - anchor) % 24.0
        dwell_axis = (house.bedtime_dwell_hour - anchor) % 24.0
        release_axis = (house.morning_release_hour - anchor) % 24.0
        return dwell_axis <= axis < release_axis

    def _asleep(self) -> bool:
        """Is he asleep RIGHT NOW — phone DND, watch bedtime mode, or the manual sleep toggle."""
        if self._dnd():
            return True
        return self._is_on(
            self.config_entry.options.get(CONF_SLEEP_TOGGLE)
            or self.config_entry.data.get(CONF_SLEEP_TOGGLE),
            default=False,
        )

    def _alarm_released(self, house: HouseSettings) -> bool:
        """Are we inside the lead-in to the next alarm?"""
        entity_id = self.config_entry.options.get(
            CONF_ALARM_ENTITY
        ) or self.config_entry.data.get(CONF_ALARM_ENTITY)
        if not entity_id:
            return False
        state = self.hass.states.get(entity_id)
        if state is None or state.state in ("unknown", "unavailable"):
            return False
        alarm = dt_util.parse_datetime(state.state)
        if alarm is None:
            return False
        now = dt_util.utcnow()
        lead = timedelta(minutes=house.sunrise_fade_minutes if house.sunrise_fade_enabled else house.alarm_lead_minutes)

        if alarm < now - timedelta(minutes=house.alarm_stale_minutes):
            return False
        return now >= alarm - lead

    def _update_night_latch(self, asleep: bool, lux: float, house: HouseSettings) -> None:
        """Night mode is LATCHED.

        Enter on sleep. Leave on the world's terms:
          * outdoor lux above ``night_release_lux`` (dawn), or
          * start of virtual sunrise / alarm lead-in.

        When night mode ends, auto-clear any manual sleep toggle helper so daytime
        lighting is never stuck latched in night mode across full sunlight.
        """
        if self._dnd():
            if not self._night_latched:
                _LOGGER.debug("Solace: entering night mode (dnd/bedtime sensor)")
            self._night_latched = True
            return

        unlatch = (
            (self._sunrise_progress(house) is not None)
            or self._alarm_released(house)
            or (lux >= house.night_release_lux)
        )

        if asleep:
            # If asleep only via manual sleep toggle, allow dawn lux / alarm / sunrise to unlatch
            if unlatch:
                _LOGGER.info("Solace: leaving night mode (dawn/sunrise/alarm override on sleep toggle)")
                self._night_latched = False
                self._clear_sleep_toggle()
                return
            if not self._night_latched:
                _LOGGER.debug("Solace: entering night mode (sleep toggle)")
            self._night_latched = True
            return

        if not self._night_latched:
            return

        if unlatch:
            _LOGGER.debug("Solace: leaving night mode (sunrise / alarm / dawn lux %s)", lux)
            self._night_latched = False
            self._clear_sleep_toggle()

    def _night_active(self) -> bool:
        return self._night_latched

    # ------------------------------------------------------------------ listeners

    @callback
    def _on_world_change(self, _event: Event[EventStateChangedData]) -> None:
        self.hass.async_create_task(self.async_refresh())

    @callback
    def _on_light_change(self, event: Event[EventStateChangedData]) -> None:
        """Did a human touch this light?

        Compare with **thresholds, not equality**. Bulbs echo back values that differ
        from what was commanded, so an exact comparison flags every echo as a human
        touch and the room locks itself into manual within a tick.
        """
        if self.writer.is_our_context(event.context):
            return

        entity_id = event.data["entity_id"]
        old = event.data.get("old_state")
        new = event.data.get("new_state")
        if new is None or old is None:
            return

        # ⚠️ A z2m reconnect or restart drives a bulb unknown/unavailable -> on/off. That is not a
        # human, and counting it would drop the room into manual for the whole hold
        # window every time the mesh hiccups or HA starts.
        transient = {"unknown", "unavailable"}
        if new.state in transient or old.state in transient:
            return

        # If both states are "off", it was not a human turning lights on/off
        if old.state == "off" and new.state == "off":
            return

        house = self.house
        touched = False
        if old.state != new.state:
            touched = True
        else:
            old_brightness = old.attributes.get("brightness") or 0
            new_brightness = new.attributes.get("brightness") or 0
            if abs(new_brightness - old_brightness) > house.manual_brightness_threshold:
                touched = True
            old_kelvin = old.attributes.get("color_temp_kelvin") or 0
            new_kelvin = new.attributes.get("color_temp_kelvin") or 0
            if abs(new_kelvin - old_kelvin) > house.manual_kelvin_threshold:
                touched = True

        if not touched:
            return

        for subentry in self._subentries():
            if entity_id in subentry.data.get(CONF_LIGHTS, []):
                room = self.rooms.get(subentry.subentry_id)
                if room is None:
                    continue
                room.manual_touched = True
                room.manual_since = dt_util.utcnow().timestamp()
                self.hass.async_create_task(self.async_persist())
                self.async_update_listeners()

    # ------------------------------------------------------------------ helpers

    def _lux_entity(self) -> str:
        return self.config_entry.options.get(CONF_LUX_SENSOR) or self.config_entry.data.get(
            CONF_LUX_SENSOR, ""
        )

    def _lux(self) -> float:
        """Outdoor lux, with a fail-safe that is neither "dark" nor "bright".

        ⚠️ The obvious fallbacks are both bad. Treating an unknown reading as **0 lx**
        means a dead sensor drives every room to full demand all day — the worst outcome
        in a house whose whole reason for automating
        lighting was to avoid exactly that. Treating it as **bright** leaves rooms dark
        when occupied.

        So: hold the **last good reading**. That covers the realistic failure — a z2m
        reconnect blip lasting seconds — with no visible effect at all. Only if we have
        never seen a value (a cold boot before the sensor first reports) does it fall
        back, and it falls back to *bright*, because a few dark seconds at startup is a
        smaller failure than the lights slamming to full, and manual control is always
        available.
        """
        state = self.hass.states.get(self._lux_entity())
        try:
            # `state` is None when the entity does not exist yet — that raises
            # AttributeError, NOT TypeError, so it must be caught explicitly. Missing it
            # let the exception escape `_async_update_data` and fail the whole entry into
            # a ConfigEntryNotReady retry loop over a *sensor reading*.
            value = float(state.state)  # type: ignore[union-attr]
        except (AttributeError, TypeError, ValueError):
            if self._last_good_lux is not None:
                return self._last_good_lux
            # Log the TRANSITION, not the condition. This is called once per room per
            # tick, so logging unconditionally turns a single dead sensor into hundreds
            # of identical lines — and a noisy check camouflages the real fault sitting
            # next to it.
            if not self._lux_warned:
                self._lux_warned = True
                _LOGGER.warning(
                    "Solace: no reading yet from %s — holding lights off until it reports",
                    self._lux_entity(),
                )
            return float("inf")
        if self._lux_warned:
            self._lux_warned = False
            _LOGGER.info("Solace: %s is reporting again (%s lx)", self._lux_entity(), value)
        self._last_good_lux = value
        return value

    def _weather_entity(self) -> str:
        return self.config_entry.options.get(CONF_WEATHER_ENTITY) or self.config_entry.data.get(
            CONF_WEATHER_ENTITY, DEFAULT_WEATHER_ENTITY
        )

    def _cloud_coverage(self) -> float | None:
        """Current cloud coverage percentage (0.0 to 100.0) from the weather entity."""
        entity_id = self._weather_entity()
        if not entity_id:
            return None
        state = self.hass.states.get(entity_id)
        if state is None or state.attributes is None:
            return None
        cov = state.attributes.get("cloud_coverage")
        if cov is None:
            return None
        try:
            return float(cov)
        except (TypeError, ValueError):
            return None

    def _phone_dnd(self) -> bool:
        """Is phone DND active?"""
        candidates = []
        dnd_opt = (
            self.config_entry.options.get(CONF_DND_ENTITY)
            or self.config_entry.data.get(CONF_DND_ENTITY)
        )
        if isinstance(dnd_opt, list):
            candidates.extend(dnd_opt)
        elif isinstance(dnd_opt, str) and dnd_opt:
            candidates.append(dnd_opt)
        else:
            for default_phone in (
                "sensor.pixel_8a_do_not_disturb_sensor",
            ):
                if self.hass.states.get(default_phone) is not None:
                    candidates.append(default_phone)

        if not candidates:
            return False

        sleep_states = self.config_entry.options.get(
            CONF_DND_SLEEP_STATES
        ) or DEFAULT_DND_SLEEP_STATES

        for entity_id in candidates:
            state = self.hass.states.get(entity_id)
            if state is not None and state.state not in ("unknown", "unavailable"):
                if state.state in sleep_states:
                    return True
        return False

    def _watch_bedtime(self) -> bool:
        """Is watch bedtime / DND mode active?"""
        for watch_sensor in (
            "binary_sensor.google_pixel_watch_2_bedtime_mode",
            "sensor.google_pixel_watch_2_do_not_disturb_sensor",
        ):
            state = self.hass.states.get(watch_sensor)
            if state is not None and state.state not in ("unknown", "unavailable"):
                if state.state in ("on", "priority_only", "alarms_only"):
                    return True
        return False

    def _manual_sleep(self) -> bool:
        """Is manual sleep toggle active?"""
        entity_id = (
            self.config_entry.options.get(CONF_SLEEP_TOGGLE)
            or self.config_entry.data.get(CONF_SLEEP_TOGGLE)
            or "input_boolean.solace_sleep"
        )
        return self._is_on(entity_id, default=False)

    def _dnd(self) -> bool:
        """Asleep? Checks configured DND entity and Pixel Watch bedtime sensors."""
        return self._phone_dnd() or self._watch_bedtime()

    def _any_on(self, entity_ids, *, default: bool) -> bool:
        """True if ANY of these entities is on. Accepts a bare string or a list."""
        if not entity_ids:
            return default
        if isinstance(entity_ids, str):
            entity_ids = [entity_ids]
        known = [e for e in entity_ids if self.hass.states.get(e) is not None]
        if not known:
            return default
        return any(self._is_on(e, default=False) for e in known)

    def _is_on(self, entity_id: str | None, *, default: bool) -> bool:
        if not entity_id:
            return default
        state = self.hass.states.get(entity_id)
        if state is None or state.state in ("unknown", "unavailable"):
            return default
        return state.state == STATE_ON

    def _dusk_hour(self) -> float:
        """Civil dusk from ``sun.sun``.

        Prefer the sun integration's own attributes over computing solar geometry — and
        note the latitude comes from ``hass.config``, not a constant. The prototype
        hardcoded 45.5°N; this installation is near 54°N, where the winter sun caps at 12.5°.
        """
        sun = self.hass.states.get("sun.sun")
        fallback = self.house.dusk_fallback_hour
        if sun is None:
            return fallback
        # ⚠️ `next_dusk` flips to TOMORROW's dusk the moment today's passes — so reading
        # it during the evening glide (exactly when it matters) returns the wrong day.
        # The clock hour barely moves day to day, so the error is small and would have
        # hidden here for months. Prefer the sun's own "below horizon" reading: once
        # dusk has passed today, next_dusk is ~24 h out and we want today's, which is
        # next_dusk minus a day.
        raw = sun.attributes.get("next_dusk")
        parsed = dt_util.parse_datetime(raw) if raw else None
        if parsed is None:
            return fallback
        local = dt_util.as_local(parsed)
        if (local - dt_util.now()).total_seconds() > 12 * 3600:
            local = local - timedelta(days=1)
        return local.hour + local.minute / 60.0

    def _retune_interval(self, lux: float) -> None:
        """Clock 2 — scale the poll to how fast the world is moving.

        All four numbers here are settings, not constants. They were literals until the
        panel landed, which is precisely the "value that cannot be changed from the
        panel" the brief calls a bug.
        """
        house = self.house
        self._lux_history.append(lux)
        self._lux_history = self._lux_history[-max(2, house.lux_history_samples) :]
        if len(self._lux_history) < 2:
            return
        finite = [v for v in self._lux_history if v != float("inf")]
        volatility = (max(finite) - min(finite)) if len(finite) >= 2 else 0.0
        anyone_home = any(
            self._any_on(sub.data.get(CONF_PRESENCE), default=True) for sub in self._subentries()
        )
        if volatility > house.lux_volatility_lx:
            seconds = house.update_interval_min_s
        elif anyone_home:
            seconds = house.update_interval_home_s
        else:
            seconds = house.update_interval_max_s
        seconds = max(float(seconds), 1.0)
        if self.update_interval != timedelta(seconds=seconds):
            self.update_interval = timedelta(seconds=seconds)
