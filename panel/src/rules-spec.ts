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
  group: "Front Door & U200 Lock" | "Lighting & Presence" | "Appliances & Safety" | "Reminders & Alerts";
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
  "sunny_override_release_pct",
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
  "transition_mode_s",
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
  "wake_house_wide",
  "winddown_house_wide",
  "winddown_leave_grace_minutes",
  "work_mode_debounce_minutes",
  "work_mode_glass_level",
  "work_mode_kelvin",
  "work_mode_bias_stops",
  "work_mode_app_close_delay_minutes",
  "gaming_mode_desk_level",
  "gaming_mode_backlight_level",
  "gaming_mode_corner_level",
  "gaming_mode_glass_level",
  "gaming_mode_kelvin",
  "gaming_mode_bias_stops",
  "gaming_mode_debounce_minutes",
  "movie_mode_desk_level",
  "movie_mode_backlight_level",
  "movie_mode_corner_level",
  "movie_mode_glass_level",
  "movie_mode_kelvin",
  "movie_mode_bias_stops",
  "movie_mode_debounce_minutes",
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
  "manual_follow_occupancy",
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
    formula: "lvl < round(cutoff * (1 - demand)) -> 0 (+12 hyst)",
    summary: "Applies Priority Ladder, continuous daylight cutoff (scales from 0 when dark/demand=1.0 up to max(min_cutoff, clamp_min) in full sun with bounded +12 Schmitt hysteresis, completely independent of input_boolean.ambient_gate; L3 acts as the floor when Ambient is manually ON), L3 ambience when gate is open, and room occupied_min/max.",
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
    outputRule: "Solace stops automatic writes and holds slider brightness; when manual_follow_occupancy is checked, holds selected manual_level while occupied and turns off (0) on clear/asleep/away.",
    releaseRule: "Click 'Resume now' or manual_hold_minutes timer expires.",
  },
  {
    rank: 3,
    mode: "Special Modes: Movie > Gaming > Work (Bedroom Office)",
    trigger: "input_boolean.movie_mode / gaming_mode / work_mode == ON (one at a time; switching one on switches the others off). Work is toggled manually (UI or Desk Styrbar up-tap); Gaming auto-ON with Steam/CrossOver; Movie auto-ON with the Jellyfin app unless Work Mode is active.",
    outputRule: "Per-mode profile on the 5 office lights: each light is a fixed level (Work default = D65 calibration: desk 86 / right desk 78 corner-compensated / counter 135 / wardrobe 105 / glass 0 @ 6500K) or -1 = follow Solace demand with the mode's bias stops (Movie default: desk 0, rest follow at -2 stops). Kelvin 0 = follow house colour curve.",
    releaseRule: "Profile holds while Bedroom occupied + per-mode debounce. Pauses while Mac displays asleep (binary_sensor.mac_displays_asleep), resumes on wake. Debounce skipped when Bedroom empty and another room occupied (unless Living Guest Mode ON). Sleep/Night/morning release auto-clears all three.",
  },
  {
    rank: 4,
    mode: "Virtual Sunrise (house-wide)",
    trigger: "Within sunrise_fade_minutes of the earliest wake time (phone alarm, Solace wake time, input_datetime.solace_wake_time). Timeline is anchored once started.",
    outputRule: "wake_house_wide ON: every OCCUPIED room follows the Sunrise Spline up to min(curve, L1); empty rooms 0; Bedroom keeps the dawn unless you are seen in another room (still-sleeper safety); Stairway never below night floor (L1s). Sleep toggled OFF by you mid-fade = wake boost to normal L1. Sleep toggled back ON mid-fade = fade carries on and Solace stops auto-clearing sleep until the fade ends. Casts Wake-Up Music at 100%. wake_house_wide OFF = legacy bedroom-only.",
    releaseRule: "Anchor timeline completes (+15 min hold at top while asleep); survives mid-fade alarm dismissal and toilet trips.",
  },
  {
    rank: 5,
    mode: "Asleep / Guest Sleep",
    trigger: "Phone DND = priority_only OR Pixel Watch = bedtime OR input_boolean.solace_sleep == ON",
    outputRule: "Rooms with night_off (Bedroom, and Living Room when Guest Mode ON) force 0; house latches Night Mode.",
    releaseRule: "Outdoor lux >= night_release_lux after morning_release_hour, or upcoming alarm lead-in.",
  },
  {
    rank: 6,
    mode: "Virtual Sunset (house-wide)",
    trigger: "Clock >= bedtime_dwell_hour + Bedroom occupied >= sunset_dwell_minutes (session starts at that moment; no clock times on the master curve)",
    outputRule: "winddown_house_wide ON: Bedroom AND every other occupied room (except Stairway, which keeps its safety curve) fade down the Sunset Spline and hold at the Aqara floor (3 lvl) until Sleep; suppresses house ambience once bedroom < kitchen L3. OFF = legacy bedroom-only.",
    releaseRule: "Bedroom empty > winddown_leave_grace_minutes (default 5) resets the session; Sleep Mode ends it and turns bedroom OFF (0).",
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
    rule: "When raw outdoor lux >= sunny_override_lux (live: 4,500 lx), forces 0% cloud blend (100% Clear Sun curve) across all rooms even if hourly met.no forecast lags. Hysteresis: once on, holds until lux drops sunny_override_release_pct (default 15%) below the threshold, so passing clouds cannot flap rooms off/on.",
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
    rule: "Drops computed L1/L2 demand below effective_cutoff = round(max(min_cutoff, clamp_min) * (1 - demand)) straight to 0 (with bounded +12 Schmitt hysteresis when re-igniting from off or L3). Automatically 0 when dark (demand == 1.0) and scales to full ceiling in bright daylight.",
    exemptions: "Completely independent of input_boolean.ambient_gate (which strictly toggles L3 ambient lights on/off; if L3 is ON when daytime L1 is cut off, occupied rooms rest at L3). Exempt in Stairway, Night Mode, Bedtime Dwell, Sunrise, and Sunset.",
  },
  {
    name: "Per-Light Cut & Max",
    scope: "Per-Light",
    key: "clamp_min / clamp_max",
    rule: "clamp_min sets a per-fixture daylight cutoff ceiling (scaled by (1 - demand) outside Stairway); clamp_max is an unconditional hard ceiling across all automatic modes.",
    exemptions: "clamp_min scales to 0 in full darkness (demand == 1.0) and is exempt in Ambience (L3), Night Mode (L1s), Sunrise, and Sunset.",
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
        detail: "No post-clear hold in Solace (sensor timeouts are set in Zigbee2MQTT). Exterior/entry arrival or U200 unlock fires a 5-min stairway timer that cancels 1 min after indoor occupancy triggers while entry is clear.",
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
    room: "Living Room",
    subtitle: "Open-plan living & guest room",
    rules: [
      {
        label: "Guest Mode",
        detail: "input_boolean.living_guest_mode treats room as a bedroom overnight (suppresses motion turn-on while asleep).",
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
    trigger: "Entry door/motion arrival or U200 lock unlock",
    guard: "Cancels 1m after indoor occupancy (Living / Kitchen / Bedroom) turns ON while Entry is clear",
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
    action: "Cuts bedroom smart plug power and calls script.send_home_reminder if Reminder Charge Done is ON",
  },
  {
    group: "Appliances & Safety",
    name: "Refrigerator Excursion",
    entityId: "automation.refrigerator_temperature_out_of_range",
    trigger: "Fridge <= 1.0 C or >= 5.0 C for 30m",
    guard: "Debounced against door openings",
    action: "Flags Home card in amber/red + sends mobile alert",
  },
  {
    group: "Appliances & Safety",
    name: "Electric Blanket Auto-Heat",
    entityId: "automation.electric_blanket_auto_heat_in_cold_window",
    trigger: "Window start, 19:00:05 peak end, bedroom < threshold for 3m, arrive home, or Auto enabled",
    guard: "Auto ON, Away OFF, time inside window, bedroom < threshold, Peak Guard (>=17.5 C bypass during 17:00-19:00), and awake when Sleep Auto-Off ON",
    action: "Turns on switch.electric_blanket",
  },
  {
    group: "Appliances & Safety",
    name: "Electric Blanket Auto-Off",
    entityId: "automation.electric_blanket_auto_off_away_window_end",
    trigger: "Away Mode ON, Sleep Mode ON for 25m, or window end",
    guard: "Blanket ON (Sleep trigger requires Sleep Auto-Off ON; window end requires Auto ON)",
    action: "Turns off switch.electric_blanket",
  },
  {
    group: "Reminders & Alerts",
    name: "Central Reminder Dispatcher",
    entityId: "script.send_home_reminder",
    trigger: "Called by reminder automations or Main -> Reminders Test button",
    guard: "input_boolean.reminders_master == ON (voice gated by voice_reminders ON, Away OFF, Sleep OFF, Phone DND OFF)",
    action: "Pushes to Pixel 8a + Pixel Watch 2 and optionally plays Maya /api/say soundbank or Cast audio clip",
  },
  {
    group: "Reminders & Alerts",
    name: "AM / PM Meds Reminders",
    entityId: "automation.reminder_take_meds_daily_snooze",
    trigger: "Kitchen/Living occupancy >= input_number.meds_kitchen_dwell (default 5m) after reminder_meds_time (08:00), 04:00 reset, or AM/PM Taken / Snooze 30m actions",
    guard: "Morning fires after earliest time before 16:30 when reminder_meds ON & meds_taken_today OFF (30m cooldown); Evening snooze uses reminder_evening_meds & evening_meds_taken_today",
    action: "Dispatches Morning/Evening Meds notifications with Taken / Snooze 30m buttons via script.send_home_reminder",
  },
  {
    group: "Reminders & Alerts",
    name: "Hot Water 60 C Sanitizer Alert",
    entityId: "automation.reminder_hot_water_extra_hot_60degc_sanitizer_cycle",
    trigger: "HP discharge probe > 52 C for 10m, wake-up (solace_sleep off), 08:00 fallback, Got it action, or 18h expiry",
    guard: "Latches hot_water_extra_hot_active ON overnight if asleep so warning delivers on wake-up / 08:00 when reminder_hot_water ON",
    action: "Sends extra-hot tap water warning via script.send_home_reminder and clears on acknowledgment",
  },
  {
    group: "Reminders & Alerts",
    name: "Electricity Tariff Window Alerts",
    entityId: "automation.reminder_electricity_tariff_windows_peak_day_night",
    trigger: "16:45 (15m pre-Peak + Evening Meds), 07:45 (15m pre-Day), or 23:00 (Night start)",
    guard: "Tariff alerts require Away OFF & matching toggle; at 16:45 combines Peak + Evening Meds when both due, or sends Evening Meds standalone to phone/watch even if away",
    action: "Sends SST tariff / combined Evening Meds reminder via script.send_home_reminder",
  },
  {
    group: "Reminders & Alerts",
    name: "Stale Sensor & Low Battery Watchdog",
    entityId: "automation.watchdog_stale_sensors_low_battery",
    trigger: "10:00 / 20:00 freshness sweep or any temperature/lock/remote/UPS battery < 20%",
    guard: "input_boolean.reminder_sensor_health == ON; freshness ignores OK / unavailable",
    action: "Reports probes silent >12h (sensor.stale_temperature_sensors) or low battery % via script.send_home_reminder",
  },
] as const;
// === END REQUIRED AGENT READING ===
