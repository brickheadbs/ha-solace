// === BEGIN REQUIRED AGENT READING: SOLACE & HA WIRING SPEC ===
/**
 * Canonical Solace Lighting Engine & Home Assistant Wiring Specification.
 *
 * AGENT MANDATE:
 * 1. Read this entire specification block before modifying `ha-solace`, Home Assistant
 *    automations, sensors, or Solace room/house configuration.
 * 2. Update this file in the same commit/PR whenever any cutoff, clamp, room exception,
 *    priority rule, setting key, or house automation changes.
 * 3. `tests/test_help_spec.py` enforces 1:1 key parity between `TRACKED_HOUSE_KEYS` /
 *    `TRACKED_ROOM_KEYS` and `custom_components/solace/const.py`.
 */

export interface PipelineStage {
  step: number;
  title: string;
  formula: string;
  summary: string;
  keys: string[];
}

export interface PriorityRule {
  rank: number;
  mode: string;
  trigger: string;
  outputRule: string;
  releaseRule: string;
}

export interface CutoffRule {
  name: string;
  scope: "House" | "Room" | "Per-Light" | "Hardware";
  key: string;
  rule: string;
  exemptions: string;
}

export interface RoomExceptionSpec {
  room: string;
  subtitle: string;
  rules: Array<{ label: string; detail: string }>;
}

export interface AutomationStrip {
  group: "Front Door & U200 Lock" | "Lighting & Presence" | "Appliances & Safety";
  name: string;
  entityId: string;
  trigger: string;
  guard: string;
  action: string;
}

/**
 * 1:1 registry of every tunable key in `custom_components/solace/const.py`.
 * Verified by `tests/test_help_spec.py` so no setting can drift undocumented.
 */
export const TRACKED_HOUSE_KEYS: readonly string[] = [
  "cloudy_blend_threshold",
  "sunny_override_lux",
  "mood_trim_stops",
  "ambience_start_lux",
  "ambience_stop_lux",
  "ambience_debounce_falling_s",
  "ambience_debounce_rising_s",
  "lux_full",
  "lux_window",
  "bias_stops",
  "night_level",
  "night_release_lux",
  "alarm_lead_minutes",
  "ambience_level",
  "ambience_ignores_occupancy",
  "min_cutoff",
  "rate_limit_step",
  "dead_zone",
  "transition_up_occupancy_s",
  "transition_up_occupied_on_s",
  "transition_up_ambience_s",
  "transition_down_diminish_s",
  "transition_down_ambience_s",
  "transition_down_off_s",
  "transition_automatic_s",
  "transition_manual_s",
  "day_kelvin",
  "night_kelvin",
  "colour_heartbeat_s",
  "colour_trim_kelvin",
  "colour_step_mired_smooth",
  "colour_catch_up_steps",
  "colour_step_transition_s",
  "morning_release_hour",
  "update_interval_min_s",
  "update_interval_home_s",
  "update_interval_max_s",
  "lux_volatility_lx",
  "refresh_debounce_s",
  "dusk_fallback_hour",
  "lux_history_samples",
  "fallback_min_kelvin",
  "fallback_max_kelvin",
  "family_rgb_max_kelvin",
  "colour_rate_floor",
  "colour_rate_safety",
  "morning_glide_minutes",
  "evening_axis_hour",
  "ramp_onset_minutes",
  "alarm_stale_minutes",
  "demand_floor_level",
  "bedroom_sleep_forced_off",
  "sunrise_fade_enabled",
  "sunrise_fade_minutes",
  "virtual_sunrise_target_level",
  "sunset_fade_enabled",
  "sunset_fade_minutes",
  "sunset_dwell_minutes",
  "bedtime_dwell_enabled",
  "bedtime_dwell_hour",
  "bedtime_dwell_level",
  "work_mode_desk_level",
  "work_mode_backlight_level",
  "work_mode_corner_level",
  "work_mode_debounce_minutes",
  "stairway_start_lux",
  "stairway_full_lux",
  "gamma",
] as const;

export const TRACKED_ROOM_KEYS: readonly string[] = [
  "bias_stops",
  "threshold_stops",
  "zone_bias_stops",
  "diminish_stops",
  "diminish_pct",
  "ambience_level",
  "occupied_min",
  "occupied_max",
  "manual_hold_minutes",
  "manual_mode",
  "sunrise_enabled",
  "sunset_enabled",
  "bedtime_dwell_enabled",
] as const;

export const PIPELINE_STAGES: readonly PipelineStage[] = [
  {
    step: 1,
    title: "Outdoor Lux",
    formula: "sensor.entry_exterior_illuminance",
    summary: "Live outdoor lux, falling back to persisted last_good_lux then clear-sky solar elevation on cold boot.",
    keys: ["lux_full", "lux_window"],
  },
  {
    step: 2,
    title: "Room Threshold",
    formula: "eff_lux = outdoor_lux / 2^(threshold_stops)",
    summary: "+EV divides perceived outdoor lux so shaded/north rooms cross the turn-on curve earlier.",
    keys: ["threshold_stops"],
  },
  {
    step: 3,
    title: "Sky Spline",
    formula: "outdoor_lux >= sunny_override_lux ? clear_spline : lerp(clear, cloudy, cloud_%)",
    summary: "Monotone Hermite spline maps effective lux -> 0..100% daylight deficit demand, blended by met.no cloud cover unless raw outdoor lux triggers sunny_override_lux.",
    keys: ["cloudy_blend_threshold", "sunny_override_lux"],
  },
  {
    step: 4,
    title: "24h Schedule",
    formula: "base_lvl = demand * schedule_lvl(hour)",
    summary: "Multiplies lux demand by the 24h circadian brightness ceiling (and mired-linear dusk colour glide).",
    keys: ["day_kelvin", "night_kelvin", "morning_glide_minutes"],
  },
  {
    step: 5,
    title: "Exposure Envelope",
    formula: "+EV: max(base*2^S, solve(eff_lux/2^S))",
    summary: "Sum of House + Mood + Room + Zone + Fixture stops. +EV shifts turn-on lux upward AND boosts dimmed evening ceilings.",
    keys: ["bias_stops", "mood_trim_stops", "zone_bias_stops"],
  },
  {
    step: 6,
    title: "Cutoff & Mode Gate",
    formula: "lvl < min_cutoff -> 0 (when gate closed)",
    summary: "Applies Priority Ladder, daytime min_cutoff, L3 ambience floor when dusk gate is open, and room occupied_min/max.",
    keys: ["min_cutoff", "ambience_start_lux", "ambience_stop_lux", "occupied_min", "occupied_max"],
  },
  {
    step: 7,
    title: "Fixture Clamp & Fade",
    formula: "clamp(clamp_min..clamp_max) + 8-speed fade",
    summary: "Enforces per-light hardware bounds, Aqara minimum floor (3/254), dead_zone anti-chatter, and state-pair transition speed.",
    keys: ["dead_zone", "transition_up_occupancy_s", "transition_automatic_s"],
  },
] as const;

export const PRIORITY_LADDER: readonly PriorityRule[] = [
  {
    rank: 1,
    mode: "Away Mode",
    trigger: "input_boolean.away_mode == ON",
    outputRule: "All Solace lights forced to 0 immediately (simulated deterrence runs separately after dark).",
    releaseRule: "Aqara U200 unlock, phone Wi-Fi home arrival, or manual Away toggle OFF.",
  },
  {
    rank: 2,
    mode: "Manual Hold",
    trigger: "Room segmented switch = Manual or remote manual latch",
    outputRule: "Solace stops all writes to that room; physical/UI slider level holds.",
    releaseRule: "Click 'Resume now' or manual_hold_minutes timer expires.",
  },
  {
    rank: 3,
    mode: "Work Mode (Office)",
    trigger: "input_boolean.work_mode == ON (Sonoff hold or UI toggle)",
    outputRule: "Office desk/backlight/corner fixtures lock to fixed task levels while Living Office is occupied.",
    releaseRule: "5 min unoccupied debounce pauses lights; Sleep/Night mode auto-clears switch overnight.",
  },
  {
    rank: 4,
    mode: "Virtual Sunrise",
    trigger: "Bedroom sunrise_enabled + within sunrise_fade_minutes of Target Wake-Up Time",
    outputRule: "Bedroom follows custom Sunrise Spline up to min(curve, daytime L1); casts Wake-Up Music at 100%.",
    releaseRule: "Anchor timeline completes; survives mid-fade alarm dismissal.",
  },
  {
    rank: 5,
    mode: "Asleep / Guest Sleep",
    trigger: "Phone DND = priority_only OR Pixel Watch = bedtime OR input_boolean.solace_sleep == ON",
    outputRule: "Rooms with night_off (Bedroom, and Living Office when Guest Mode ON) force 0; house latches Night Mode.",
    releaseRule: "Outdoor lux >= night_release_lux after morning_release_hour, or upcoming alarm lead-in.",
  },
  {
    rank: 6,
    mode: "Virtual Sunset",
    trigger: "Clock >= bedtime_dwell_hour + Bedroom occupied >= sunset_dwell_minutes",
    outputRule: "Bedroom fades down Sunset Spline and holds at Aqara floor (3 lvl) until Sleep triggers; suppresses house ambience once bedroom < kitchen L3.",
    releaseRule: "Leaving bedroom > 5 min resets session; Sleep Mode turns bedroom completely OFF (0).",
  },
  {
    rank: 7,
    mode: "Night Latched Corridor",
    trigger: "Night latch active + occupant stands up (DND clears at 3 AM)",
    outputRule: "Occupied rooms emit night_level @ night_kelvin (including Bedroom wake-in-night and Stairway, exempt from occupied_min).",
    releaseRule: "Unoccupied rooms stay 0 (all ambience suppressed while Night latch is active).",
  },
  {
    rank: 8,
    mode: "Normal Demand / Diminish / Ambience",
    trigger: "Awake + Normal Mode",
    outputRule: "Occupied -> L1 Demand (or L2 Diminish when near zone clears); Unoccupied -> L3 Ambience if dusk gate open, else 0.",
    releaseRule: "Continuous 1s event fast-path + periodic solar/colour tick.",
  },
] as const;

export const CUTOFFS_AND_CLAMPS: readonly CutoffRule[] = [
  {
    name: "Sunny Lux Override",
    scope: "House",
    key: "sunny_override_lux",
    rule: "When raw outdoor lux >= sunny_override_lux (live: 4,500 lx), forces 0% cloud blend (100% Clear Sun curve) across all rooms even if hourly met.no forecast lags.",
    exemptions: "Set to 0 lx to disable and rely strictly on weather.forecast_home cloud_coverage.",
  },
  {
    name: "Room Threshold Offset",
    scope: "Room",
    key: "threshold_stops",
    rule: "Divides outdoor lux by 2^EV (-3..+6 stops). +2 EV in Bedroom makes 800 lx outdoor read as 200 lx so lights turn on sooner.",
    exemptions: "Applies before Lux Curve and Ambience Gate; does not alter 0-lux midnight ceiling.",
  },
  {
    name: "Exposure Envelope Bias",
    scope: "Room",
    key: "bias_stops",
    rule: "Additive stops (House + Mood + Room + Zone + Light). +EV takes max(level * 2^EV, curve(lux / 2^EV)) so both threshold and dimmed schedules respond.",
    exemptions: "Negative EV scales gain smoothly down to Aqara hardware floor (3/254) without hard-snapping to 0.",
  },
  {
    name: "Daytime Low Cutoff",
    scope: "House",
    key: "min_cutoff",
    rule: "Drops computed L1/L2 demand below min_cutoff (live: 48/254) straight to 0 during daylight.",
    exemptions: "Disarmed when Ambience Gate is open, during Night Mode, Bedtime Dwell, Sunrise, and Sunset.",
  },
  {
    name: "Per-Light Cut & Max",
    scope: "Per-Light",
    key: "clamp_min / clamp_max",
    rule: "clamp_min acts as a per-fixture daytime cutoff -> 0; clamp_max is an unconditional hard ceiling across all automatic modes.",
    exemptions: "clamp_min is disarmed when Ambience Gate is open, in Ambience (L3), and in Night Mode (L1s).",
  },
  {
    name: "Occupied Room Bounds",
    scope: "Room",
    key: "occupied_min / occupied_max",
    rule: "Non-Stairway rooms clamp occupied Normal-mode output into [occupied_min, occupied_max]; Stairway uses these two values as Dark Minimum and Bright Maximum on its log2-lux Eye-Adaptation curve.",
    exemptions: "Exempt in Mode.NIGHT, Mode.AWAY, and Asleep night_off so night corridor uses night_level without glare.",
  },
  {
    name: "Ambience Dusk Hysteresis",
    scope: "House",
    key: "ambience_start_lux / ambience_stop_lux",
    rule: "Opens at <= start_lux (50 lx), closes at >= stop_lux (80 lx) with falling/rising debounce timers.",
    exemptions: "Suppressed in Stairway (always L3=0), during Night Latch, and when Bedroom Sunset drops below Kitchen L3.",
  },
  {
    name: "Aqara Hardware Rails",
    scope: "Hardware",
    key: "family_rgb_max_kelvin",
    rule: "All bulbs are Aqara Zigbee: AQARA_RGB (T2 RGB+CCT, 2000-9009 K) and AQARA_CCT (T1M/T2 CCT, 2702-6535 K), discriminated at max_kelvin >= 7000 K; minimum non-zero brightness = 3/254.",
    exemptions: "IKEA TRADFRI bulb quirks retired; IKEA Styrbar remotes remain supported as stateless Zigbee action controllers.",
  },
] as const;

export const ROOM_EXCEPTIONS: readonly RoomExceptionSpec[] = [
  {
    room: "Stairway",
    subtitle: "Single-window stairwell — Stairway-only log2-lux Eye-Adaptation curve",
    rules: [
      {
        label: "Eye-Adaptation Curve (Bright Out -> Bright In)",
        detail: "Exclusively on Stairway: blends log2(lux) from Dark Minimum (occupied_min = 45 lvl at <= stairway_start_lux = 10 lx) up to Bright Maximum (occupied_max = 226 lvl at >= stairway_full_lux = 2,000 lx) while following house colour temperature.",
      },
      {
        label: "Night Corridor Exemption",
        detail: "In Mode.NIGHT, Dark Minimum (45) is bypassed so 3 AM stairs run at night_level (26 lvl @ 2190 K).",
      },
      {
        label: "Zero Ambience & Cutoff Exempt",
        detail: "Hardcoded L3 = 0 (excluded from ambient lighting) and exempt from house min_cutoff (48) so dim evening Dark Minimum levels never drop to 0.",
      },
      {
        label: "0s Hold + 5m Entry Trigger",
        detail: "Motion hold is 0s (vs 90s elsewhere). Exterior/entry arrival fires a 5-min stairway timer that cancels immediately once Living Office or Bedroom occupancy turns ON.",
      },
    ],
  },
  {
    room: "Bedroom",
    subtitle: "North-facing sleep sanctuary — predictive ramps & hard dark sleep",
    rules: [
      {
        label: "North-Facing Offset",
        detail: "threshold_stops = +2.0 EV (effective lux = outdoor / 4) turns lights on earlier on overcast afternoons without changing night levels.",
      },
      {
        label: "Sleep Forced Zero",
        detail: "night_off = True: while asleep is active, lights stay 0 even on motion; once DND clears on standing up, Night Latch serves night_level.",
      },
      {
        label: "Predictive Sunrise & Sunset",
        detail: "Only room running Mode.SUNRISE and Mode.SUNSET splines; toilet trips <= 5m do not abort an active sunset fade.",
      },
    ],
  },
  {
    room: "Living Office",
    subtitle: "Dual-role studio & guest room",
    rules: [
      {
        label: "Work Mode Override",
        detail: "Locks desk lamp, monitor backlight, and corner bulb to dedicated task levels with a 5-min coffee-break debounce.",
      },
      {
        label: "Guest Mode",
        detail: "input_boolean.living_guest_mode treats room as a bedroom overnight (suppresses motion turn-on while asleep; Styrbar remote controls room).",
      },
    ],
  },
  {
    room: "Kitchen",
    subtitle: "Two-stage Near / Far presence diminish",
    rules: [
      {
        label: "Zone Diminish (L1 -> L2)",
        detail: "When prep/counter near sensor clears while wider room stays occupied, lights step down by diminish_pct (L2) before full clear.",
      },
      {
        label: "Sunset Ambience Coupling",
        detail: "Unoccupied kitchen L3 ambience automatically shuts off once Bedroom Virtual Sunset fades below kitchen's ambient level.",
      },
    ],
  },
] as const;

export const HOUSE_AUTOMATIONS: readonly AutomationStrip[] = [
  {
    group: "Front Door & U200 Lock",
    name: "Auto-Lock on Sleep",
    entityId: "automation.lock_auto_lock_u200_on_sleep_mode",
    trigger: "Sleep Mode turns ON (DND / Watch / Sleep switch)",
    guard: "lock.aqara_smart_lock_u200 is unlocked",
    action: "Locks U200 deadbolt immediately",
  },
  {
    group: "Front Door & U200 Lock",
    name: "Auto-Lock on Away",
    entityId: "automation.lock_auto_lock_u200_on_away_mode",
    trigger: "Away Mode arms OR Leaving in 5m timer finishes",
    guard: "lock.aqara_smart_lock_u200 is unlocked",
    action: "Locks U200 deadbolt + shuts off house lights",
  },
  {
    group: "Front Door & U200 Lock",
    name: "Arrival Disarm on Unlock",
    entityId: "automation.lock_disarm_away_on_u200_unlock",
    trigger: "lock.aqara_smart_lock_u200 -> unlocked",
    guard: "Away Mode or Leaving Pending is ON",
    action: "Disarms Away Mode + cancels Leaving Pending so entry lights greet arrival",
  },
  {
    group: "Front Door & U200 Lock",
    name: "Turret Hallway Greeting",
    entityId: "automation.arrival_portal_2_turret_hallway_greeting",
    trigger: "Away Mode ON -> OFF, synchronized to U200 unlock / Entry sensor",
    guard: "Sleep Mode OFF & Phone DND OFF (waits up to 5m if Wi-Fi disarmed outside)",
    action: "Casts random Portal 2 Sentry Turret clip on Entryway Display (Maya fallback)",
  },
  {
    group: "Front Door & U200 Lock",
    name: "Jammed / Low Battery Alert",
    entityId: "automation.lock_u200_jammed_or_low_battery_alert",
    trigger: "U200 state == jammed OR battery < 15%",
    guard: "1h notification cooldown",
    action: "Sends priority push alert to Pixel 8a",
  },
  {
    group: "Lighting & Presence",
    name: "Stairway 5m Entry Trigger",
    entityId: "automation.solace_stairway_5m_trigger_cancel_on_indoor_occupancy",
    trigger: "Entry door/motion arrival",
    guard: "Cancelled immediately when Living Office or Bedroom occupancy -> ON",
    action: "Holds Stairway active up to 5m for coat/shoe drop, then 0s clear",
  },
  {
    group: "Lighting & Presence",
    name: "Arrival Deterrence Lighting",
    entityId: "automation.away_arrival_deterrence_lighting",
    trigger: "Exterior door presence > 15s while Away & < 300 lx",
    guard: "away_mode == ON",
    action: "Stages Stairway 100% -> 5s -> Hallway Sconce 100%, holds 3m, then off",
  },
  {
    group: "Lighting & Presence",
    name: "Away Arm / Disarm",
    entityId: "automation.away_arm_on_departure",
    trigger: "U200 Keypad Lock (30s clear) OR Pixel 8a leaves SchuSecure Wi-Fi with U200 locked (3m clear)",
    guard: "Inside thumbturn locks on SchuSecure Wi-Fi never arm Away; disarms on U200 unlock or SchuSecure Wi-Fi return",
    action: "Toggles input_boolean.away_mode (and 5G/6G Flint 4 radio eco sync)",
  },
  {
    group: "Appliances & Safety",
    name: "Watch Charger Auto-Cutoff",
    entityId: "script.start_charge_cycle_from_button_data",
    trigger: "Start Watch Charge button (Home / Wind-down / Bedside)",
    guard: "Power drops <= charge_off_wattage (1.1 W) after peak",
    action: "Cuts bedroom smart plug power once Pixel Watch reaches full charge",
  },
  {
    group: "Appliances & Safety",
    name: "Refrigerator Excursion",
    entityId: "automation.refrigerator_temperature_out_of_range",
    trigger: "Fridge <= 1.0 C or >= 5.0 C for 30m",
    guard: "Debounced against door openings",
    action: "Flags Home card in amber/red + sends mobile alert",
  },
] as const;
// === END REQUIRED AGENT READING ===
