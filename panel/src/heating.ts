/**
 * Heating & Energy efficiency maths for the Solace Heating tab — pure functions, no Lit, no `hass`.
 *
 * Combines Home Assistant hourly long-term statistics from:
 *   - ESB Smart Meter external statistics (Day / Night / Peak kWh & €, Standing Charge €)
 *   - Outdoor temperature (`sensor.entry_exterior_temperature`) for hourly Heating Degree Days (base 15.5 °C)
 *   - Heat pump refrigerant line probes (High Pressure discharge & Low Pressure return) for:
 *       1. Self-calibrated hourly kWh estimation during ESB's ~40h publication lag
 *       2. Estimated thermodynamic COP from outdoor temp, condensing proxy & defrost detection
 *       3. Separation of Hot Water (2 kW booster / nightly DHW bursts) vs. Space Heating
 *   - Direct device metering: Desk outlet (with Eaton UPS fallback pre-plug), Electric Blanket,
 *     All Lighting (18 Aqara T2 bulbs via built-in Integral helper), and Watch Charger.
 */

export interface HourRow {
  /** Epoch ms of the hour start. */
  start: number;
  change?: number | null;
  mean?: number | null;
  min?: number | null;
  max?: number | null;
}

export interface StatIds {
  kwhDay: string;
  kwhNight: string;
  kwhPeak: string;
  costDay: string;
  costNight: string;
  costPeak: string;
  standing: string;
  outdoor: string;
  indoor: string;
  living: string;
  bedroom: string;
  bathroom: string;
  storage: string;
  hpHigh: string;
  hpLow: string;
  deskEnergy: string;
  upsPower: string;
  blanketEnergy: string;
  lightingEnergy: string;
  chargerEnergy: string;
}

export interface TariffConfig {
  nightRate: number;
  dayRate: number;
  peakRate: number;
  standingPerDay: number;
  nightStart: number;
  nightEnd: number;
  peakStart: number;
  peakEnd: number;
}

export const DEFAULT_TARIFF: TariffConfig = {
  nightRate: 0.1789,
  dayRate: 0.3405,
  peakRate: 0.3633,
  standingPerDay: 0.7055,
  nightStart: 23,
  nightEnd: 8,
  peakStart: 17,
  peakEnd: 19,
};

/** Date Brandon moved the Mac Studio / UPS to 20 Fulacht Fia (UPS fallback only valid on/after this day). */
const UPS_VALID_FROM = "2026-11-12";
/** Date Brandon switched from 15h Night Hold to the 4-period SST schedule (~21:15). */
export const FOUR_PERIOD_SWITCH_DAY = "2026-11-14";

export interface CostBreakdown {
  total: number;
  energy: number;
  standing: number;
  spaceHeat: number;
  hotWater: number;
  desk: number;
  blanket: number;
  lighting: number;
  other: number;
}

export interface DaySummary {
  /** YYYY-MM-DD in the house time zone. */
  day: string;
  /** True when ESB meter data is not fully in yet and figures come from the probe + weather model. */
  estimated: boolean;
  /** True when the day has enough outdoor + energy/probe hours to plot as a full day. */
  complete: boolean;
  energyHours: number;
  probeHours: number;
  outdoorHours: number;

  /** Weather & comfort */
  outdoorMean: number | null;
  hdd: number | null;
  indoorMean: number | null;
  livingMean: number | null;
  bedroomMean: number | null;
  bathroomMean: number | null;
  storageMean: number | null;

  /** Heat pump telemetry */
  hpActiveHours: number;
  hpHighActiveMean: number | null;
  hpLowActiveMean: number | null;
  defrostHours: number;
  boosterDetected: boolean;
  estCop: number | null;

  /** Energy (kWh) */
  totalKwh: number;
  nightShare: number | null;
  spaceHeatKwh: number;
  hotWaterKwh: number;
  deskKwh: number;
  deskFromUpsFallback: boolean;
  blanketKwh: number;
  lightingKwh: number;
  otherKwh: number;

  /** Costs (€) — components sum exactly to `costs.total`. */
  costs: CostBreakdown;

  /** Primary efficiency metrics per Heating Degree Day (Heat Pump Space + DHW). */
  hpCostPerHdd: number | null;
  hpKwhPerHdd: number | null;
  totalCostPerHdd: number | null;
  totalKwhPerHdd: number | null;
}

export interface ModelCalibration {
  interceptKwh: number;
  slopeKwhPerDeg: number;
  idleUnmeasuredKwh: number;
  sampleHours: number;
}

export interface SeriesPoint {
  ts: number;
  v: number;
}

const MIN_OUTDOOR_HOURS = 18;
const MIN_FULL_ESB_HOURS = 23;
const MIN_FULL_PROBE_HOURS = 20;

const toMs = (start: number | string): number =>
  typeof start === "number" ? (start < 1e12 ? start * 1000 : start) : Date.parse(start);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const normaliseRows = (rows: unknown): HourRow[] =>
  Array.isArray(rows)
    ? rows
        .map((r: any) => ({
          start: toMs(r?.start),
          change: num(r?.change),
          mean: num(r?.mean),
          min: num(r?.min),
          max: num(r?.max),
        }))
        .filter((r) => Number.isFinite(r.start))
    : [];

export const dayKey = (ms: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));

export const localHour = (ms: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  return Number.isFinite(h) ? h % 24 : 0;
};

export const rateForHour = (hour: number, tariff: TariffConfig = DEFAULT_TARIFF): number => {
  if (hour >= tariff.nightStart || hour < tariff.nightEnd) return tariff.nightRate;
  if (hour >= tariff.peakStart && hour < tariff.peakEnd) return tariff.peakRate;
  return tariff.dayRate;
};

interface HourSlot {
  start: number;
  day: string;
  hour: number;
  hasEsb: boolean;
  esbKwh: number;
  esbNightKwh: number;
  esbEnergyCost: number;
  esbStanding: number;
  outdoor: number | null;
  indoor: number | null;
  living: number | null;
  bedroom: number | null;
  bathroom: number | null;
  storage: number | null;
  hpHighMean: number | null;
  hpHighMax: number | null;
  hpLowMean: number | null;
  hpLowMin: number | null;
  deskMeteredKwh: number | null;
  upsWatts: number | null;
  blanketKwh: number | null;
  lightingKwh: number | null;
  chargerKwh: number | null;
}

const median = (vals: number[]): number | null => {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function buildHeatingDays(
  stats: Record<string, HourRow[]>,
  ids: StatIds,
  timeZone: string,
  baseTemp = 15.5,
  tariff: TariffConfig = DEFAULT_TARIFF
): { days: DaySummary[]; calibration: ModelCalibration } {
  const slots = new Map<number, HourSlot>();
  const slot = (start: number): HourSlot => {
    let s = slots.get(start);
    if (!s) {
      s = {
        start,
        day: dayKey(start, timeZone),
        hour: localHour(start, timeZone),
        hasEsb: false,
        esbKwh: 0,
        esbNightKwh: 0,
        esbEnergyCost: 0,
        esbStanding: 0,
        outdoor: null,
        indoor: null,
        living: null,
        bedroom: null,
        bathroom: null,
        storage: null,
        hpHighMean: null,
        hpHighMax: null,
        hpLowMean: null,
        hpLowMin: null,
        deskMeteredKwh: null,
        upsWatts: null,
        blanketKwh: null,
        lightingKwh: null,
        chargerKwh: null,
      };
      slots.set(start, s);
    }
    return s;
  };

  for (const id of [ids.kwhDay, ids.kwhNight, ids.kwhPeak]) {
    for (const r of stats[id] ?? []) {
      if (r.change === null || r.change === undefined) continue;
      const s = slot(r.start);
      s.hasEsb = true;
      s.esbKwh += Math.max(0, r.change);
      if (id === ids.kwhNight) s.esbNightKwh += Math.max(0, r.change);
    }
  }
  for (const id of [ids.costDay, ids.costNight, ids.costPeak]) {
    for (const r of stats[id] ?? []) {
      if (r.change === null || r.change === undefined) continue;
      slot(r.start).esbEnergyCost += Math.max(0, r.change);
    }
  }
  for (const r of stats[ids.standing] ?? []) {
    if (r.change !== null && r.change !== undefined) slot(r.start).esbStanding += Math.max(0, r.change);
  }

  const setMean = (id: string, fn: (s: HourSlot, r: HourRow) => void) => {
    for (const r of stats[id] ?? []) {
      if (r.mean === null || r.mean === undefined) continue;
      fn(slot(r.start), r);
    }
  };
  setMean(ids.outdoor, (s, r) => (s.outdoor = r.mean!));
  setMean(ids.indoor, (s, r) => (s.indoor = r.mean!));
  setMean(ids.living, (s, r) => (s.living = r.mean!));
  setMean(ids.bedroom, (s, r) => (s.bedroom = r.mean!));
  setMean(ids.bathroom, (s, r) => (s.bathroom = r.mean!));
  setMean(ids.storage, (s, r) => (s.storage = r.mean!));
  setMean(ids.upsPower, (s, r) => (s.upsWatts = Math.max(0, r.mean!)));
  for (const r of stats[ids.hpHigh] ?? []) {
    if (r.mean === null || r.mean === undefined) continue;
    const s = slot(r.start);
    s.hpHighMean = r.mean;
    s.hpHighMax = r.max ?? r.mean;
  }
  for (const r of stats[ids.hpLow] ?? []) {
    if (r.mean === null || r.mean === undefined) continue;
    const s = slot(r.start);
    s.hpLowMean = r.mean;
    s.hpLowMin = r.min ?? r.mean;
  }

  const setEnergyChange = (id: string, field: "deskMeteredKwh" | "blanketKwh" | "lightingKwh" | "chargerKwh") => {
    for (const r of stats[id] ?? []) {
      if (r.change === null || r.change === undefined) continue;
      const val = Math.max(0, r.change);
      // Guard against occasional total_increasing counter reset glitches (>10 kWh in 1h on a plug/bulb)
      if (val <= 10) slot(r.start)[field] = val;
    }
  };
  setEnergyChange(ids.deskEnergy, "deskMeteredKwh");
  setEnergyChange(ids.blanketEnergy, "blanketKwh");
  setEnergyChange(ids.lightingEnergy, "lightingKwh");
  setEnergyChange(ids.chargerEnergy, "chargerKwh");

  // Group hourly slots by local day
  const byDay = new Map<string, HourSlot[]>();
  for (const s of [...slots.values()].sort((a, b) => a.start - b.start)) {
    const arr = byDay.get(s.day) ?? [];
    arr.push(s);
    byDay.set(s.day, arr);
  }

  // Track which days have active desk plug metering (avoid mixing partial-hour zero with UPS)
  const dayHasDeskMeter = new Set<string>();
  for (const [d, hrs] of byDay) {
    const sum = hrs.reduce((acc, s) => acc + (s.deskMeteredKwh ?? 0), 0);
    if (sum >= 0.05) dayHasDeskMeter.add(d);
  }

  // Self-calibrate probe-to-kWh slope + idle unmeasured floor on occupied days (>= 5 kWh & outdoor sensor)
  const regPairs: Array<[number, number]> = [];
  const idleResidualMetered: number[] = [];
  const idleResidualLegacy: number[] = [];

  for (const [d, hrs] of byDay) {
    const esbSum = hrs.reduce((acc, s) => acc + (s.hasEsb ? s.esbKwh : 0), 0);
    if (esbSum < 5.0) continue;
    const hasDesk = dayHasDeskMeter.has(d);
    for (const s of hrs) {
      if (!s.hasEsb || s.outdoor === null || s.hpHighMean === null || s.hpLowMean === null) continue;
      const hpDt = Math.max(0, s.hpHighMean - s.hpLowMean);
      const deskK = hasDesk
        ? (s.deskMeteredKwh ?? 0)
        : d >= UPS_VALID_FROM && s.upsWatts !== null
          ? s.upsWatts / 1000
          : 0;
      const meteredNonHp = deskK + (s.blanketKwh ?? 0) + (s.lightingKwh ?? 0) + (s.chargerKwh ?? 0);
      if (hpDt < 2.0 && (s.hpHighMax ?? s.hpHighMean) < 32.0) {
        const res = Math.max(0, s.esbKwh - meteredNonHp);
        if (hasDesk) idleResidualMetered.push(res);
        else idleResidualLegacy.push(res);
      }
      // Exclude 2 kW booster hours from compressor slope fit
      if (s.esbKwh >= 1.4 && hpDt < 10.0) continue;
      regPairs.push([hpDt, s.esbKwh]);
    }
  }

  let slope = 0.042;
  let intercept = 0.2;
  if (regPairs.length >= 24) {
    const n = regPairs.length;
    const mx = regPairs.reduce((a, p) => a + p[0], 0) / n;
    const my = regPairs.reduce((a, p) => a + p[1], 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (const [x, y] of regPairs) {
      sxx += (x - mx) ** 2;
      sxy += (x - mx) * (y - my);
    }
    if (sxx > 10) {
      const s = sxy / sxx;
      if (s > 0.015 && s < 0.12) {
        slope = s;
        intercept = Math.max(0.08, Math.min(0.45, my - slope * mx));
      }
    }
  }

  const idleLegacyFloor = Math.max(0.05, Math.min(0.25, median(idleResidualLegacy) ?? 0.135));
  const idleMeteredFloor = Math.max(0.03, Math.min(0.18, median(idleResidualMetered) ?? 0.075));

  const calibration: ModelCalibration = {
    interceptKwh: intercept,
    slopeKwhPerDeg: slope,
    idleUnmeasuredKwh: idleResidualMetered.length >= 12 ? idleMeteredFloor : idleLegacyFloor,
    sampleHours: regPairs.length,
  };

  const days: DaySummary[] = [];

  for (const [day, hrs] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const energyHours = hrs.filter((s) => s.hasEsb).length;
    const probeHours = hrs.filter((s) => s.hpHighMean !== null && s.hpLowMean !== null).length;
    const outVals = hrs.map((s) => s.outdoor).filter((v): v is number => v !== null);
    const outdoorHours = outVals.length;

    const estimated = energyHours < MIN_FULL_ESB_HOURS;
    const hasOutdoor = outdoorHours >= MIN_OUTDOOR_HOURS;
    const complete = hasOutdoor && (!estimated || probeHours >= MIN_FULL_PROBE_HOURS);

    const hdd = hasOutdoor
      ? outVals.reduce((acc, t) => acc + Math.max(0, baseTemp - t), 0) / outdoorHours
      : null;
    const meanOf = (vals: Array<number | null>) => {
      const ok = vals.filter((v): v is number => v !== null);
      return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
    };

    const hasDesk = dayHasDeskMeter.has(day);
    const idleFloor = hasDesk ? idleMeteredFloor : idleLegacyFloor;

    let totalKwh = 0;
    let nightKwh = 0;
    let spaceHeatKwh = 0;
    let hotWaterKwh = 0;
    let deskKwh = 0;
    let blanketKwh = 0;
    let lightingKwh = 0;
    let otherKwh = 0;

    const costs: CostBreakdown = {
      total: 0,
      energy: 0,
      standing: 0,
      spaceHeat: 0,
      hotWater: 0,
      desk: 0,
      blanket: 0,
      lighting: 0,
      other: 0,
    };

    let hpActiveHours = 0;
    let hpHighActiveSum = 0;
    let hpLowActiveSum = 0;
    let defrostHours = 0;
    let boosterDetected = false;
    let copNum = 0;
    let copDen = 0;
    let usedUpsFallback = false;

    for (const s of hrs) {
      const hasProbe = s.hpHighMean !== null && s.hpLowMean !== null;
      const hpDt = hasProbe ? Math.max(0, s.hpHighMean! - s.hpLowMean!) : 0;
      const hpHiMax = s.hpHighMax ?? s.hpHighMean ?? 0;
      const hpActive = hasProbe && (hpDt >= 2.5 || hpHiMax >= 32.0);
      const rStd = rateForHour(s.hour, tariff);

      // Hourly total electricity + standing charge (actual ESB or probe-calibrated estimate)
      let kwh = 0;
      let energyCost = 0;
      let standing = 0;
      let effRate = rStd;

      if (!estimated && s.hasEsb) {
        kwh = s.esbKwh;
        energyCost = s.esbEnergyCost > 0 ? s.esbEnergyCost : kwh * rStd;
        standing = s.esbStanding;
        effRate = kwh > 0 ? energyCost / kwh : rStd;
        nightKwh += s.esbNightKwh;
      } else if (estimated && hasProbe) {
        const meteredNonHp =
          (hasDesk ? (s.deskMeteredKwh ?? 0) : 0) +
          (s.blanketKwh ?? 0) +
          (s.lightingKwh ?? 0) +
          (s.chargerKwh ?? 0);
        const estBase = hasDesk ? meteredNonHp + idleMeteredFloor : intercept;
        kwh = Math.max(meteredNonHp, estBase + slope * hpDt);
        energyCost = kwh * rStd;
        standing = tariff.standingPerDay / 24;
        effRate = rStd;
        if (s.hour >= tariff.nightStart || s.hour < tariff.nightEnd) nightKwh += kwh;
      } else {
        continue;
      }

      // Metered / tracked non-HP loads
      let dK = 0;
      if (hasDesk) {
        dK = s.deskMeteredKwh ?? 0;
      } else if (day >= UPS_VALID_FROM && s.upsWatts !== null) {
        dK = s.upsWatts / 1000;
        usedUpsFallback = true;
      }
      const bK = s.blanketKwh ?? 0;
      const lK = s.lightingKwh ?? 0;
      const cK = s.chargerKwh ?? 0;

      // Clamp metered loads so they can never exceed total hour kWh
      const meteredSum = dK + bK + lK + cK;
      const scale = meteredSum > kwh && meteredSum > 0 ? kwh / meteredSum : 1;
      const dUse = dK * scale;
      const bUse = bK * scale;
      const lUse = lK * scale;
      const cUse = cK * scale;
      const rem = Math.max(0, kwh - (dUse + bUse + lUse + cUse));

      // Detect 2 kW booster / 60 °C Legionella sanitizer (high draw while compressor is off/low)
      const compPred = slope * hpDt;
      const isBooster =
        !estimated && rem - idleFloor > compPred + 0.55 && hpDt < 10.0 && (s.hour < 7 || s.hour >= 22);
      if (isBooster) boosterDetected = true;

      let othUse = 0;
      let dhwUse = 0;
      let heatUse = 0;

      if (!hpActive && !isBooster) {
        othUse = rem + cUse;
      } else {
        const flatFloor = Math.min(rem, idleFloor);
        othUse = flatFloor + cUse;
        const hpUse = Math.max(0, rem - flatFloor);
        if (isBooster) {
          dhwUse = Math.max(0, hpUse - compPred);
        } else if ((s.hour === 22 || s.hour === 23 || s.hour === 0) && hpHiMax >= 64.0 && hpUse > 0.55) {
          dhwUse = Math.min(hpUse, Math.max(0.3, hpUse - 0.5));
        }
        heatUse = Math.max(0, hpUse - dhwUse);
      }

      totalKwh += kwh;
      deskKwh += dUse;
      blanketKwh += bUse;
      lightingKwh += lUse;
      otherKwh += othUse;
      hotWaterKwh += dhwUse;
      spaceHeatKwh += heatUse;

      costs.energy += energyCost;
      costs.standing += standing;
      costs.total += energyCost + standing;
      costs.desk += dUse * effRate;
      costs.blanket += bUse * effRate;
      costs.lighting += lUse * effRate;
      costs.other += othUse * effRate;
      costs.hotWater += dhwUse * effRate;
      costs.spaceHeat += heatUse * effRate;

      // Thermodynamic COP estimate from outdoor temp + condensing proxy + defrost dips
      if (hasProbe && hpDt >= 3.0) {
        hpActiveHours += 1;
        hpHighActiveSum += s.hpHighMean!;
        hpLowActiveSum += s.hpLowMean!;
        const isDefrost = (s.hpLowMin ?? s.hpLowMean!) <= 18.0;
        if (isDefrost) defrostHours += 1;
        if (s.outdoor !== null) {
          const tFlow = Math.max(30, Math.min(50, s.hpLowMean! + 3.0));
          const lift = Math.max(12, tFlow - s.outdoor);
          const eta = isDefrost ? 0.4 : 0.45;
          const cop = (eta * (tFlow + 273.15)) / lift;
          copNum += cop * hpDt;
          copDen += hpDt;
        }
      }
    }

    const hpTotalKwh = spaceHeatKwh + hotWaterKwh;
    const hpTotalCost = costs.spaceHeat + costs.hotWater;
    const validHdd = hdd !== null && hdd >= 0.5;

    days.push({
      day,
      estimated,
      complete,
      energyHours,
      probeHours,
      outdoorHours,
      outdoorMean: meanOf(outVals),
      hdd,
      indoorMean: meanOf(hrs.map((s) => s.indoor)),
      livingMean: meanOf(hrs.map((s) => s.living)),
      bedroomMean: meanOf(hrs.map((s) => s.bedroom)),
      bathroomMean: meanOf(hrs.map((s) => s.bathroom)),
      storageMean: meanOf(hrs.map((s) => s.storage)),
      hpActiveHours,
      hpHighActiveMean: hpActiveHours > 0 ? hpHighActiveSum / hpActiveHours : null,
      hpLowActiveMean: hpActiveHours > 0 ? hpLowActiveSum / hpActiveHours : null,
      defrostHours,
      boosterDetected,
      estCop: copDen > 0 ? copNum / copDen : null,
      totalKwh,
      nightShare: totalKwh > 0 ? nightKwh / totalKwh : null,
      spaceHeatKwh,
      hotWaterKwh,
      deskKwh,
      deskFromUpsFallback: usedUpsFallback && !hasDesk,
      blanketKwh,
      lightingKwh,
      otherKwh,
      costs,
      hpCostPerHdd: validHdd && complete ? hpTotalCost / hdd! : null,
      hpKwhPerHdd: validHdd && complete ? hpTotalKwh / hdd! : null,
      totalCostPerHdd: validHdd && complete ? costs.energy / hdd! : null,
      totalKwhPerHdd: validHdd && complete ? totalKwh / hdd! : null,
    });
  }

  return { days, calibration };
}

/** Average a list of complete days into one summary CostBreakdown for the headline card. */
export function averageCosts(days: DaySummary[]): CostBreakdown | null {
  if (!days.length) return null;
  const n = days.length;
  const sum = (f: (d: DaySummary) => number) => days.reduce((a, d) => a + f(d), 0) / n;
  return {
    total: sum((d) => d.costs.total),
    energy: sum((d) => d.costs.energy),
    standing: sum((d) => d.costs.standing),
    spaceHeat: sum((d) => d.costs.spaceHeat),
    hotWater: sum((d) => d.costs.hotWater),
    desk: sum((d) => d.costs.desk),
    blanket: sum((d) => d.costs.blanket),
    lighting: sum((d) => d.costs.lighting),
    other: sum((d) => d.costs.other),
  };
}

/** Extract clean timestamped mean points from hourly/5m recorder statistics for line charts. */
export function extractSeries(rows: HourRow[] | undefined, fromMs: number): SeriesPoint[] {
  if (!rows) return [];
  const out: SeriesPoint[] = [];
  for (const r of rows) {
    if (r.start >= fromMs && r.mean !== null && r.mean !== undefined) {
      out.push({ ts: r.start, v: r.mean });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}
