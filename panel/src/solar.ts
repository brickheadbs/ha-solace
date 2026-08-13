/**
 * Solar geometry — **charts only**.
 *
 * The engine never uses any of this: it reads `sun.sun` for civil dusk and the clock
 * for everything else. This exists so the "when lighting starts, across the year" chart
 * can answer a question `sun.sun` cannot — *what will happen in March* — and that is
 * inherently an estimate.
 *
 * ⚠️ Latitude is a parameter, never a constant. The prototype hardcoded 45.5°N; this
 * house is at 54.05°N, where the winter sun caps at 12.5° elevation and the onset curve
 * has a completely different shape. It comes from `hass.config.latitude` via the
 * snapshot.
 */

const RAD = Math.PI / 180;

/** Clear-sky illuminance against solar elevation. Civil dusk (−6°) ≈ 11 lx. */
const LUX_TABLE: ReadonlyArray<readonly [number, number]> = [
  [75, 110000],
  [60, 90000],
  [45, 65000],
  [30, 40000],
  [20, 22000],
  [12, 11000],
  [8, 6000],
  [5, 3200],
  [2, 1200],
  [0, 420],
  [-2, 130],
  [-4, 42],
  [-6, 11],
  [-9, 1.6],
  [-12, 0.35],
  [-18, 0.002],
];

export const declination = (doy: number): number =>
  23.44 * RAD * Math.sin((2 * Math.PI * (284 + doy)) / 365);

export const elevationAt = (doy: number, hour: number, lat: number): number => {
  const d = declination(doy);
  const phi = lat * RAD;
  const ha = (hour - 12) * 15 * RAD;
  return (
    Math.asin(
      Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(ha)
    ) / RAD
  );
};

/**
 * The clock hour on the *evening* side at which the sun passes `elev`.
 * null when it never does — at 54°N that is a real case in midsummer for civil dusk.
 */
export const eveningCrossing = (
  doy: number,
  elev: number,
  lat: number
): number | null => {
  const d = declination(doy);
  const phi = lat * RAD;
  const c =
    (Math.sin(elev * RAD) - Math.sin(phi) * Math.sin(d)) /
    (Math.cos(phi) * Math.cos(d));
  if (c >= 1 || c <= -1) return null;
  return 12 + (Math.acos(c) / RAD) / 15;
};

/** Invert the table: what elevation does this illuminance correspond to? */
export const elevationForLux = (value: number): number => {
  const L = Math.max(0.002, Math.min(110000, value));
  for (let i = 0; i < LUX_TABLE.length - 1; i++) {
    const [ea, la] = LUX_TABLE[i];
    const [eb, lb] = LUX_TABLE[i + 1];
    if (L <= la && L >= lb) {
      // Interpolate in log-lux — the eye and the table are both logarithmic, and a
      // linear interpolation across a 110000:0.002 range is meaningless.
      const t = (Math.log(L) - Math.log(lb)) / (Math.log(la) - Math.log(lb));
      return eb + t * (ea - eb);
    }
  }
  return L > LUX_TABLE[0][1] ? LUX_TABLE[0][0] : LUX_TABLE[LUX_TABLE.length - 1][0];
};

/**
 * Equation of time, in minutes — the gap between clock noon and the sun's actual noon.
 * Swings roughly ±15 minutes over the year.
 */
const equationOfTime = (doy: number): number => {
  const b = (2 * Math.PI * (doy - 81)) / 364;
  return 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
};

/** A zone's UTC offset in hours on a given instant — DST included, from the browser's
 * own IANA database rather than a guess. */
const offsetHours = (utcMs: number, timeZone: string): number => {
  try {
    // ⚠️ Fall back to the browser's zone, never to UTC. An older backend that does not
    // send `time_zone` would otherwise shift the whole chart by the UTC offset — a
    // silent one-hour error that looks entirely plausible, because every curve moves
    // together and only a comparison against the real sunset gives it away.
    if (!timeZone) timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour") % 24,
      get("minute"),
      get("second")
    );
    return (asUtc - utcMs) / 3_600_000;
  } catch {
    return 0;
  }
};

export interface Place {
  lat: number;
  lon: number;
  timeZone: string;
  year: number;
}

/**
 * The **local clock** time at which the sun crosses `elev` on the evening side.
 *
 * ⚠️ `eveningCrossing` returns *solar* time. Handing that straight to the chart was a
 * real bug: at this longitude, in this timezone, in August, it read nearly two hours
 * early and put "lighting starts" before sunset — which is impossible and would have
 * been believed, because the curve shape looked entirely plausible.
 */
export const eveningClockTime = (
  doy: number,
  elev: number,
  place: Place
): number | null => {
  const hourAngle = eveningCrossing(doy, elev, place.lat);
  if (hourAngle === null) return null;
  // Solar noon in UTC: 12:00 shifted by the longitude and the equation of time.
  const solarNoonUtc = 12 - place.lon / 15 - equationOfTime(doy) / 60;
  const utcHour = solarNoonUtc + (hourAngle - 12);
  const dayMs = Date.UTC(place.year, 0, 1) + (doy - 1) * 86_400_000;
  const utcMs = dayMs + utcHour * 3_600_000;
  return (utcHour + offsetHours(utcMs, place.timeZone) + 24) % 24;
};

/** The evening clock time at which outdoor lux falls to `value`. */
export const eveningTimeForLux = (
  doy: number,
  value: number,
  place: Place
): number | null => eveningClockTime(doy, elevationForLux(value), place);
