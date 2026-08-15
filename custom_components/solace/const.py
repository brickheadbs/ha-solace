"""Constants and the settings schema.

The settings table below is the **single definition** of every tunable. The number
platform, the config flow and the panel are all generated from it, so adding a knob is
one row here rather than four edits that drift apart.

⚠️ **The domain is `solace`, never `sol`.**
"""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.const import Platform

DOMAIN = "solace"

PLATFORMS: list[Platform] = [
    Platform.BINARY_SENSOR,
    Platform.NUMBER,
    Platform.SENSOR,
    Platform.SWITCH,
]

SUBENTRY_TYPE_ROOM = "room"

# -- Config keys -------------------------------------------------------------------
CONF_LUX_SENSOR = "lux_sensor"
CONF_DND_ENTITY = "dnd_entity"
CONF_DND_SLEEP_STATES = "dnd_sleep_states"
DEFAULT_DND_SLEEP_STATES = ("on", "priority_only")

CONF_SLEEP_TOGGLE = "sleep_toggle_entity"
CONF_ALARM_ENTITY = "alarm_entity"
CONF_AWAY_ENTITY = "away_entity"
CONF_REMOTES = "remotes"

CONF_LIGHTS = "lights"
CONF_PRESENCE = "presence"
CONF_NEAR_PRESENCE = "near_presence"
CONF_PER_LIGHT = "per_light"
CONF_RAMP = "ramp"
CONF_ZONES = "zones"
CONF_LUX_CURVE = "lux_curve"
CONF_LUX_CLOUDY_CURVE = "lux_cloudy_curve"
CONF_BRIGHTNESS_TIMELINE = "brightness_timeline"
CONF_COLOUR_TIMELINE = "colour_timeline"
CONF_SUNRISE_CURVE = "sunrise_curve"
CONF_SUNSET_CURVE = "sunset_curve"
CONF_WEATHER_ENTITY = "weather_entity"

DEFAULT_LUX_SENSOR = "sensor.entry_exterior_illuminance"
DEFAULT_WEATHER_ENTITY = "weather.forecast_home"

DEFAULT_MIN_INTERVAL_S = 30
DEFAULT_MAX_INTERVAL_S = 600

CONTEXT_PREFIX = "solace"

MANUAL_BRIGHTNESS_THRESHOLD = 25
MANUAL_KELVIN_THRESHOLD = 100


@dataclass(frozen=True, slots=True)
class Setting:
    """One tunable, rendered as a `number` entity and a config-flow field."""

    key: str
    name: str
    minimum: float
    maximum: float
    step: float
    default: float
    unit: str | None = None
    icon: str | None = None
    scope: str = "house"


#: House-wide settings. Order is the order they appear in the UI.
HOUSE_SETTINGS: tuple[Setting, ...] = (
    # Master Processing: Modifiers
    Setting("mood_trim_stops", "Master mood trim", -4, 4, 0.05, 0, "stops", "mdi:tune"),
    # Ambient gate
    Setting("ambience_start_lux", "Gate start lux", 0, 2000, 1, 50, "lx", "mdi:weather-sunset-down"),
    Setting("ambience_stop_lux", "Gate stop lux", 0, 2000, 1, 80, "lx", "mdi:weather-sunset-up"),
    Setting("ambience_debounce_falling_s", "Gate debounce falling", 0, 900, 0.5, 0, "s", "mdi:timer-sand"),
    Setting("ambience_debounce_rising_s", "Gate debounce rising", 0, 900, 0.5, 0, "s", "mdi:timer-sand"),
    # Demand
    Setting("lux_full", "Demand full lux", 0.1, 500, 0.1, 1, "lx", "mdi:brightness-7"),
    Setting("lux_window", "Demand window", 1, 5000, 1, 539, "lx", "mdi:arrow-expand-horizontal"),
    # Bias
    Setting("bias_stops", "House bias", -4, 4, 0.05, 0, "stops", "mdi:tune"),
    # Levels
    Setting("night_level", "Night level", 0, 254, 1, 3, None, "mdi:weather-night"),
    Setting("night_release_lux", "Night release lux", 0, 500, 1, 10, "lx", "mdi:weather-sunset-up"),
    Setting("alarm_lead_minutes", "Night ends before alarm", 0, 240, 1, 30, "min", "mdi:alarm"),
    Setting("ambience_level", "Ambience floor", 0, 254, 1, 0, None, "mdi:lightbulb-night"),
    Setting(
        "ambience_ignores_occupancy",
        "Ambience in empty rooms",
        0,
        1,
        1,
        1,
        None,
        "mdi:account-off-outline",
    ),
    Setting("min_cutoff", "Minimum cutoff", 0, 254, 1, 1, None, "mdi:arrow-collapse-down"),
    Setting("rate_limit_step", "Rate limit", 0, 254, 1, 0, None, "mdi:speedometer-slow"),
    Setting("dead_zone", "Dead zone", 0, 50, 1, 2, None, "mdi:circle-off-outline"),
    # Transitions Matrix (7 Dedicated Speeds)
    # UP
    Setting("transition_up_occupancy_s", "Occupancy", 0, 60, 0.1, 2, "s", "mdi:motion-sensor"),
    Setting("transition_up_ambience_s", "Ambience", 0, 60, 0.1, 10, "s", "mdi:weather-sunset-down"),
    # DOWN
    Setting("transition_down_diminish_s", "Diminish", 0, 60, 0.1, 5, "s", "mdi:timer-outline"),
    Setting("transition_down_ambience_s", "Ambience", 0, 60, 0.1, 5, "s", "mdi:lightbulb-night-outline"),
    Setting("transition_down_off_s", "Off", 0, 60, 0.1, 4, "s", "mdi:power"),
    # CONTINUOUS & SPECIAL
    Setting("transition_automatic_s", "Automatic", 0, 120, 0.5, 15, "s", "mdi:auto-fix"),
    Setting("transition_manual_s", "Manual", 0, 5, 0.05, 0.5, "s", "mdi:gesture-swipe"),
    # Colour
    Setting("day_kelvin", "Day colour", 2000, 9000, 10, 4000, "K", "mdi:white-balance-sunny"),
    Setting("night_kelvin", "Night colour", 2000, 9000, 10, 2200, "K", "mdi:weather-night"),
    Setting("colour_glide_minutes", "Colour glide", 1, 240, 1, 90, "min", "mdi:transition"),
    Setting("colour_trim_kelvin", "Colour trim", -1000, 1000, 10, 0, "K", "mdi:tune-vertical"),
    Setting("colour_step_mired", "Colour step (stepped bulbs)", 1, 50, 1, 5, "mired", "mdi:stairs"),
    Setting(
        "colour_step_mired_smooth",
        "Colour step (smooth bulbs)",
        1,
        50,
        1,
        2,
        "mired",
        "mdi:wave",
    ),
    Setting("colour_catch_up_steps", "Colour catch-up", 1, 10, 1, 3, "x", "mdi:fast-forward"),
    Setting(
        "colour_step_transition_s",
        "Colour step fade",
        0.5,
        30,
        0.1,
        4,
        "s",
        "mdi:transition",
    ),
    # Timing
    Setting("morning_release_hour", "Morning release", 0, 23.75, 0.25, 6.5, "h", "mdi:weather-sunny"),
    Setting("update_interval_min_s", "Update interval min", 5, 3600, 1, 30, "s", "mdi:timer-play"),
    Setting("update_interval_home_s", "Update interval occupied", 5, 3600, 1, 150, "s", "mdi:timer"),
    Setting("update_interval_max_s", "Update interval max", 5, 3600, 1, 600, "s", "mdi:timer-off"),
    Setting("lux_volatility_lx", "Lux volatility threshold", 0, 2000, 1, 50, "lx", "mdi:waves"),
    Setting("refresh_debounce_s", "Refresh coalesce", 0, 5, 0.05, 0.3, "s", "mdi:motion-play"),
    Setting("dusk_fallback_hour", "Dusk fallback", 0, 23.75, 0.25, 21.5, "h", "mdi:weather-dusk"),
    Setting("lux_history_samples", "Lux samples kept", 2, 20, 1, 5, None, "mdi:chart-line"),
    Setting("manual_brightness_threshold", "Manual detect: brightness", 0, 254, 1, 25, None, "mdi:hand-back-right"),
    Setting("manual_kelvin_threshold", "Manual detect: colour", 0, 2000, 10, 100, "K", "mdi:hand-back-right"),
    Setting("fallback_min_kelvin", "Fallback min Kelvin", 1000, 4000, 10, 2000, "K", "mdi:thermometer-low"),
    Setting("fallback_max_kelvin", "Fallback max Kelvin", 2000, 20000, 10, 9009, "K", "mdi:thermometer-high"),
    Setting("family_cct_max_kelvin", "Family split: CCT ceiling", 2000, 9000, 10, 4200, "K", "mdi:call-split"),
    Setting("family_rgb_max_kelvin", "Family split: RGB ceiling", 2000, 20000, 10, 7000, "K", "mdi:call-split"),
    Setting("colour_rate_floor", "Colour rate floor", 0.05, 1, 0.001, 0.156, "mired/s", "mdi:speedometer-slow"),
    Setting("colour_rate_safety", "Colour rate safety", 1, 5, 0.05, 1.5, "x", "mdi:shield-half-full"),
    # Smoothness & Ramp
    Setting("morning_glide_minutes", "Morning colour glide", 0, 240, 1, 90, "min", "mdi:weather-sunset-up"),
    Setting("evening_axis_hour", "Evening starts at", 0, 23.75, 0.25, 15, "h", "mdi:clock-start"),
    Setting("ramp_onset_minutes", "Evening ramp onset", 0, 240, 1, 30, "min", "mdi:ray-start-arrow"),
    Setting("alarm_stale_minutes", "Ignore alarms older than", 5, 720, 1, 120, "min", "mdi:alarm-off"),
    Setting("demand_floor_level", "Dimmest level while dark", 1, 254, 1, 1, None, "mdi:arrow-collapse-down"),
    # The 3 Bedroom Special Modes
    Setting("bedroom_sleep_forced_off", "Bedroom sleep forced off", 0, 1, 1, 1, None, "mdi:power-sleep"),
    Setting("sunrise_fade_enabled", "Virtual sunrise fade", 0, 1, 1, 1, None, "mdi:weather-sunset-up"),
    Setting("sunrise_fade_minutes", "Virtual sunrise duration", 5, 120, 1, 30, "min", "mdi:timer-sand"),
    Setting("virtual_sunrise_target_level", "Virtual sunrise target level", 0, 254, 1, 180, None, "mdi:weather-sunset-up"),
    Setting("sunset_fade_enabled", "Virtual sunset fade", 0, 1, 1, 1, None, "mdi:weather-sunset-down"),
    Setting("sunset_fade_minutes", "Virtual sunset duration", 5, 120, 1, 20, "min", "mdi:timer-sand"),
    Setting("sunset_dwell_minutes", "Bedroom presence dwell", 0, 60, 1, 5, "min", "mdi:account-clock"),
    Setting("bedtime_dwell_enabled", "Bedtime wind-down", 0, 1, 1, 1, None, "mdi:bed-outline"),
    Setting("bedtime_dwell_hour", "Bedtime wind-down hour", 0, 23.75, 0.25, 22.5, "h", "mdi:bed-clock"),
    Setting("bedtime_dwell_level", "Bedtime wind-down level", 0, 254, 1, 15, None, "mdi:bed"),
    # Display only
    Setting("gamma", "Gamma (display only)", 1, 4, 0.01, 2.39, None, "mdi:chart-bell-curve"),
)

#: Per-room settings, one set per subentry.
ROOM_SETTINGS: tuple[Setting, ...] = (
    Setting("bias_stops", "Room bias", -4, 4, 0.05, 0, "stops", "mdi:tune", scope="room"),
    Setting("zone_bias_stops", "Zone bias", -4, 4, 0.05, 0, "stops", "mdi:tune", scope="room"),
    Setting("diminish_stops", "Diminish stops", 0, 4, 0.05, 0, "stops", "mdi:arrow-down-circle", scope="room"),
    Setting("diminish_pct", "Diminish", 0, 100, 1, 40, "%", "mdi:arrow-down-circle", scope="room"),
    Setting(
        "ambience_level",
        "Room ambience",
        0,
        254,
        1,
        0,
        None,
        "mdi:lightbulb-night",
        scope="room",
    ),
    Setting(
        "manual_hold_minutes",
        "Manual hold",
        0,
        1440,
        1,
        30,
        "min",
        "mdi:hand-back-right",
        scope="room",
    ),
    Setting("manual_mode", "Manual mode toggle", 0, 1, 1, 0, None, "mdi:hand-back-right", scope="room"),
    Setting("sunrise_enabled", "Virtual sunrise in room", 0, 1, 1, 0, None, "mdi:weather-sunset-up", scope="room"),
    Setting("sunset_enabled", "Virtual sunset in room", 0, 1, 1, 0, None, "mdi:weather-sunset-down", scope="room"),
    Setting("bedtime_dwell_enabled", "Bedtime wind-down in room", 0, 1, 1, 0, None, "mdi:bed-outline", scope="room"),
)

HOUSE_DEFAULTS = {s.key: s.default for s in HOUSE_SETTINGS}
ROOM_DEFAULTS = {s.key: s.default for s in ROOM_SETTINGS}
