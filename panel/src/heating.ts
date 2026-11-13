/**
 * Heating efficiency maths for the Heating tab — pure functions, no Lit, no `hass`.
 *
 * The method is an *energy signature* (the PRISM approach): plot each day's whole-house
 * electricity against that day's heating degree days. A straight-line fit splits the day
 * into a fixed baseload (intercept: fridge, homelab, hot water standby) and a heating slope
 * (kWh per degree day). Two heating strategies are compared at the SAME weather by
 * evaluating each strategy's fit at one shared degree-day value; comparing raw daily
 * averages would mostly measure which week happened to be colder.
 *
 * Degree days are summed from hourly outdoor means (sum of max(0, base - T) / 24), not
 * from a daily mean, so a cold night and warm afternoon are not averaged into nothing.
 *
 * Inputs are Home Assistant long-term statistics at hourly period:
 *   * energy + cost are external statistics from the ESB Smart Meter integration
 *     (`change` per hour). ESB publishes a day or two late, so only days with a full
 *     set of hours are "complete".
 *   * temperatures and the strategy tag are entity statistics (`mean` per hour).
 */

export type Strategy = "always" | "offpeak" | "mixed" | "untagged";

export interface HourRow {
  /** Epoch ms of the hour start. */
  start: number;
  change?: number | null;
  mean?: number | null;
  min?: number | null;
}

export interface StatIds {
  kwhDay: string;
  kwhNight: string;
  kwhPeak: string;
  costDay: string;
  costNight: string;
  costPeak: string;
  outdoor: string;
  indoor: string;
  strategy: string;
}

export interface DayRow {
  /** YYYY-MM-DD in the house time zone. */
  day: string;
  kwh: number;
  kwhNight: number;
  /** Energy cost only (standing charge excluded — it is the same whatever you do). */
  cost: number;
  energyHours: number;
  outdoorMean: number | null;
  outdoorHours: number;
  hdd: number | null;
  indoorMean: number | null;
  indoorMin: number | null;
  /** Sum of (indoor - outdoor) / 24 — the temperature difference the house actually held. */
  deltaDays: number | null;
  strategyShare: number | null;
  strategy: Strategy;
  /** Full energy data and enough outdoor hours to trust the degree days. */
  complete: boolean;
}

export interface Fit {
  n: number;
  /** y at x = 0: baseload per day. */
  intercept: number;
  /** y per degree day. */
  slope: number;
  r2: number;
}

export interface GroupSummary {
  strategy: "always" | "offpeak";
  days: number;
  outdoorMean: number | null;
  hddMean: number | null;
  kwhPerDay: number | null;
  costPerDay: number | null;
  nightShare: number | null;
  indoorMean: number | null;
  indoorMin: number | null;
  kwhFit: Fit | null;
  costFit: Fit | null;
  /** kWh per degree day of temperature difference actually held (fabric + heat pump). */
  kwhPerDeltaDay: number | null;
}

/** Strategy share at or beyond these bounds tags the day; anything between is a switch-over day. */
const TAG_LOW = 0.2;
const TAG_HIGH = 0.8;
/** Minimum hours of outdoor data before a day's degree days are trusted. */
const MIN_OUTDOOR_HOURS = 20;
/** Fewer hours than this of ESB data means the day has not fully arrived yet (DST days have 23). */
const MIN_ENERGY_HOURS = 23;
/** A fit needs this many days and this much spread in degree days to mean anything. */
export const MIN_FIT_DAYS = 4;
export const MIN_FIT_SPREAD = 2;

const toMs = (start: number | string): number =>
  typeof start === "number" ? (start < 1e12 ? start * 1000 : start) : Date.parse(start);

export const normaliseRows = (rows: unknown): HourRow[] =>
  Array.isArray(rows)
    ? rows
        .map((r: any) => ({ start: toMs(r?.start), change: r?.change, mean: r?.mean, min: r?.min }))
        .filter((r) => Number.isFinite(r.start))
    : [];

export const dayKey = (ms: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(ms)
  );

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function buildDays(
  stats: Record<string, HourRow[]>,
  ids: StatIds,
  timeZone: string,
  baseTemp: number
): DayRow[] {
  interface Acc {
    kwh: number;
    kwhNight: number;
    cost: number;
    energyHours: Set<number>;
    outdoor: Map<number, number>;
    indoor: Map<number, number>;
    indoorMin: number | null;
    strategy: number[];
  }
  const days = new Map<string, Acc>();
  const acc = (ms: number): Acc => {
    const k = dayKey(ms, timeZone);
    let a = days.get(k);
    if (!a) {
      a = {
        kwh: 0,
        kwhNight: 0,
        cost: 0,
        energyHours: new Set(),
        outdoor: new Map(),
        indoor: new Map(),
        indoorMin: null,
        strategy: [],
      };
      days.set(k, a);
    }
    return a;
  };

  for (const id of [ids.kwhDay, ids.kwhNight, ids.kwhPeak]) {
    for (const r of stats[id] ?? []) {
      const c = num(r.change);
      if (c === null) continue;
      const a = acc(r.start);
      a.kwh += c;
      if (id === ids.kwhNight) a.kwhNight += c;
      a.energyHours.add(r.start);
    }
  }
  for (const id of [ids.costDay, ids.costNight, ids.costPeak]) {
    for (const r of stats[id] ?? []) {
      const c = num(r.change);
      if (c !== null) acc(r.start).cost += c;
    }
  }
  for (const r of stats[ids.outdoor] ?? []) {
    const m = num(r.mean);
    if (m !== null) acc(r.start).outdoor.set(r.start, m);
  }
  for (const r of stats[ids.indoor] ?? []) {
    const m = num(r.mean);
    if (m === null) continue;
    const a = acc(r.start);
    a.indoor.set(r.start, m);
    const lo = num(r.min) ?? m;
    a.indoorMin = a.indoorMin === null ? lo : Math.min(a.indoorMin, lo);
  }
  for (const r of stats[ids.strategy] ?? []) {
    const m = num(r.mean);
    if (m !== null) acc(r.start).strategy.push(m);
  }

  const out: DayRow[] = [];
  for (const [day, a] of [...days.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    const outdoorVals = [...a.outdoor.values()];
    const outdoorHours = outdoorVals.length;
    const outdoorMean = outdoorHours ? outdoorVals.reduce((s, v) => s + v, 0) / outdoorHours : null;
    // Scale to a full day so a day missing an hour or two is not under-counted.
    const hdd =
      outdoorHours >= MIN_OUTDOOR_HOURS
        ? (outdoorVals.reduce((s, t) => s + Math.max(0, baseTemp - t), 0) / outdoorHours)
        : null;

    const indoorVals = [...a.indoor.values()];
    const indoorMean = indoorVals.length ? indoorVals.reduce((s, v) => s + v, 0) / indoorVals.length : null;

    let deltaSum = 0;
    let deltaHours = 0;
    for (const [h, tout] of a.outdoor) {
      const tin = a.indoor.get(h);
      if (tin === undefined) continue;
      deltaSum += tin - tout;
      deltaHours += 1;
    }
    const deltaDays = deltaHours >= MIN_OUTDOOR_HOURS ? deltaSum / deltaHours : null;

    const strategyShare = a.strategy.length ? a.strategy.reduce((s, v) => s + v, 0) / a.strategy.length : null;
    const strategy: Strategy =
      strategyShare === null
        ? "untagged"
        : strategyShare <= TAG_LOW
          ? "always"
          : strategyShare >= TAG_HIGH
            ? "offpeak"
            : "mixed";

    const energyHours = a.energyHours.size;
    out.push({
      day,
      kwh: a.kwh,
      kwhNight: a.kwhNight,
      cost: a.cost,
      energyHours,
      outdoorMean,
      outdoorHours,
      hdd,
      indoorMean,
      indoorMin: a.indoorMin,
      deltaDays,
      strategyShare,
      strategy,
      complete: energyHours >= MIN_ENERGY_HOURS && hdd !== null,
    });
  }
  return out;
}

/** Ordinary least squares y = a + b x. Null when the data cannot support a slope. */
export function fitLine(points: Array<[number, number]>): Fit | null {
  const n = points.length;
  if (n < MIN_FIT_DAYS) return null;
  const xs = points.map((p) => p[0]);
  if (Math.max(...xs) - Math.min(...xs) < MIN_FIT_SPREAD) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { n, intercept, slope, r2 };
}

const mean = (vals: Array<number | null>): number | null => {
  const v = vals.filter((x): x is number => x !== null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};

export function summarise(days: DayRow[], strategy: "always" | "offpeak"): GroupSummary {
  const rows = days.filter((d) => d.complete && d.strategy === strategy);
  const kwh = rows.reduce((s, d) => s + d.kwh, 0);
  const night = rows.reduce((s, d) => s + d.kwhNight, 0);
  const deltaRows = rows.filter((d) => d.deltaDays !== null && d.deltaDays > 0);
  const deltaSum = deltaRows.reduce((s, d) => s + (d.deltaDays as number), 0);
  return {
    strategy,
    days: rows.length,
    outdoorMean: mean(rows.map((d) => d.outdoorMean)),
    hddMean: mean(rows.map((d) => d.hdd)),
    kwhPerDay: rows.length ? kwh / rows.length : null,
    costPerDay: rows.length ? rows.reduce((s, d) => s + d.cost, 0) / rows.length : null,
    nightShare: kwh > 0 ? night / kwh : null,
    indoorMean: mean(rows.map((d) => d.indoorMean)),
    indoorMin: rows.reduce<number | null>(
      (lo, d) => (d.indoorMin === null ? lo : lo === null ? d.indoorMin : Math.min(lo, d.indoorMin)),
      null
    ),
    kwhFit: fitLine(rows.map((d) => [d.hdd as number, d.kwh])),
    costFit: fitLine(rows.map((d) => [d.hdd as number, d.cost])),
    kwhPerDeltaDay: deltaSum > 0 ? deltaRows.reduce((s, d) => s + d.kwh, 0) / deltaSum : null,
  };
}

export const predict = (fit: Fit | null, x: number): number | null =>
  fit ? fit.intercept + fit.slope * x : null;
