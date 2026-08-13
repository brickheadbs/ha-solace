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
    CONF_DND_ENTITY,
    CONF_DND_SLEEP_STATES,
    CONF_LIGHTS,
    CONF_LUX_SENSOR,
    CONF_NEAR_PRESENCE,
    CONF_PER_LIGHT,
    CONF_PRESENCE,
    CONF_RAMP,
    CONF_SLEEP_TOGGLE,
    DEFAULT_DND_SLEEP_STATES,
    DEFAULT_MAX_INTERVAL_S,
    DEFAULT_MIN_INTERVAL_S,
    DOMAIN,
    HOUSE_DEFAULTS,
    MANUAL_BRIGHTNESS_THRESHOLD,
    MANUAL_KELVIN_THRESHOLD,
    ROOM_DEFAULTS,
    SUBENTRY_TYPE_ROOM,
)
from .engine import ambient_gate, debounce_gate, solve
from .models import (
    EngineInput,
    HouseSettings,
    LightSettings,
    Mode,
    RampPoint,
    RoomSettings,
    Solution,
)
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
    gate_open: bool = False
    gate_pending_since: float | None = None
    last_mode: Mode = Mode.NORMAL

    def is_manual(self, hold_minutes: float, now: float) -> bool:
        if self.manual_switch:
            return True
        if not self.manual_touched or self.manual_since is None:
            return False
        if hold_minutes <= 0:
            return False
        return (now - self.manual_since) < hold_minutes * 60.0


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
                hass, _LOGGER, cooldown=0.3, immediate=True
            ),
        )
        self.writer = LightWriter(hass)
        self.rooms: dict[str, RoomState] = {}
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._lux_history: list[float] = []
        self._last_good_lux: float | None = None
        self._lux_warned = False
        self._night_latched = False
        self._unsubscribes: list[Any] = []

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
        fields = {
            key: value
            for key, value in options.items()
            if key in HouseSettings.__slots__ and key != "ramp"
        }
        fields["night_level"] = int(fields.get("night_level", 3))
        fields["night_release_lux"] = float(fields.get("night_release_lux", 10.0))
        fields["alarm_lead_minutes"] = float(fields.get("alarm_lead_minutes", 30.0))
        fields["ambience_level"] = int(fields.get("ambience_level", 0))
        fields["min_cutoff"] = int(fields.get("min_cutoff", 1))
        fields["rate_limit_step"] = int(fields.get("rate_limit_step", 0))
        fields["dead_zone"] = int(fields.get("dead_zone", 2))
        fields["day_kelvin"] = int(fields.get("day_kelvin", 4000))
        fields["night_kelvin"] = int(fields.get("night_kelvin", 2200))
        fields["colour_trim_kelvin"] = int(fields.get("colour_trim_kelvin", 0))
        fields["colour_step_mired"] = int(fields.get("colour_step_mired", 5))
        fields["ramp"] = tuple(
            RampPoint(hour=float(p["hour"]), stops=float(p["stops"])) for p in ramp
        )
        return HouseSettings(**fields)

    def room_settings(self, subentry: ConfigSubentry) -> RoomSettings:
        data = {**ROOM_DEFAULTS, **subentry.data}
        return RoomSettings(
            name=subentry.title,
            bias_stops=float(data.get("bias_stops", 0.0)),
            zone_bias_stops=float(data.get("zone_bias_stops", 0.0)),
            diminish_pct=float(data.get("diminish_pct", 0.0)),
            night_off=bool(data.get("night_off", False)),
            manual_hold_minutes=float(data.get("manual_hold_minutes", 30.0)),
        )

    def light_settings(self, entity_id: str, subentry: ConfigSubentry) -> LightSettings:
        """Per-light settings, with the hardware facts read from the live entity.

        Kelvin limits are **never guessed** — five bulbs in this house stop at 4000 K and
        six floor at 2702 K, and an out-of-range request is accepted, pinned, and logged
        as a success.
        """
        overrides = (subentry.data.get(CONF_PER_LIGHT) or {}).get(entity_id, {})
        state = self.hass.states.get(entity_id)
        min_kelvin = 2000
        max_kelvin = 9009
        family = None
        if state is not None:
            min_kelvin = int(state.attributes.get("min_color_temp_kelvin") or min_kelvin)
            max_kelvin = int(state.attributes.get("max_color_temp_kelvin") or max_kelvin)
            family = infer_family(state)
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
        if dnd := self.config_entry.options.get(CONF_DND_ENTITY):
            triggers.append(dnd)
        for subentry in self._subentries():
            for key in (CONF_PRESENCE, CONF_NEAR_PRESENCE):
                value = subentry.data.get(key)
                if isinstance(value, str):
                    triggers.append(value)
                elif value:
                    triggers.extend(value)
        for key in (CONF_SLEEP_TOGGLE, CONF_ALARM_ENTITY):
            if extra := (self.config_entry.options.get(key) or self.config_entry.data.get(key)):
                triggers.append(extra)
        triggers = [t for t in triggers if t]
        if triggers:
            self._unsubscribes.append(
                async_track_state_change_event(self.hass, triggers, self._on_world_change)
            )

        # Colour runs on its own clock — small stepped absolutes, never a long fade.
        self._unsubscribes.append(
            async_track_time_interval(
                self.hass, self._async_colour_tick, timedelta(seconds=self._colour_interval())
            )
        )

    @callback
    def async_shutdown_listeners(self) -> None:
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

        for subentry in self._subentries():
            room = self.rooms.setdefault(
                subentry.subentry_id,
                RoomState(subentry_id=subentry.subentry_id, name=subentry.title),
            )
            settings = self.room_settings(subentry)
            # "Either kitchen sensor turning on lights the whole kitchen" — presence is
            # a LIST and any-on wins. A single sensor per room could not express that.
            occupied = self._any_on(subentry.data.get(CONF_PRESENCE), default=True)
            near_clear = not self._any_on(subentry.data.get(CONF_NEAR_PRESENCE), default=True)

            raw_gate = ambient_gate(lux, room.gate_open, house)
            room.gate_open, room.gate_pending_since = debounce_gate(
                raw_gate, room.gate_open, loop_now, room.gate_pending_since, house
            )

            manual = room.is_manual(settings.manual_hold_minutes, now.timestamp())
            if not manual and room.manual_touched and not room.manual_switch:
                room.manual_touched = False
                room.manual_since = None

            for entity_id in subentry.data.get(CONF_LIGHTS, []):
                try:
                    await self._async_apply_light(
                        entity_id, subentry, house, settings, room, lux, dnd, clock_hour,
                        occupied, near_clear, manual, asleep,
                    )
                except Exception:  # noqa: BLE001
                    # One unreachable bulb must not take down the room, and must never
                    # fail the *first* refresh — that would put the whole entry into a
                    # ConfigEntryNotReady retry loop and leave the house with no engine
                    # at all. Log it and keep driving everything else.
                    _LOGGER.exception("Solace: failed to apply %s", entity_id)

            room.last_mode = Mode.NIGHT if self._night_active() else Mode.NORMAL

        self._retune_interval(lux)
        return self.rooms

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
    ) -> None:
        state = self.hass.states.get(entity_id)
        if state is None:
            return

        light = self.light_settings(entity_id, subentry)
        current = int(state.attributes.get("brightness") or 0)
        if state.state != STATE_ON:
            current = 0

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
                gate_open=room.gate_open,
                diminish_active=near_clear and settings.diminish_pct > 0,
                manual_level=current if manual else None,
                current_level=current,
                last_written_level=room.last_written.get(entity_id),
            ),
        )
        room.solutions[entity_id] = solution

        # Manual wins: compute and display, but never write.
        if manual or not solution.should_write:
            return

        if solution.level <= 0:
            if current > 0:
                await self.writer.async_turn_off(entity_id, house.transition_off_s)
                room.last_written[entity_id] = 0
            return

        was_off = current == 0
        if was_off:
            transition = house.transition_on_s
        elif solution.mode is not room.last_mode:
            transition = house.transition_mode_s
        else:
            # Tracking moves are small by construction (rate limit + dead zone), so they
            # reuse the mode-change glide rather than adding a fifth knob.
            transition = house.transition_mode_s

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
            settings = self.room_settings(subentry)
            if room is None or room.is_manual(settings.manual_hold_minutes, dt_util.utcnow().timestamp()):
                continue
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
                    step_mired=house.colour_step_mired,
                    step_transition_s=house.colour_step_transition_s,
                )

    def _colour_interval(self) -> float:
        """Derive the colour tick from the glide, never hardcode it.

        The full traverse divided into steps of ``colour_step_mired`` gives the number of
        steps; the glide duration divided by that gives the hold between them. Change the
        glide or the step size and the cadence follows.
        """
        house = self.house
        from .colour import kelvin_to_mired

        span = abs(kelvin_to_mired(house.night_kelvin) - kelvin_to_mired(house.day_kelvin))
        steps = max(1, span / max(house.colour_step_mired, 1))
        return max(house.colour_glide_minutes * 60.0 / steps, house.colour_step_transition_s * 2)

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
        if new is None:
            return

        # ⚠️ A z2m reconnect drives a bulb unknown/unavailable -> on. That is not a
        # human, and counting it would drop the room into manual for the whole hold
        # window every time the mesh hiccups. This house has a documented history of
        # edge-driven automations being stranded by exactly this transition.
        transient = {"unknown", "unavailable"}
        if new.state in transient:
            return
        if old is not None and old.state in transient:
            return

        touched = False
        if old is None or old.state != new.state:
            touched = True
        else:
            old_brightness = old.attributes.get("brightness") or 0
            new_brightness = new.attributes.get("brightness") or 0
            if abs(new_brightness - old_brightness) > MANUAL_BRIGHTNESS_THRESHOLD:
                touched = True
            old_kelvin = old.attributes.get("color_temp_kelvin") or 0
            new_kelvin = new.attributes.get("color_temp_kelvin") or 0
            if abs(new_kelvin - old_kelvin) > MANUAL_KELVIN_THRESHOLD:
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
        in a house whose owner is light-sensitive and whose whole reason for automating
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

    def _asleep(self) -> bool:
        """Is he asleep RIGHT NOW — phone DND, or the manual sleep toggle."""
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
        return dt_util.utcnow() >= alarm - timedelta(minutes=house.alarm_lead_minutes)

    def _update_night_latch(self, asleep: bool, lux: float, house: HouseSettings) -> None:
        """Night mode is LATCHED. This is the correction that matters most.

        Measured over 72 h: the phone's DND clears the moment he gets out of bed. So a
        night mode defined as "DND is on right now" ends the instant he stands up at
        3 am — the engine then recomputes from a pitch-dark lux reading and lights every
        occupied room at full demand, straight into his face.

        Enter on sleep. Leave on the world's terms, not his posture:
          * outdoor lux above ``night_release_lux`` (dawn), or
          * ``alarm_lead_minutes`` before the next alarm.

        Getting up does **not** end it — which is exactly the described behaviour: the
        lights come on at the low night setting and he can see.

        ⚠️ While he is asleep the latch is re-asserted every tick, so neither release can
        fire underneath him. That is also why there is no per-room "ignore the lux
        release" exemption: the bedroom cannot be released while he is still in it
        asleep, because being asleep is what holds the latch.
        """
        if asleep:
            if not self._night_latched:
                _LOGGER.debug("Solace: entering night mode (asleep)")
            self._night_latched = True
            return
        if not self._night_latched:
            return
        if self._alarm_released(house):
            _LOGGER.debug("Solace: leaving night mode (alarm lead)")
            self._night_latched = False
        elif lux >= house.night_release_lux:
            # ⚠️ CLEAR the latch, do not merely mask it. Masking (an "is released" flag
            # consulted per room) leaves `_night_latched` True forever, so the next time
            # it simply gets dark the house drops back into night mode without him ever
            # having gone to sleep. Caught live: a test left the latch set, and the
            # following run read `night` at dusk on a fully awake house.
            _LOGGER.debug("Solace: leaving night mode (lux %s)", lux)
            self._night_latched = False

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
        if new is None:
            return

        # ⚠️ A z2m reconnect drives a bulb unknown/unavailable -> on. That is not a
        # human, and counting it would drop the room into manual for the whole hold
        # window every time the mesh hiccups. This house has a documented history of
        # edge-driven automations being stranded by exactly this transition.
        transient = {"unknown", "unavailable"}
        if new.state in transient:
            return
        if old is not None and old.state in transient:
            return

        touched = False
        if old is None or old.state != new.state:
            touched = True
        else:
            old_brightness = old.attributes.get("brightness") or 0
            new_brightness = new.attributes.get("brightness") or 0
            if abs(new_brightness - old_brightness) > MANUAL_BRIGHTNESS_THRESHOLD:
                touched = True
            old_kelvin = old.attributes.get("color_temp_kelvin") or 0
            new_kelvin = new.attributes.get("color_temp_kelvin") or 0
            if abs(new_kelvin - old_kelvin) > MANUAL_KELVIN_THRESHOLD:
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
        in a house whose owner is light-sensitive and whose whole reason for automating
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

    def _dnd(self) -> bool:
        """Asleep?

        NOT an on/off test. The phone's DND sensor is a four-value enum, so `== "on"`
        would never match and night mode would never engage — with no error to show for
        it. Match against the configured sleep states instead.
        """
        entity_id = self.config_entry.options.get(
            CONF_DND_ENTITY
        ) or self.config_entry.data.get(CONF_DND_ENTITY)
        if not entity_id:
            return False
        state = self.hass.states.get(entity_id)
        if state is None or state.state in ("unknown", "unavailable"):
            return False
        sleep_states = self.config_entry.options.get(
            CONF_DND_SLEEP_STATES
        ) or DEFAULT_DND_SLEEP_STATES
        return state.state in sleep_states

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
        hardcoded 45.5°N; this house is at 54.05°N, where the winter sun caps at 12.5°.
        """
        sun = self.hass.states.get("sun.sun")
        if sun is None:
            return 21.5
        # ⚠️ `next_dusk` flips to TOMORROW's dusk the moment today's passes — so reading
        # it during the evening glide (exactly when it matters) returns the wrong day.
        # The clock hour barely moves day to day, so the error is small and would have
        # hidden here for months. Prefer the sun's own "below horizon" reading: once
        # dusk has passed today, next_dusk is ~24 h out and we want today's, which is
        # next_dusk minus a day.
        raw = sun.attributes.get("next_dusk")
        parsed = dt_util.parse_datetime(raw) if raw else None
        if parsed is None:
            return 21.5
        local = dt_util.as_local(parsed)
        if (local - dt_util.now()).total_seconds() > 12 * 3600:
            local = local - timedelta(days=1)
        return local.hour + local.minute / 60.0

    def _retune_interval(self, lux: float) -> None:
        """Clock 2 — scale the poll to how fast the world is moving."""
        self._lux_history.append(lux)
        self._lux_history = self._lux_history[-5:]
        if len(self._lux_history) < 2:
            return
        volatility = max(self._lux_history) - min(self._lux_history)
        anyone_home = any(
            self._any_on(sub.data.get(CONF_PRESENCE), default=True) for sub in self._subentries()
        )
        if volatility > 50:
            seconds = DEFAULT_MIN_INTERVAL_S
        elif anyone_home:
            seconds = 150
        else:
            seconds = DEFAULT_MAX_INTERVAL_S
        if self.update_interval != timedelta(seconds=seconds):
            self.update_interval = timedelta(seconds=seconds)
