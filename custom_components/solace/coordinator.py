"""The coordinator — two clocks, one writer, and manual mode that survives a boot.

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
import math
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
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

from .colour import kelvin_to_mired, resolve_colour
from .const import (
    CONF_ALARM_ENTITY,
    CONF_AWAY_ENTITY,
    CONF_BRIGHTNESS_TIMELINE,
    CONF_COLOUR_TIMELINE,
    CONF_DND_ENTITY,
    CONF_DND_SLEEP_STATES,
    CONF_LIGHTS,
    CONF_LUX_CURVE,
    CONF_LUX_CLOUDY_CURVE,
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
from .modes import sunny_override_state
from .modes import (
    DISPLAYS_ASLEEP_ENTITY,
    GUEST_MODE_ENTITY,
    WATCHER_ALIVE_ENTITY,
    MODE_HELPERS,
    MODE_LIGHTS,
    active_mode,
    mode_hold,
    profile_for,
)
from .engine import (
    ambience_threshold,
    apply_clamp,
    compute_state_table,
    debounce_ambience,
    demand,
    solve,
    solve_master,
    past_dead_zone,
)
from .fade import FadeProfile, dynamic_colour_transition_s, fade_profile
from .filter import AsymmetricFilter
from .horizon import (
    InteractivePreviewAutomaton,
    PredictiveHorizonPlanner,
    PreviewState,
    WatchdogState,
    WatchdogSupervisor,
)
from .models import (
    AQARA_MIN_LEVEL,
    EngineInput,
    Family,
    FixtureStandbyState,
    HouseSettings,
    LightSettings,
    Mode,
    RampKind,
    RampPoint,
    RoomSettings,
    Solution,
    SplinePoint,
    StandbyStateCache,
    StandbyTarget,
    StateTier,
    ZoneSettings,
)
from .music import SolaceMusicManager
from .remotes import RemoteDispatcher
from .solar import ClearSkySolarModel
from .spline import MonotoneCubicSpline
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
    manual_level: int | None = None
    """Explicit manual brightness level override if set."""
    solutions: dict[str, Solution] = field(default_factory=dict)
    last_written: dict[str, int] = field(default_factory=dict)
    last_written_kelvin: dict[str, int] = field(default_factory=dict)
    last_source: dict[str, str] = field(default_factory=dict)
    """entity_id -> what drove its level last tick. See Solution.source."""
    ambience_open: bool = False
    ambience_pending_since: float | None = None
    last_mode: Mode = Mode.NORMAL
    occupied: bool = False
    occupied_since: float | None = None
    fresh_occupancy: bool = False
    unoccupied_since: float | None = None

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
    parsed_xy: list[tuple[float, float]] = []
    for p in raw_list:
        if isinstance(p, SplinePoint):
            parsed_xy.append((p.x, p.y))
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
            parsed_xy.append((x, y))
        elif isinstance(p, (list, tuple)) and len(p) >= 2:
            parsed_xy.append((float(p[0]), float(p[1])))
    scale_all = y_scale != 1.0 and any(y > 1.0 for _, y in parsed_xy)
    return tuple(
        SplinePoint(x=x, y=(y * y_scale if scale_all else y))
        for x, y in parsed_xy
    )


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
        self.music = SolaceMusicManager(hass, self.async_update_listeners)
        self.rooms: dict[str, RoomState] = {}
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._lux_history: list[float] = []
        self._last_good_lux: float | None = None
        self._first_lux_reported = False
        self._dnd_live_seen: set[str] = set()
        self._startup_time = hass.loop.time()
        self._lux_warned = False
        self._night_latched = False
        self._active_sunrise_start: datetime | None = None
        self._active_sunrise_end: datetime | None = None
        self._active_sunset_started_at: float | None = None
        self._active_sunset_duration_s: float | None = None
        self._gate_override: bool | None = None
        #: Kelvin per office light while a Special Mode drives it at a fixed level.
        self._mode_kelvin: dict[str, int | None] = {}
        # Loop time of the last special-mode toggle (on or off). Office-light writes in the
        # few seconds after it use the "Mode switch" fade instead of the slow Automatic one.
        self._mode_switch_at: float | None = None
        #: Sleep was switched off during the active wake-up (cleared when sleep returns or
        #: the wake-up ends). Gives normal demand so there is light to see by.
        self._wake_boost = False
        #: Sunny override latch (hysteresis; see sunny_override_release_pct).
        self._sunny_latched = False
        #: Sleep switched back ON during the wake-up: do not auto-clear it until the fade ends.
        self._sleep_reasserted = False
        self._unsubscribes: list[Any] = []
        self._last_presence: dict[str, float] = {}
        self.last_tick: Any = None
        self._tuning = False
        self.standby_cache = StandbyStateCache()
        self.watchdog = WatchdogSupervisor(nominal_sync_s=300.0, timeout_s=1800.0)
        self.preview = InteractivePreviewAutomaton(throttle_interval_s=0.150)
        self._demand_filter = AsymmetricFilter(initial_value=0.0, sample_period_s=300.0)
        self._last_demand_filter_time: float | None = None
        self._hourly_cloud_forecast: list[dict[str, Any]] = []
        self._last_forecast_refresh: float = 0.0
        self._card_order: dict[str, list[str]] = {}

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
            "lux_cloudy_curve",
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
            "fallback_min_kelvin",
            "fallback_max_kelvin",
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
        fields["dead_zone"] = int(fields.get("dead_zone", 8))
        fields["day_kelvin"] = int(fields.get("day_kelvin", 4000))
        fields["night_kelvin"] = int(fields.get("night_kelvin", 2200))
        fields["colour_trim_kelvin"] = int(fields.get("colour_trim_kelvin", 0))
        fields["transition_up_occupancy_s"] = float(fields.get("transition_up_occupancy_s", fields.get("transition_turn_on_l1_s", 2.0)))
        fields["transition_up_occupied_on_s"] = float(fields.get("transition_up_occupied_on_s", 5.0))
        fields["transition_up_ambience_s"] = float(fields.get("transition_up_ambience_s", fields.get("transition_wake_l3_s", 10.0)))
        fields["transition_down_diminish_s"] = float(fields.get("transition_down_diminish_s", fields.get("transition_diminish_l2_s", 5.0)))
        fields["transition_down_ambience_s"] = float(fields.get("transition_down_ambience_s", fields.get("transition_clear_to_l3_s", 5.0)))
        fields["transition_down_off_s"] = float(fields.get("transition_down_off_s", fields.get("transition_clear_to_off_s", 4.0)))
        fields["transition_automatic_s"] = float(fields.get("transition_automatic_s", fields.get("transition_tracking_s", 15.0)))
        fields["transition_manual_s"] = float(fields.get("transition_manual_s", fields.get("transition_manual_drag_s", 0.5)))
        fields["transition_mode_s"] = float(fields.get("transition_mode_s", 3.0))
        fields["ramp"] = tuple(
            RampPoint(hour=float(p["hour"]), stops=float(p["stops"])) for p in ramp
        )
        if CONF_LUX_CURVE in options and options[CONF_LUX_CURVE]:
            fields["lux_curve"] = _parse_spline_points(options[CONF_LUX_CURVE], y_scale=0.01)
        if CONF_LUX_CLOUDY_CURVE in options and options[CONF_LUX_CLOUDY_CURVE]:
            fields["lux_cloudy_curve"] = _parse_spline_points(options[CONF_LUX_CLOUDY_CURVE], y_scale=0.01)
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
        if "threshold_stops" in subentry.data:
            threshold_stops = float(subentry.data["threshold_stops"])
        elif "daylight_pct" in subentry.data and float(subentry.data["daylight_pct"]) != 100.0:
            pct = max(0.01, min(8.0, float(subentry.data["daylight_pct"]) / 100.0))
            threshold_stops = round(-math.log2(pct), 2)
        else:
            threshold_stops = float(data.get("threshold_stops", 0.0))
        return RoomSettings(
            name=subentry.title,
            bias_stops=float(data.get("bias_stops", 0.0)),
            threshold_stops=threshold_stops,
            zone_bias_stops=float(data.get("zone_bias_stops", 0.0)),
            diminish_stops=float(data.get("diminish_stops", 0.0)),
            diminish_pct=float(data.get("diminish_pct", 40.0 if data.get("diminish_stops", 0.0) <= 0 and "diminish_pct" not in data else data.get("diminish_pct", 0.0))),
            ambience_level=int(data.get("ambience_level", 0)),
            occupied_min=int(data.get("occupied_min", 0)),
            occupied_max=int(data.get("occupied_max", 254)),
            night_off=bool(data.get("night_off", False)) or ("living" in subentry.title.lower() and self._living_guest_mode()),
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

    def is_manual(self, subentry: ConfigSubentry, room: RoomRuntime) -> bool:
        """Check if a room is currently in manual hold."""
        settings = self.room_settings(subentry)
        now_ts = dt_util.utcnow().timestamp()
        return room.is_manual(settings.manual_hold_minutes, now_ts)

    def light_settings(self, entity_id: str, subentry: ConfigSubentry) -> LightSettings:
        """Per-light hardware facts read from the live entity plus persisted per-light overrides.

        Kelvin limits are **never guessed** — Aqara CCT fixtures floor at 2702 K while RGB
        reaches 2000 K, and an out-of-range request is accepted, pinned, and logged as a
        success.
        """
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
                rgb_max_kelvin=house.family_rgb_max_kelvin,
            )
        overrides = (subentry.data.get(CONF_PER_LIGHT) or {}).get(entity_id, {})
        clamp_min_raw = overrides.get("clamp_min")
        clamp_max_raw = overrides.get("clamp_max")
        return LightSettings(
            entity_id=entity_id,
            family=family or LightSettings().family,
            bias_stops=float(overrides.get("bias_stops", 0.0)),
            clamp_min=int(clamp_min_raw) if clamp_min_raw is not None else 0,
            clamp_max=int(clamp_max_raw) if clamp_max_raw is not None else 254,
            min_kelvin=min_kelvin,
            max_kelvin=max_kelvin,
        )

    def _subentries(self) -> list[ConfigSubentry]:
        return [
            sub
            for sub in self.config_entry.subentries.values()
            for _ in (0,)
            if sub.subentry_type == SUBENTRY_TYPE_ROOM
        ]

    # ------------------------------------------------------------------ lifecycle

    async def async_prepare(self) -> None:
        """Restore persisted manual state and wire up the listeners."""
        from . import websocket_api as _ws_mod
        _ws_mod.async_register(self.hass)
        await self.music.async_prepare()
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
        if (saved_lux := stored.get("_last_good_lux")) is not None:
            try:
                self._last_good_lux = float(saved_lux)
                _LOGGER.info("Solace: restored last known good lux (%.1f lx)", self._last_good_lux)
            except (TypeError, ValueError):
                pass
        saved_order = stored.get("_card_order")
        if isinstance(saved_order, dict):
            self._card_order = {
                str(tab): [str(item) for item in order if isinstance(item, str)]
                for tab, order in saved_order.items()
                if isinstance(order, list)
            }
        for subentry in self._subentries():
            saved = stored.get(subentry.subentry_id, {})
            self.rooms[subentry.subentry_id] = RoomState(
                subentry_id=subentry.subentry_id,
                name=subentry.title,
                manual_switch=bool(saved.get("manual_switch", False)),
                manual_touched=bool(saved.get("manual_touched", False)),
                manual_since=saved.get("manual_since"),
                manual_level=saved.get("manual_level"),
                ambience_open=bool(saved.get("ambience_open", False)),
            )

    @callback
    def _register_listeners(self) -> None:
        # Clock 1 — recalculate the instant the world moves, not on the next poll.
        triggers = [self._lux_entity()]
        if weather := self._weather_entity():
            triggers.append(weather)
        dnd_opt = (
            self.config_entry.options.get(CONF_DND_ENTITY)
            or self.config_entry.data.get(CONF_DND_ENTITY)
        )
        if isinstance(dnd_opt, str) and dnd_opt:
            triggers.append(dnd_opt)
        elif isinstance(dnd_opt, list):
            triggers.extend(dnd_opt)
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
        # Always listen for away_mode / work_mode helpers and phone/watch bedtime sensors if present in HA
        for extra_sensor in (
            "input_boolean.away_mode",
            "input_boolean.work_mode",
            "input_boolean.gaming_mode",
            "input_boolean.movie_mode",
            DISPLAYS_ASLEEP_ENTITY,
            "input_boolean.living_guest_mode",
            "input_boolean.ambient_gate",
            "sun.sun",
            "sensor.pixel_8a_do_not_disturb_sensor",
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

        # Colour runs on its own clock — smooth hardware glides toward the projected 24h curve.
        self._unsubscribes.append(
            async_track_time_interval(
                self.hass, self._async_colour_tick, timedelta(seconds=self._colour_interval())
            )
        )
        self.hass.async_create_task(self._async_colour_tick(None))

    @callback
    def async_shutdown_listeners(self) -> None:
        self.remotes.async_unregister()
        self.music.async_shutdown()
        while self._unsubscribes:
            self._unsubscribes.pop()()

    def _data_to_save(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "_night_latched": self._night_latched,
            "_last_good_lux": self._last_good_lux,
            "_card_order": self._card_order,
        }
        for room in self.rooms.values():
            payload[room.subentry_id] = {
                "manual_switch": room.manual_switch,
                "manual_touched": room.manual_touched,
                "manual_since": room.manual_since,
                "manual_level": room.manual_level,
                # Hysteretic state: without it a restart resets to "bright", and a
                # restart at dusk with lux between the two thresholds (50-80) leaves the
                # glow suppressed until lux falls all the way past the *falling* edge.
                "ambience_open": room.ambience_open,
            }
        return payload

    async def async_persist(self) -> None:
        # The night latch and last known good lux are persisted alongside the per-room manual flags.
        # An HA restart must not drop night mode or lose the baseline outdoor illuminance.
        await self._store.async_save(self._data_to_save())

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

        gate_state = self.hass.states.get("input_boolean.ambient_gate")
        if gate_state is not None and gate_state.state in (STATE_ON, "off"):
            self._gate_override = (gate_state.state == STATE_ON) and not asleep

        # Update room presence states first so dwell-based special modes have fresh data.
        now_ts = now.timestamp()
        away = self._away()
        for subentry in self._subentries():
            room = self.rooms.setdefault(
                subentry.subentry_id,
                RoomState(subentry_id=subentry.subentry_id, name=subentry.title),
            )
            raw_occupied = self._any_on(subentry.data.get(CONF_PRESENCE), default=True)
            is_hallway = "hallway" in subentry.title.lower() or "stair" in subentry.title.lower()
            if raw_occupied:
                self._last_presence[subentry.subentry_id] = now_ts
                is_occupied = True
            else:
                last_occ = self._last_presence.get(subentry.subentry_id, 0.0)
                hold_s = 0.0 if (is_hallway or asleep or self._night_active() or away) else 90.0
                is_occupied = (now_ts - last_occ) < hold_s if last_occ > 0 else False

            if is_occupied:
                if not room.occupied:
                    room.occupied_since = now_ts
                    room.fresh_occupancy = True
                else:
                    room.fresh_occupancy = False
                room.unoccupied_since = None
            else:
                if room.occupied:
                    room.unoccupied_since = now_ts
                room.occupied_since = None
                room.fresh_occupancy = False
            room.occupied = is_occupied

        sunrise_progress = self._sunrise_progress(house)
        if (
            sunrise_progress is not None
            and sunrise_progress >= 0.995
            and self._active_sunrise_end is not None
        ):
            self.hass.async_create_task(
                self.music.async_trigger_wakeup(
                    anchor_iso=self._active_sunrise_end.isoformat()
                )
            )
        sunset_progress = self._sunset_progress(clock_hour, house)
        bedtime_dwell_active = self._bedtime_dwell_active(clock_hour, house)

        # Refresh hourly weather forecast if due
        await self._async_refresh_forecast()

        # Compute raw master demand and filter via AsymmetricFilter (instant attack, damped decay)
        raw_cloud = self._cloud_coverage()
        cloud_coverage = (
            0.0 if self._sunny_active(lux, house) else raw_cloud
        )
        raw_master = solve_master(lux, clock_hour, house, cloud_coverage=cloud_coverage)
        now_ts = now.timestamp()
        if (
            self._last_demand_filter_time is None
            or (now_ts - self._last_demand_filter_time) < 1.0
            or self._tuning
        ):
            # Cold boot, tuning slider drag, or zero-elapsed-time test: sync filter immediately
            filtered_demand = raw_master.demand
            self._demand_filter.reset(filtered_demand)
        else:
            dt_s = now_ts - self._last_demand_filter_time
            filtered_demand = self._demand_filter.update(raw_master.demand, dt_s=dt_s)
        self._last_demand_filter_time = now_ts
        self.watchdog.last_sync_time = now_ts
        self.watchdog.last_valid_demand = filtered_demand

        # Update continuous 4-level (+ Ls) Standby State Cache
        self._update_standby_cache(house, clock_hour, filtered_demand, lux, cloud_coverage)

        # Check if bedroom level has dropped below kitchen ambient light levels during bedroom fade
        kitchen_subentry = next(
            (s for s in self._subentries() if "kitchen" in s.title.lower()),
            None,
        )
        kitchen_ambient_level = house.ambience_level
        if kitchen_subentry is not None:
            k_settings = self.room_settings(kitchen_subentry)
            kitchen_ambient_level = k_settings.ambience_level or house.ambience_level

        bedroom_subentry = next(
            (s for s in self._subentries() if "bedroom" in s.title.lower() or s.data.get("night_off")),
            None,
        )
        ambient_suppressed_by_bedroom = False
        if sunset_progress is not None and bedroom_subentry is not None:
            b_settings = self.room_settings(bedroom_subentry)
            if (
                b_settings.sunset_enabled
                or b_settings.night_off
                or "bedroom" in bedroom_subentry.title.lower()
                or "bedroom" in b_settings.name.lower()
            ):
                progress_pct = max(0.0, min(100.0, sunset_progress * 100.0))
                sunset_spline = MonotoneCubicSpline(house.sunset_curve)
                curve_raw = sunset_spline(progress_pct)
                low_level = int(house.sunset_curve[-1].y) if (house.sunset_curve and house.sunset_curve[-1].y > 0) else AQARA_MIN_LEVEL
                bedroom_fade_level = max(low_level, int(round(curve_raw)))
                if bedroom_fade_level < kitchen_ambient_level:
                    ambient_suppressed_by_bedroom = True

        occupied_ids = {sid for sid, r in self.rooms.items() if r.occupied}
        for subentry in self._subentries():
            room = self.rooms[subentry.subentry_id]
            settings = self.room_settings(subentry)
            occupied = room.occupied
            occupied_elsewhere = bool(occupied_ids - {subentry.subentry_id})
            # Zone presence — "is THIS end of the room occupied", which is what drives diminish.
            zone_presence = {z.get("zone_id"): z.get("presence") for z in (subentry.data.get(CONF_ZONES) or ())}
            area_near_clear = not self._any_on(
                subentry.data.get(CONF_NEAR_PRESENCE), default=True
            )

            is_stairway = "stair" in subentry.title.lower() or "stair" in settings.name.lower()
            room_lux = max(0.0, lux / (2.0 ** settings.threshold_stops))
            if is_stairway:
                room.ambience_open = False
            elif self._gate_override is not None:
                room.ambience_open = self._gate_override
            else:
                raw_gate = ambience_threshold(room_lux, room.ambience_open, house)
                lux_gate, room.ambience_pending_since = debounce_ambience(
                    raw_gate, room.ambience_open, loop_now, room.ambience_pending_since, house
                )
                if ambient_suppressed_by_bedroom:
                    room.ambience_open = False
                else:
                    room.ambience_open = lux_gate

            manual = room.is_manual(settings.manual_hold_minutes, now.timestamp())
            if not manual and room.manual_touched and not room.manual_switch:
                room.manual_touched = False
                room.manual_since = None

            zone_for = {
                light_id: zone
                for zone in settings.zones
                for light_id in zone.lights
            }
            is_sunset_room = (
                settings.sunset_enabled
                or settings.night_off
                or "bedroom" in subentry.title.lower()
                or "bedroom" in settings.name.lower()
            )
            effective_sunset = (
                sunset_progress if (is_sunset_room or house.winddown_house_wide) else None
            )
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
                        occupied, near_clear, manual, asleep, away, sunrise_progress, effective_sunset, bedtime_dwell_active, zone,
                        filtered_demand=filtered_demand,
                        occupied_elsewhere=occupied_elsewhere,
                    )
                except Exception:  # noqa: BLE001
                    _LOGGER.exception("Solace: failed to apply %s", entity_id)

            if away:
                room.last_mode = Mode.AWAY
            elif sunrise_progress is not None:
                room.last_mode = Mode.SUNRISE
            elif effective_sunset is not None and not asleep:
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
        filtered_demand: float | None = None,
        occupied_elsewhere: bool = False,
    ) -> None:
        state = self.hass.states.get(entity_id)
        if state is None:
            return

        light = self.light_settings(entity_id, subentry)
        current = int(state.attributes.get("brightness") or 0)
        if state.state != STATE_ON:
            current = 0

        diminish_pct = zone.diminish_pct if zone is not None else settings.diminish_pct

        # Special Modes (Work / Gaming / Movie): a profile laid over normal demand.
        mode_profile = None
        mode_holding = False
        if entity_id in MODE_LIGHTS:
            mode_name = self._special_mode()
            if mode_name is not None:
                mode_profile = profile_for(house, mode_name)
                last_occ = self._last_presence.get(subentry.subentry_id, 0.0)
                now_ts = dt_util.utcnow().timestamp()
                mode_holding = mode_hold(
                    occupied=occupied,
                    seconds_since_presence=(now_ts - last_occ) if last_occ > 0 else 999999.0,
                    debounce_minutes=mode_profile.debounce_minutes,
                    displays_asleep=self._mode_paused(),
                    occupied_elsewhere=occupied_elsewhere,
                    guest_mode=self._is_on(GUEST_MODE_ENTITY, default=False),
                )
        solve_settings = settings
        if mode_profile is not None and mode_holding and abs(mode_profile.bias_stops) > 1e-9:
            solve_settings = replace(settings, bias_stops=settings.bias_stops + mode_profile.bias_stops)

        solution = solve(
            house,
            solve_settings,
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
                cloud_coverage=(
                    0.0
                    if self._sunny_active(lux, house)
                    else self._cloud_coverage()
                ),
                demand_override=filtered_demand,
                occupied_elsewhere=occupied_elsewhere,
                wake_boost=self._wake_boost and sunrise_progress is not None,
            ),
            zone=zone,
        )

        # Special Mode fixed levels. ⚠️ A mode sets the LEVEL. It does not decide whether to
        # write — that is the dead zone's job, and forcing ``should_write=True`` here bypassed
        # it entirely. Measured 2026-09-13: the office fixtures were the only ones in the
        # house re-emitting an identical ``{state:ON, brightness:100, transition:300}`` every
        # ~5.5 minutes for over an hour and a half. A value provider must never also be a
        # write forcer. Lights set to "follow" (-1) keep the normal solution, biased above.
        if mode_profile is not None and mode_holding:
            fixed = mode_profile.fixed_level(entity_id)
            if fixed is not None:
                self._mode_kelvin[entity_id] = mode_profile.fixed_kelvin
                solution = replace(
                    solution,
                    level=fixed,
                    source="work",
                    should_write=past_dead_zone(
                        fixed,
                        room.last_written.get(entity_id),
                        house.dead_zone,
                        source="work",
                        last_source=room.last_source.get(entity_id),
                    ),
                )

        room.solutions[entity_id] = solution
        # ⚠️ Read the PREVIOUS source before overwriting it. Reading it back afterwards made
        # `last_src` identical to `solution.source`, so every "what changed" branch in the
        # transition ladder below was unreachable and all of them fell through to
        # `transition_automatic_s`. Walking into a room asked for a 300 s fade instead of a
        # 2 s one, which reads as the lights simply not responding.
        last_src = room.last_source.get(entity_id)
        room.last_source[entity_id] = solution.source

        # Manual wins: compute and display, but never write.
        if manual:
            return
        has_active_or_pending_on = (
            current > 0
            or self.writer.get_in_flight_brightness(entity_id) is not None
            or (room.last_written.get(entity_id) or 0) > 0
        )
        if not solution.should_write and not (solution.level <= 0 and has_active_or_pending_on):
            return

        if solution.level <= 0:
            if has_active_or_pending_on:
                # Cold boot startup hold: suppress turning off lights that are already on
                # during the initial startup window (60s) if the lux sensor hasn't reported a live reading yet.
                if (
                    self.hass.states.get(self._lux_entity()) is not None
                    and not self._first_lux_reported
                    and not asleep
                    and (self.hass.loop.time() - self._startup_time) < 60.0
                ):
                    _LOGGER.debug(
                        "Solace: startup hold — suppressing turn-off of %s while waiting for %s",
                        entity_id,
                        self._lux_entity(),
                    )
                    return
                await self.writer.async_turn_off(entity_id, house.transition_down_off_s, is_acute=True)
                room.last_written[entity_id] = 0
            return

        was_off = current == 0

        is_acute = False
        mode_switch = (
            entity_id in MODE_LIGHTS
            and self._mode_switch_at is not None
            and self.hass.loop.time() - self._mode_switch_at < 15.0
        )
        if self._tuning:
            # A slider is being dragged in the dashboard.
            transition = house.transition_manual_s
            is_acute = True
        elif mode_switch:
            # A mode was just switched on or off: the person pressed a button and is
            # waiting, so this is a response, not background tracking.
            transition = house.transition_mode_s
            is_acute = True
        elif was_off:
            if solution.source == "ambience":
                transition = house.transition_up_ambience_s
            elif room.fresh_occupancy:
                # Fresh occupancy: snappy enter ramp (New Occupied)
                transition = house.transition_up_occupancy_s
                is_acute = True
            elif room.occupied:
                # Old occupied off to on: user already in room when lights turn on (lux drop, storm, evening)
                transition = house.transition_up_occupied_on_s
                is_acute = False
            else:
                # Unoccupied room turn-on driven by automated event / curve change
                transition = house.transition_automatic_s
        elif solution.source == "diminish" and last_src == "demand":
            transition = house.transition_down_diminish_s
            is_acute = True
        elif solution.source == "ambience" and last_src in ("demand", "diminish"):
            transition = house.transition_down_ambience_s
        elif solution.source == "demand" and last_src in ("diminish", "ambience"):
            transition = house.transition_up_occupancy_s
            is_acute = True
        elif solution.mode is Mode.NIGHT and room.last_mode is not Mode.NIGHT:
            transition = house.transition_down_ambience_s
        else:
            # Automatic: steady-state lux / cloud / curve tracking
            transition = house.transition_automatic_s

        # RampLock hardware lease check: suppress chronic writes if fixture is leased to an acute ramp
        loop_now = self.hass.loop.time()
        if not is_acute and self.writer.ramp_tracker.should_suppress_chronic_write(entity_id, loop_now):
            _LOGGER.debug("%s: suppressing chronic background write (RampLock active)", entity_id)
            return

        # Smart in-flight hardware glide protection:
        # If this fixture is already in the middle of a continuous tracking glide, check if the
        # new solution level is within the dead zone of the in-flight target. If so, leave the
        # in-flight glide alone to avoid resetting hardware timers, zigbee chatter, or jarring jumps.
        if not is_acute:
            in_flight = self.writer.get_in_flight_brightness(entity_id)
            if in_flight is not None:
                _start_time, _duration, _start_lvl, flight_target = in_flight
                if abs(solution.level - flight_target) < house.dead_zone:
                    _LOGGER.debug(
                        "%s: in-flight glide toward %d is within dead zone (%d) of new target %d — suppressing write",
                        entity_id,
                        flight_target,
                        house.dead_zone,
                        solution.level,
                    )
                    return

        # An OFF bulb rejects a colour command — it wakes at its old colour. So colour
        # has to ride in the same turn-on, and only then.
        wake_kelvin = None
        if was_off:
            if solution.source == "work" and self._mode_kelvin.get(entity_id):
                wake_kelvin = self._mode_kelvin[entity_id]
            else:
                wake_kelvin = resolve_colour(
                    clock_hour, self._dusk_hour(), house, light
                ).kelvin
        elif (
            solution.source == "work"
            and room.last_source.get(entity_id) != "work"
            and self._mode_kelvin.get(entity_id)
        ):
            wake_kelvin = self._mode_kelvin[entity_id]

        await self.writer.async_set_brightness(
            entity_id, solution.level, transition, wake_kelvin=wake_kelvin, is_acute=is_acute
        )
        room.last_written[entity_id] = solution.level

    # ------------------------------------------------------------------ colour clock

    async def _async_colour_tick(self, _now: Any) -> None:
        """Advance colour smoothly toward the projected 24h curve target."""
        if self._asleep() or self._night_active() or self._away():
            return
        house = self.house
        now = dt_util.now()
        clock_hour = now.hour + now.minute / 60.0
        dusk = self._dusk_hour()

        # Project ahead by heartbeat duration for a continuous smooth hardware glide
        transition_s = float(house.colour_heartbeat_s)
        interval_h = (transition_s / 60.0) / 60.0
        target_hour = (clock_hour + interval_h) % 24.0

        for subentry in self._subentries():
            room = self.rooms.get(subentry.subentry_id)
            if room is None:
                continue
            if self.is_manual(subentry, room):
                continue
            for entity_id in subentry.data.get(CONF_LIGHTS, []):
                sol = room.solutions.get(entity_id)
                if sol is not None and (sol.level <= 0 or sol.source == "manual"):
                    continue
                state = self.hass.states.get(entity_id)
                if state is None or state.state != STATE_ON:
                    continue  # an off bulb rejects colour; it gets it on wake instead
                light = self.light_settings(entity_id, subentry)
                current_k = state.attributes.get("color_temp_kelvin")
                if current_k is None:
                    continue
                if sol is not None and sol.source == "work" and self._mode_kelvin.get(entity_id):
                    target_kelvin = self._mode_kelvin[entity_id]
                else:
                    target = resolve_colour(target_hour, dusk, house, light)
                    target_kelvin = target.kelvin
                current_m = kelvin_to_mired(current_k)
                target_m = kelvin_to_mired(target_kelvin)
                delta_m = abs(target_m - current_m)
                step_trans_s = dynamic_colour_transition_s(
                    delta_m,
                    family=light.family,
                    r_crit=house.colour_rate_floor,
                    safety=house.colour_rate_safety,
                    max_duration_s=min(60.0, float(house.colour_heartbeat_s)),
                )
                await self.writer.async_step_colour(
                    entity_id,
                    current_k,
                    target_kelvin,
                    light,
                    profile=self.fade_profile_for(light.family),
                    transition_s=step_trans_s,
                )
                room.last_written_kelvin[entity_id] = target_kelvin

    def fade_profile_for(self, family: Family) -> FadeProfile:
        """The colour-walking strategy for one family, from live settings.

        Not cached: every value in it is a slider, and a cache is how "a setting takes
        effect now" quietly stops being true.
        """
        house = self.house
        return fade_profile(
            family,
            smooth_step_mired=house.colour_step_mired_smooth,
            step_transition_s=house.colour_step_transition_s,
            catch_up_steps=house.colour_catch_up_steps,
            r_crit=house.colour_rate_floor,
            safety=house.colour_rate_safety,
        )

    def _colour_interval(self) -> float:
        """Periodic interval between colour curve adjustments from live setting."""
        return float(self.house.colour_heartbeat_s)

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
        """0.0 to 1.0 progress through pre-alarm virtual sunrise fade with state prediction timeline anchoring."""
        if not house.sunrise_fade_enabled:
            self._active_sunrise_start = None
            self._active_sunrise_end = None
            return None

        now = dt_util.utcnow()

        # If sunrise is already anchored, continue the timeline even if alarm dismisses / changes during toilet trips,
        # and hold at the top of the curve (1.0) for 15 minutes after the target wake time so sleep/DND never slams lights to 0 at T+1s.
        if self._active_sunrise_start is not None and self._active_sunrise_end is not None:
            if now <= self._active_sunrise_end:
                total = (self._active_sunrise_end - self._active_sunrise_start).total_seconds()
                elapsed = (now - self._active_sunrise_start).total_seconds()
                return max(0.0, min(1.0, elapsed / total if total > 0 else 1.0))
            if now <= self._active_sunrise_end + timedelta(minutes=15) and (self._asleep() or self._night_active()):
                return 1.0
            # Completed naturally
            self._active_sunrise_start = None
            self._active_sunrise_end = None
            self._wake_boost = False
            self._sleep_reasserted = False

        candidates: list[datetime] = []
        entity_id = self.config_entry.options.get(
            CONF_ALARM_ENTITY
        ) or self.config_entry.data.get(CONF_ALARM_ENTITY)
        if entity_id:
            state = self.hass.states.get(entity_id)
            if state is not None and state.state not in ("unknown", "unavailable", ""):
                parsed = dt_util.parse_datetime(state.state)
                if parsed is None and ":" in state.state:
                    t = dt_util.parse_time(state.state)
                    if t is not None:
                        local_now = dt_util.now()
                        candidate = local_now.replace(hour=t.hour, minute=t.minute, second=t.second, microsecond=0)
                        if candidate < local_now - timedelta(minutes=15):
                            candidate += timedelta(days=1)
                        parsed = dt_util.as_utc(candidate)
                if parsed is not None:
                    candidates.append(parsed)

        if self.music.wake_time_enabled and self.music.wake_target_time:
            t = dt_util.parse_time(self.music.wake_target_time)
            if t is not None:
                local_now = dt_util.now()
                candidate = local_now.replace(hour=t.hour, minute=t.minute, second=t.second, microsecond=0)
                if candidate < local_now - timedelta(minutes=15):
                    candidate += timedelta(days=1)
                candidates.append(dt_util.as_utc(candidate))

        wake_dt = self.hass.states.get("input_datetime.solace_wake_time")
        wake_en = self.hass.states.get("input_boolean.solace_wake_enabled")
        if (
            wake_dt is not None
            and wake_dt.state not in ("unknown", "unavailable", "")
            and (wake_en is None or wake_en.state == STATE_ON)
        ):
            t = dt_util.parse_time(wake_dt.state)
            if t is not None:
                local_now = dt_util.now()
                candidate = local_now.replace(hour=t.hour, minute=t.minute, second=t.second, microsecond=0)
                if candidate < local_now - timedelta(minutes=15):
                    candidate += timedelta(days=1)
                candidates.append(dt_util.as_utc(candidate))

        if not candidates:
            return None

        fade_window = timedelta(minutes=house.sunrise_fade_minutes)
        for alarm in sorted(candidates):
            start = alarm - fade_window
            if start <= now <= alarm:
                self._active_sunrise_start = start
                self._active_sunrise_end = alarm
                total = fade_window.total_seconds()
                elapsed = (now - start).total_seconds()
                return max(0.0, min(1.0, elapsed / total if total > 0 else 1.0))
        return None

    def _sunset_progress(self, clock_hour: float, house: HouseSettings) -> float | None:
        """0.0 to 1.0 progress through bedtime virtual sunset fade with state prediction timeline anchoring.

        Trigger conditions:
        1. Inside the evening bedtime window: starts at bedtime_dwell_hour (e.g. 22:00) until morning_release_hour.
        2. Not away on holiday, asleep, or night latched.
        3. Bedroom occupancy >= sunset_dwell_minutes (continuous presence).
        4. Once triggered, duration is invariant (sunset_fade_minutes).
        5. If occupant leaves bedroom for <= 5 minutes (toilet/drink of water), fade continues.
        6. If occupant leaves bedroom for > 5 minutes, session clears.
        """
        if not house.sunset_fade_enabled or self._away() or self._asleep() or self._night_active():
            self._active_sunset_started_at = None
            self._active_sunset_duration_s = None
            return None

        # Time window: start hour to morning release hour
        start_h = house.bedtime_dwell_hour
        end_h = house.morning_release_hour
        in_window = (
            (clock_hour >= start_h or clock_hour < end_h)
            if start_h > end_h
            else (start_h <= clock_hour < end_h)
        )
        if not in_window:
            self._active_sunset_started_at = None
            self._active_sunset_duration_s = None
            return None

        now_ts = dt_util.utcnow().timestamp()

        bedroom_room: RoomState | None = None
        for subentry in self._subentries():
            if (
                "bedroom" in subentry.title.lower()
                or subentry.data.get("night_off")
                or subentry.data.get("sunset_enabled")
            ):
                bedroom_room = self.rooms.get(subentry.subentry_id)
                break

        # If sunset is already active:
        if self._active_sunset_started_at is not None:
            # Check toilet/water grace period (5 min = 300s) if bedroom is currently unoccupied
            if bedroom_room is None or not bedroom_room.occupied:
                unoccupied_duration = (
                    (now_ts - bedroom_room.unoccupied_since)
                    if (bedroom_room and bedroom_room.unoccupied_since is not None)
                    else 0.0
                )
                if unoccupied_duration >= float(house.winddown_leave_grace_minutes) * 60.0:
                    self._active_sunset_started_at = None
                    self._active_sunset_duration_s = None
                    return None

            duration_s = max(1.0, (self._active_sunset_duration_s or (house.sunset_fade_minutes * 60.0)))
            if house.sunset_fade_minutes > 0:
                duration_s = house.sunset_fade_minutes * 60.0
                self._active_sunset_duration_s = duration_s

            elapsed = now_ts - self._active_sunset_started_at
            if elapsed < duration_s:
                return max(0.0, min(1.0, elapsed / duration_s))
            # Completed fade: hold at lowest level (1.0) until sleep mode triggers, away, or window ends
            return 1.0

        # Sunset not active yet: require occupied bedroom with required continuous dwell
        if not bedroom_room or not bedroom_room.occupied or bedroom_room.occupied_since is None:
            return None

        dwell_min = (now_ts - bedroom_room.occupied_since) / 60.0
        req_dwell_min = house.sunset_dwell_minutes
        if dwell_min < req_dwell_min:
            return None

        fade_dur_min = house.sunset_fade_minutes
        if fade_dur_min <= 0:
            return 1.0

        # Anchor timeline: starts now, lasts sunset_fade_minutes
        self._active_sunset_started_at = now_ts
        self._active_sunset_duration_s = fade_dur_min * 60.0
        return 0.0

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
                self._clear_work_mode()
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
                self._night_latched = False
                if self._sleep_reasserted and self._active_sunrise_start is not None:
                    # Back to bed mid wake-up: the dawn carries on; sleep stays on.
                    return
                _LOGGER.info("Solace: leaving night mode (dawn/sunrise/alarm override on sleep toggle)")
                self._clear_sleep_toggle()
                self._clear_work_mode()
                return
            if not self._night_latched:
                _LOGGER.debug("Solace: entering night mode (sleep toggle)")
                self._clear_work_mode()
            self._night_latched = True
            return

        if not self._night_latched:
            return

        wifi = self.hass.states.get("sensor.pixel_8a_wi_fi_connection")
        stale_phone_boot = (
            "sensor.pixel_8a_do_not_disturb_sensor" not in self._dnd_live_seen
            and wifi is not None
            and wifi.state in ("<not connected>", "unknown", "unavailable")
            and not self._watch_bedtime()
            and not self._manual_sleep()
        )
        if unlatch or stale_phone_boot:
            _LOGGER.debug("Solace: leaving night mode (sunrise / alarm / dawn lux %s)", lux)
            self._night_latched = False
            self._clear_sleep_toggle()
            self._clear_work_mode()

    def _night_active(self) -> bool:
        return self._night_latched

    async def _async_refresh_forecast(self) -> None:
        """Fetch hourly weather forecast if weather service is available."""
        now_ts = self.hass.loop.time()
        if now_ts - self._last_forecast_refresh < 1800.0:
            return
        self._last_forecast_refresh = now_ts
        weather_entity = self._weather_entity()
        if not weather_entity:
            return
        try:
            if self.hass.services.has_service("weather", "get_forecasts"):
                res = await self.hass.services.async_call(
                    "weather",
                    "get_forecasts",
                    {"entity_id": weather_entity, "type": "hourly"},
                    blocking=True,
                    return_response=True,
                )
                if res and weather_entity in res:
                    self._hourly_cloud_forecast = res[weather_entity].get("forecast") or []
        except Exception:  # noqa: BLE001
            _LOGGER.debug("Solace: hourly weather forecast call failed or not supported")

    def _update_standby_cache(
        self,
        house: HouseSettings,
        clock_hour: float,
        filtered_demand: float,
        lux: float,
        cloud_coverage: float | None,
    ) -> None:
        """Pre-compute L0, L1, L2, L3, Ls targets for all fixtures across all rooms."""
        master = solve_master(
            lux,
            clock_hour,
            house,
            cloud_coverage=cloud_coverage,
            demand_override=filtered_demand,
        )
        dusk = self._dusk_hour()
        for subentry in self._subentries():
            room_settings = self.room_settings(subentry)
            room_eff_lux = max(0.0, lux / (2.0 ** room_settings.threshold_stops))
            room_master = (
                master
                if abs(room_settings.threshold_stops) <= 1e-9
                else solve_master(
                    room_eff_lux,
                    clock_hour,
                    house,
                    cloud_coverage=cloud_coverage,
                )
            )
            zone_for = {
                light_id: zone
                for zone in room_settings.zones
                for light_id in zone.lights
            }
            room_state = self.rooms.get(subentry.subentry_id)
            is_stairway = "stair" in subentry.title.lower() or "stair" in room_settings.name.lower()
            ambience_open = False if is_stairway else (room_state.ambience_open if room_state is not None else self._gate_open())
            fixture_states: dict[str, FixtureStandbyState] = {}
            for entity_id in subentry.data.get(CONF_LIGHTS, []):
                light = self.light_settings(entity_id, subentry)
                zone = zone_for.get(entity_id)
                table = compute_state_table(
                    room_master,
                    house,
                    room_settings,
                    light,
                    clock_hour=clock_hour,
                    zone=zone,
                    effective_lux=room_eff_lux,
                    cloud_coverage=cloud_coverage,
                )
                wake_colour = resolve_colour(clock_hour, dusk, house, light).kelvin

                occ_min = max(0, min(254, min(room_settings.occupied_min, room_settings.occupied_max)))
                occ_max = max(0, min(254, max(room_settings.occupied_min, room_settings.occupied_max)))
                if is_stairway:
                    cutoff = light.clamp_min
                    l1_level = 0 if (0 < table.l1 < cutoff) else table.l1
                    l2_level = 0 if (0 < table.l2 < cutoff) else table.l2
                    l1s_level = (
                        apply_clamp(min(occ_max, table.l1s), light)
                        if occ_max < 254
                        else table.l1s
                    )
                else:
                    cutoff = 254 if house.min_cutoff >= 254 else (0 if ambience_open else max(house.min_cutoff, light.clamp_min))
                    l1_level = 0 if (0 < table.l1 <= cutoff if cutoff >= 254 else 0 < table.l1 < cutoff) else table.l1
                    l2_level = 0 if (0 < table.l2 <= cutoff if cutoff >= 254 else 0 < table.l2 < cutoff) else table.l2
                    l1s_level = table.l1s
                    if occ_min > 0 or occ_max < 254:
                        l1_level = apply_clamp(max(occ_min, min(occ_max, l1_level)), light)
                        l2_level = apply_clamp(max(occ_min, min(occ_max, l2_level)), light)
                        l1s_level = apply_clamp(min(occ_max, l1s_level), light)

                l0 = StandbyTarget(
                    level=0,
                    kelvin=None,
                    transition_s=house.transition_down_off_s,
                )
                l1 = StandbyTarget(
                    level=l1_level,
                    kelvin=table.target_kelvin,
                    transition_s=house.transition_up_occupancy_s,
                )
                l2 = StandbyTarget(
                    level=l2_level,
                    kelvin=table.target_kelvin,
                    transition_s=house.transition_down_diminish_s,
                )
                l3 = StandbyTarget(
                    level=table.l3,
                    kelvin=wake_colour,
                    transition_s=house.transition_up_ambience_s,
                )
                l1s = StandbyTarget(
                    level=l1s_level,
                    kelvin=house.night_kelvin,
                    transition_s=house.transition_up_occupancy_s,
                )
                fixture_states[entity_id] = FixtureStandbyState(
                    l0=l0, l1=l1, l2=l2, l3=l3, l1s=l1s
                )
            self.standby_cache.update_room(subentry.subentry_id, fixture_states)

    def _handle_fast_path_presence(self, entity_id: str) -> None:
        """Instant deployment of pre-computed standby state upon occupancy trigger (<10ms)."""
        now_ts = dt_util.utcnow().timestamp()
        for subentry in self._subentries():
            presence_entities = subentry.data.get(CONF_PRESENCE)
            matches = False
            if isinstance(presence_entities, str) and presence_entities == entity_id:
                matches = True
            elif isinstance(presence_entities, (list, tuple)) and entity_id in presence_entities:
                matches = True

            if not matches:
                continue

            room = self.rooms.get(subentry.subentry_id)
            if room is None:
                continue

            settings = self.room_settings(subentry)
            is_bedroom_off = (
                settings.night_off
                or "bedroom" in subentry.title.lower()
                or "bedroom" in settings.name.lower()
            )
            if (
                room.occupied
                or room.is_manual(settings.manual_hold_minutes, now_ts)
                or self._away()
                or (self._asleep() and is_bedroom_off)
            ):
                continue

            room.occupied = True
            room.occupied_since = now_ts
            room.unoccupied_since = None
            room.fresh_occupancy = True
            self._last_presence[subentry.subentry_id] = now_ts

            tier = StateTier.L1S_SPECIAL if self._night_active() else StateTier.L1_DEMAND
            fixtures = subentry.data.get(CONF_LIGHTS, [])
            groups = self.standby_cache.batch_room_dispatch(subentry.subentry_id, fixtures, tier)

            for (level, kelvin, transition_s), entity_ids in groups.items():
                if level > 0:
                    self.hass.async_create_task(
                        self.writer.async_set_brightness(
                            entity_ids,
                            level=level,
                            transition_s=transition_s,
                            wake_kelvin=kelvin,
                            is_acute=True,
                        )
                    )
                for eid in entity_ids:
                    room.last_written[eid] = level
                    room.last_source[eid] = "night" if tier == StateTier.L1S_SPECIAL else "demand"

    # ------------------------------------------------------------------ listeners

    @callback
    def _on_world_change(self, event: Event[EventStateChangedData]) -> None:
        data = event.data
        new_state = data.get("new_state")
        old_state = data.get("old_state")
        entity_id = data.get("entity_id")

        if (
            new_state is not None
            and new_state.state == STATE_ON
            and (old_state is None or old_state.state != STATE_ON)
            and entity_id
        ):
            self._handle_fast_path_presence(entity_id)
        elif (
            old_state is not None
            and old_state.state == STATE_ON
            and (new_state is None or new_state.state != STATE_ON)
            and entity_id
        ):
            now_ts = dt_util.utcnow().timestamp()
            for subentry in self._subentries():
                presence_entities = subentry.data.get(CONF_PRESENCE)
                if (isinstance(presence_entities, str) and presence_entities == entity_id) or (
                    isinstance(presence_entities, (list, tuple)) and entity_id in presence_entities
                ):
                    self._last_presence[subentry.subentry_id] = now_ts

        if entity_id == "input_boolean.ambient_gate" and new_state is not None:
            self._gate_override = (new_state.state == STATE_ON)

        if (
            entity_id
            and old_state is not None
            and new_state is not None
            and old_state.state not in ("unknown", "unavailable")
            and new_state.state not in ("unknown", "unavailable")
            and old_state.state != new_state.state
        ):
            self._dnd_live_seen.add(entity_id)
            if entity_id in (
                "input_boolean.solace_sleep",
                "sensor.pixel_8a_do_not_disturb_sensor",
            ) and new_state.state == "off":
                self._night_latched = False
            sleep_entity = (
                self.config_entry.options.get(CONF_SLEEP_TOGGLE)
                or self.config_entry.data.get(CONF_SLEEP_TOGGLE)
                or "input_boolean.solace_sleep"
            )
            if entity_id == sleep_entity and not self.writer.is_our_context(new_state.context):
                # Only YOUR sleep toggles count. Solace itself clears the toggle when the
                # wake-up starts; that echo must not read as "I'm up, give me light".
                if new_state.state == "off" and self._active_sunrise_start is not None:
                    self._wake_boost = True
                    self._sleep_reasserted = False
                elif new_state.state == "on":
                    self._wake_boost = False
                    # Back to bed mid wake-up: keep sleep on and let the fade carry on.
                    self._sleep_reasserted = self._active_sunrise_start is not None
            if entity_id in MODE_HELPERS.values() and (
                old_state is None or old_state.state != new_state.state
            ):
                self._mode_switch_at = self.hass.loop.time()
            for mode_name, helper in MODE_HELPERS.items():
                if entity_id == helper and new_state.state == "on":
                    # One special mode at a time: switching one on switches the others off.
                    others = [h for m, h in MODE_HELPERS.items() if m != mode_name and self._is_on(h, default=False)]
                    if others:
                        self.hass.async_create_task(
                            self.hass.services.async_call(
                                "input_boolean",
                                "turn_off",
                                {"entity_id": others},
                                context=self.writer.new_context(),
                            )
                        )
                    self.hass.async_create_task(self._async_colour_tick(None))

        self.hass.async_create_task(self.async_refresh())

    # ------------------------------------------------------------------ helpers

    def _lux_entity(self) -> str:
        return self.config_entry.options.get(CONF_LUX_SENSOR) or self.config_entry.data.get(
            CONF_LUX_SENSOR, ""
        )

    def _lux(self) -> float:
        """Outdoor lux, with a fail-safe that is neither "dark" nor "bright".

        ⚠️ The obvious fallbacks are both bad. Treating an unknown reading as **0 lx**
        means a dead sensor drives every room to full demand all day — the worst outcome
        in a house whose whole reason for automating lighting was to avoid exactly that.
        Treating it as **bright** (float("inf")) leaves rooms dark when occupied.

        So: hold the **last good reading** (restored across restarts from persistent store).
        That covers the realistic failure — an HA restart or z2m reconnect blip lasting seconds —
        with no visible effect at all. Only if we have never seen a value (a cold boot before
        the sensor first reports and with no stored history) does it fall back to the astronomical
        solar clear-sky model (ClearSkySolarModel.clear_sky_illuminance(sun_elevation)), aligning
        with actual dusk/night/day conditions.
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

            # Astronomical model fallback: if sensor has not reported yet and no stored lux exists
            sun = self.hass.states.get("sun.sun")
            if sun and sun.attributes and "elevation" in sun.attributes:
                try:
                    elevation = float(sun.attributes["elevation"])
                    fallback_lux = ClearSkySolarModel.clear_sky_illuminance(elevation)
                    if not self._lux_warned:
                        self._lux_warned = True
                        _LOGGER.warning(
                            "Solace: no reading yet from %s — falling back to astronomical solar model (%.1f lx at %.1f° elevation)",
                            self._lux_entity(),
                            fallback_lux,
                            elevation,
                        )
                    return fallback_lux
                except (TypeError, ValueError):
                    pass

            # Log the TRANSITION, not the condition. This is called once per room per
            # tick, so logging unconditionally turns a single dead sensor into hundreds
            # of identical lines — and a noisy check camouflages the real fault sitting
            # next to it.
            if not self._lux_warned:
                self._lux_warned = True
                _LOGGER.warning(
                    "Solace: no reading yet from %s and sun elevation unavailable — holding 0 lx",
                    self._lux_entity(),
                )
            return 0.0

        if self._lux_warned:
            self._lux_warned = False
            _LOGGER.info("Solace: %s is reporting again (%s lx)", self._lux_entity(), value)
        self._last_good_lux = value
        self._first_lux_reported = True
        self._store.async_delay_save(self._data_to_save, delay=60)
        return value

    def _weather_entity(self) -> str:
        return self.config_entry.options.get(CONF_WEATHER_ENTITY) or self.config_entry.data.get(
            CONF_WEATHER_ENTITY, DEFAULT_WEATHER_ENTITY
        )

    def _cloud_coverage(self) -> float | None:
        """Current effective cloud coverage percentage (0.0 to 100.0) adjusted for optical depth."""
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
            cov_val = float(cov)
            cond = str(state.state or "")
            precip = float(state.attributes.get("precipitation") or 0.0)
            return ClearSkySolarModel.effective_cloud_coverage(cov_val, cond, precip)
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
                if (
                    entity_id == "sensor.pixel_8a_do_not_disturb_sensor"
                    and entity_id not in self._dnd_live_seen
                ):
                    wifi = self.hass.states.get("sensor.pixel_8a_wi_fi_connection")
                    if wifi is None or wifi.state in ("<not connected>", "unknown", "unavailable"):
                        continue
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

    def _work_mode(self) -> bool:
        """Is work mode active?"""
        return self._is_on("input_boolean.work_mode", default=False)

    def _sunny_active(self, lux: float, house: HouseSettings) -> bool:
        """Sunny lux override with hysteresis: on at the threshold, off only once lux
        drops ``sunny_override_release_pct`` below it."""
        self._sunny_latched = sunny_override_state(
            lux, house.sunny_override_lux, house.sunny_override_release_pct, self._sunny_latched
        )
        return self._sunny_latched

    def _special_mode(self) -> str | None:
        """The live Special Mode (movie > gaming > work), or None."""
        return active_mode({m: self._is_on(h, default=False) for m, h in MODE_HELPERS.items()})

    def _mode_paused(self) -> bool:
        """Displays asleep: the Special Mode profile pauses until they wake."""
        # Only trusted while the Mac watcher is heartbeating: a stale "asleep" from a dead
        # watcher must never pause a mode indefinitely.
        return self._is_on(DISPLAYS_ASLEEP_ENTITY, default=False) and self._is_on(
            WATCHER_ALIVE_ENTITY, default=False
        )

    def _living_guest_mode(self) -> bool:
        """Is living room guest mode active?"""
        return self._is_on("input_boolean.living_guest_mode", default=False)

    def _gate_open(self) -> bool:
        """Is ambient gate open across rooms?"""
        if self._gate_override is not None:
            return self._gate_override
        return any(r.ambience_open for r in self.rooms.values())

    async def async_toggle_gate(self) -> bool:
        """Toggle ambient gate override."""
        current = self._gate_open()
        new_state = not current
        self._gate_override = new_state
        for r in self.rooms.values():
            r.ambience_open = new_state
        if self.hass.states.get("input_boolean.ambient_gate") is not None:
            await self.hass.services.async_call(
                "input_boolean",
                "turn_on" if new_state else "turn_off",
                {"entity_id": "input_boolean.ambient_gate"},
                context=self.writer.new_context(),
            )
        await self.async_request_refresh()
        return new_state

    def _clear_work_mode(self) -> None:
        """Auto-clear every Special Mode helper when night mode or morning release fires."""
        on = [h for h in MODE_HELPERS.values() if self._is_on(h, default=False)]
        if not on:
            return
        _LOGGER.info("Solace: auto-clearing special mode helpers %s", on)
        domain, service = (
            ("input_boolean", "turn_off")
            if self.hass.services.has_service("input_boolean", "turn_off")
            else ("homeassistant", "turn_off")
        )
        self.hass.async_create_task(
            self.hass.services.async_call(
                domain, service, {"entity_id": on}, context=self.writer.new_context()
            )
        )

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
        any_lit = any(
            sol.level > 0
            for room in self.rooms.values()
            for sol in room.solutions.values()
        )
        if self._away() or self._asleep() or (not any_lit and not anyone_home):
            seconds = house.update_interval_max_s
        elif volatility > house.lux_volatility_lx and any_lit:
            seconds = house.update_interval_min_s
        elif anyone_home:
            seconds = house.update_interval_home_s
        else:
            seconds = house.update_interval_max_s
        seconds = max(float(seconds), 1.0)
        if self.update_interval != timedelta(seconds=seconds):
            self.update_interval = timedelta(seconds=seconds)
