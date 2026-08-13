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
  gate_open: boolean;
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
  clock_hour: number;
  dusk_hour: number;
  sunrise_hour: number | null;
  sunset_hour: number | null;
  elevation: number | null;
  kelvin: number;
  asleep: boolean;
  night_active: boolean;
  latitude: number;
  longitude: number;
  time_zone: string;
  year: number;
  day_of_year: number;
  updated_at: string | null;
  interval_s: number | null;
  healthy: boolean;
}

export interface Snapshot {
  entry_id: string;
  house: Record<string, number>;
  ramp: RampPoint[];
  house_schema: Schema[];
  room_schema: Schema[];
  links: Record<string, string | null>;
  world: World;
  rooms: RoomRow[];
}

/** The subset of `hass` a panel actually needs. */
export interface Hass {
  connection: {
    subscribeMessage<T>(cb: (msg: T) => void, sub: object): Promise<() => void>;
    sendMessagePromise<T>(msg: object): Promise<T>;
  };
  themes?: { darkMode?: boolean };
  language?: string;
}

export const subscribe = (hass: Hass, cb: (snap: Snapshot) => void) =>
  hass.connection.subscribeMessage<Snapshot>(cb, { type: "solace/subscribe" });

export const setHouse = (hass: Hass, values: Record<string, number>) =>
  hass.connection.sendMessagePromise({ type: "solace/set_house", values });

export const setRamp = (hass: Hass, ramp: RampPoint[]) =>
  hass.connection.sendMessagePromise({ type: "solace/set_ramp", ramp });

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
