"""Constants and the settings schema.

The settings table below is the **single definition** of every tunable. The number
platform, the config flow and the panel are all generated from it, so adding a knob is
one row here rather than four edits that drift apart.

⚠️ **The domain is `solace`, never `sol`.** Two independent reasons:

1. OpenAI ships a top-tier agent called Sol — don't take the name.
2. ``sol_*`` and ``solar_*`` entity IDs are already live in this house and unrelated
   (away-mode automations, 10 heating entities). A ``sol_`` prefix would collide with
   working, non-lighting automations.
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
"""⚠️ `sensor.pixel_8a_do_not_disturb_sensor` is a **4-value enum**
(`off` / `priority_only` / `alarms_only` / `total_silence`), NOT a binary sensor. A
plain `state == "on"` test never matches it, so night mode would simply never engage —
silently, because nothing errors.

Owner, 2026-08-13: *"When in priority only it means I'm sleeping."* So `priority_only`
is the sleep signal, and `alarms_only` / `total_silence` deliberately are **not**.
`"on"` is kept so the setting also works if pointed at a plain input_boolean.

The 2026-07 automation hit the same wall and solved it with a bridging input_boolean;
reading the enum directly removes that moving part."""

CONF_SLEEP_TOGGLE = "sleep_toggle_entity"
"""Optional manual sleep switch, OR-ed with the phone's DND. The owner's "Sleep now"
button — a third sleep signal for when the phone has not caught up yet."""
CONF_ALARM_ENTITY = "alarm_entity"
"""`sensor.pixel_8a_next_alarm`. Night mode ends `alarm_lead_minutes` before it."""

CONF_LIGHTS = "lights"
CONF_PRESENCE = "presence"
CONF_NEAR_PRESENCE = "near_presence"
CONF_PER_LIGHT = "per_light"
CONF_RAMP = "ramp"
CONF_ZONES = "zones"
"""Sub-zones inside an area. A list of dicts: zone_id, name, lights, presence,
bias_stops, diminish_pct. Managed from the panel, not the config flow — a dynamic
nested list is miserable in a voluptuous form and pleasant in a real UI."""

# The one illuminance sensor in the house. There are no indoor lux sensors; per-room
# daylight is estimated, never measured.
DEFAULT_LUX_SENSOR = "sensor.entry_exterior_illuminance"

# Adaptive update interval bounds (seconds). Scale to how fast the world is moving:
# tuning ⇒ immediate, lux volatile ⇒ ~30 s, stable+occupied ⇒ 2-5 min, empty ⇒ 10 min.
DEFAULT_MIN_INTERVAL_S = 30
DEFAULT_MAX_INTERVAL_S = 600

# HA context ids cap at 36 characters, so the prefix has to be short.
CONTEXT_PREFIX = "solace"

# Attribute deltas above which a change is treated as a HUMAN touch rather than our own
# echo. Bulbs echo back values that differ slightly from what was commanded, so exact
# comparison flags every echo as manual. Adaptive Lighting's measured thresholds.
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
    # A boolean carried as 0/1 so it lives in the one settings table with everything
    # else. The panel renders it as a switch. It was a hardcoded True whose own docstring
    # claimed it was a helper — which is the failure mode the core rule exists to stop.
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
    # Transitions — every command sends one explicitly; omitting it inherits a hidden 4 s.
    Setting("transition_on_s", "Transition on", 0, 60, 0.1, 2, "s", "mdi:transition"),
    Setting("transition_off_s", "Transition off", 0, 60, 0.1, 4, "s", "mdi:transition"),
    Setting("transition_mode_s", "Transition mode change", 0, 300, 0.1, 10, "s", "mdi:transition"),
    Setting("transition_setting_s", "Transition while tuning", 0, 5, 0.1, 0.5, "s", "mdi:gesture-swipe"),
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
    # Clock 2 — the adaptive interval. These were module constants until the panel
    # landed, which made them exactly the kind of value the brief calls a bug: "a value
    # that cannot be changed from the panel is a bug".
    Setting("update_interval_min_s", "Update interval min", 5, 3600, 1, 30, "s", "mdi:timer-play"),
    Setting("update_interval_home_s", "Update interval occupied", 5, 3600, 1, 150, "s", "mdi:timer"),
    Setting("update_interval_max_s", "Update interval max", 5, 3600, 1, 600, "s", "mdi:timer-off"),
    Setting("lux_volatility_lx", "Lux volatility threshold", 0, 2000, 1, 50, "lx", "mdi:waves"),
    # -- Values that were literals in the logic until 2026-08-13 -------------------
    # The rule is "nothing is hardcoded", and these were all in breach: buried in
    # coordinator.py, writer.py and fade.py rather than in this table.
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
    # -- Smoothness (AuDHD rule: never jump) ---------------------------------------
    Setting("morning_glide_minutes", "Morning colour glide", 0, 240, 1, 90, "min", "mdi:weather-sunset-up"),
    Setting("evening_axis_hour", "Evening starts at", 0, 23.75, 0.25, 15, "h", "mdi:clock-start"),
    Setting("ramp_onset_minutes", "Evening ramp onset", 0, 240, 1, 30, "min", "mdi:ray-start-arrow"),
    Setting("alarm_stale_minutes", "Ignore alarms older than", 5, 720, 1, 120, "min", "mdi:alarm-off"),
    Setting("demand_floor_level", "Dimmest level while dark", 1, 254, 1, 1, None, "mdi:arrow-collapse-down"),
    # Display only
    Setting("gamma", "Gamma (display only)", 1, 4, 0.01, 2.39, None, "mdi:chart-bell-curve"),
)

#: Per-room settings, one set per subentry.
ROOM_SETTINGS: tuple[Setting, ...] = (
    Setting("bias_stops", "Room bias", -4, 4, 0.05, 0, "stops", "mdi:tune", scope="room"),
    Setting("zone_bias_stops", "Zone bias", -4, 4, 0.05, 0, "stops", "mdi:tune", scope="room"),
    Setting("diminish_pct", "Diminish", 0, 100, 1, 0, "%", "mdi:arrow-down-circle", scope="room"),
    # Per-room ambience. The handoff's Home tab puts an ambience control on every room
    # card; the house floor alone could not express that. 0 ⇒ this room takes the house
    # floor, which keeps the handoff's "a control at zero is simply unmodified" rule and
    # avoids an inheritance sentinel.
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
)

HOUSE_DEFAULTS = {s.key: s.default for s in HOUSE_SETTINGS}
ROOM_DEFAULTS = {s.key: s.default for s in ROOM_SETTINGS}
