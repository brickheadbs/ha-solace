/**
 * The panel's half of the WebSocket contract in `websocket_api.py`.
 *
 * One subscription pushes a whole snapshot on every coordinator tick, and every write
 * is a typed command. Nothing is read from entity states: the engine already computed
 * every consequence, and re-deriving them here would be a second implementation of the
 * maths that could disagree with the one driving the bulbs.
 */

export interface Schema {
  key: string;
  name: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit: string | null;
  icon: string | null;
}

export interface RampPoint {
  hour: number;
  stops: number;
}

export interface ZoneRow {
  zone_id: string;
  name: string;
  lights: string[];
  presence: string[];
  bias_stops: number;
  diminish_pct: number;
  /** null when the zone has no presence sensor of its own. */
  clear: boolean | null;
}

export interface LightRow {
  entity_id: string;
  name: string;
  /** null = not assigned to any zone; it takes the area's own zone bias. */
  zone_id: string | null;
  available: boolean;
  group_size: number;
  family: string;
  bias_stops: number;
  /** null = unset. 0 and 254 are legitimate *set* values, so this cannot be a number. */
  clamp_min: number | null;
  clamp_max: number | null;
  min_kelvin: number;
  max_kelvin: number;
  kelvin: number;
  kelvin_clamped: boolean;
  level: number | null;
  stops: number | null;
  trace: Record<string, unknown>;
  current_level: number;
  is_on: boolean;
}

export interface RoomRow {
  subentry_id: string;
  name: string;
  settings: Record<string, number | boolean>;
  presence: string[];
  near_presence: string[];
  occupied: boolean;
  near_clear: boolean;
  has_near: boolean;
  ambience_open: boolean;
  demand: number | null;
  stops: number | null;
  mode: string | null;
  level: number | null;
  manual: {
    active: boolean;
    switch: boolean;
    touched: boolean;
    remaining_s: number | null;
    hold_minutes: number;
  };
  lights: LightRow[];
  zones: ZoneRow[];
}

export interface World {
  lux: number;
  cloud_coverage?: number | null;
  demand?: number | null;
  clock_hour: number;
  dusk_hour: number;
  sunrise_hour: number | null;
  sunset_hour: number | null;
  elevation: number | null;
  kelvin: number;
  asleep: boolean;
  phone_dnd?: boolean;
  watch_bedtime?: boolean;
  manual_sleep?: boolean;
  night_active: boolean;
  away: boolean;
  sunrise_progress: number | null;
  sunset_progress?: number | null;
  bedtime_dwell_active: boolean;
  latitude: number;
  longitude: number;
  time_zone: string;
  year: number;
  day_of_year: number;
  updated_at: string | null;
  interval_s: number | null;
  healthy: boolean;
}

export interface RemoteRow {
  remote_id: string;
  name: string;
  room_id?: string;
  room_name?: string;
  action_entity?: string;
  button_on?: string;
  button_off?: string;
  button_up?: string;
  button_down?: string;
  button_left?: string;
  button_right?: string;
  hold_up?: string;
  hold_down?: string;
  hold_left?: string;
  hold_right?: string;
}

/** How one bulb family walks the colour curve. See `fade.py::fade_profile`. */
export interface FamilyFade {
  family: string;
  count: number;
  step_mired: number;
  max_step_mired: number;
  step_transition_s: number;
  concurrent: boolean;
  reason: string;
}

export interface LuxPoint {
  lux: number;
  demand_pct: number;
}

export interface BrightnessPoint {
  hour: number;
  level: number;
}

export interface ColourPoint {
  hour: number;
  kelvin: number;
}

export interface ProgressPoint {
  progress: number;
  level: number;
}

export interface Snapshot {
  entry_id: string;
  house: Record<string, number>;
  ramp: RampPoint[];
  lux_curve?: LuxPoint[];
  lux_cloudy_curve?: LuxPoint[];
  brightness_timeline?: BrightnessPoint[];
  colour_timeline?: ColourPoint[];
  sunrise_curve?: ProgressPoint[];
  sunset_curve?: ProgressPoint[];
  house_schema: Schema[];
  room_schema: Schema[];
  links: Record<string, string | null>;
  remotes?: RemoteRow[];
  world: World;
  /** Present only when at least one light is configured. */
  fade?: { interval_s: number; families: FamilyFade[] };
  rooms: RoomRow[];
}

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_changed: string;
  last_updated: string;
}

/** The subset of `hass` a panel needs. */
export interface Hass {
  connection: {
    subscribeMessage<T>(cb: (msg: T) => void, sub: object): Promise<() => void>;
    sendMessagePromise<T>(msg: object): Promise<T>;
  };
  states: Record<string, HassEntity | undefined>;
  callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: Record<string, unknown>
  ): Promise<unknown>;
  callWS?<T>(msg: object): Promise<T>;
  callApi?<T>(method: string, path: string, parameters?: object): Promise<T>;
  themes?: { darkMode?: boolean };
  language?: string;
}

export const subscribe = (hass: Hass, cb: (snap: Snapshot) => void) =>
  hass.connection.subscribeMessage<Snapshot>(cb, { type: "solace/subscribe" });

export const setHouse = (hass: Hass, values: Record<string, number>) =>
  hass.connection.sendMessagePromise({ type: "solace/set_house", values });

export const setRamp = (hass: Hass, ramp: RampPoint[]) =>
  hass.connection.sendMessagePromise({ type: "solace/set_ramp", ramp });

export const setLuxCurve = (hass: Hass, lux_curve: LuxPoint[]) =>
  hass.connection.sendMessagePromise({ type: "solace/set_lux_curve", lux_curve });

export const setLuxCloudyCurve = (hass: Hass, lux_cloudy_curve: LuxPoint[]) =>
  hass.connection.sendMessagePromise({ type: "solace/set_lux_cloudy_curve", lux_cloudy_curve });

export const setBrightnessTimeline = (
  hass: Hass,
  brightness_timeline: BrightnessPoint[]
) =>
  hass.connection.sendMessagePromise({
    type: "solace/set_brightness_timeline",
    brightness_timeline,
  });

export const setColourTimeline = (
  hass: Hass,
  colour_timeline: ColourPoint[]
) =>
  hass.connection.sendMessagePromise({
    type: "solace/set_colour_timeline",
    colour_timeline,
  });

export const setRoom = (
  hass: Hass,
  subentry_id: string,
  values: Record<string, number | boolean>
) => hass.connection.sendMessagePromise({ type: "solace/set_room", subentry_id, values });

export const setLight = (
  hass: Hass,
  subentry_id: string,
  entity_id: string,
  values: Record<string, number | null>
) =>
  hass.connection.sendMessagePromise({
    type: "solace/set_light",
    subentry_id,
    entity_id,
    values,
  });

export const setZones = (hass: Hass, subentry_id: string, zones: ZoneRow[]) =>
  hass.connection.sendMessagePromise({
    type: "solace/set_zones",
    subentry_id,
    zones: zones.map(({ clear: _clear, ...z }) => z),
  });

export const mergeAreas = (
  hass: Hass,
  into: string,
  subentry_ids: string[],
  title?: string
) =>
  hass.connection.sendMessagePromise({
    type: "solace/merge_areas",
    into,
    subentry_ids,
    ...(title ? { title } : {}),
  });

export const roomAction = (
  hass: Hass,
  subentry_id: string,
  action: "manual" | "auto" | "level",
  level?: number
) =>
  hass.connection.sendMessagePromise({
    type: "solace/room_action",
    subentry_id,
    action,
    ...(level === undefined ? {} : { level }),
  });

export const setRemotes = (hass: Hass, remotes: RemoteRow[]) =>
  hass.connection.sendMessagePromise({ type: "solace/set_remotes", remotes });

export const toggleSleep = (hass: Hass) =>
  hass.connection.sendMessagePromise({ type: "solace/toggle_sleep" });

export const setSunriseCurve = (hass: Hass, sunrise_curve: ProgressPoint[]) =>
  hass.connection.sendMessagePromise({
    type: "solace/set_sunrise_curve",
    sunrise_curve,
  });

export const setSunsetCurve = (hass: Hass, sunset_curve: ProgressPoint[]) =>
  hass.connection.sendMessagePromise({
    type: "solace/set_sunset_curve",
    sunset_curve,
  });


