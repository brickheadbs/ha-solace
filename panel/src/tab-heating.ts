/**
 * Heating & Energy tab — daily efficiency per HDD, estimated cost breakdown,
 * all room + external temperatures, and heat pump high/low pressure curves.
 *
 * Minimal, chart-first design:
 *   1. Daily Efficiency per HDD bar chart (click any day bar to inspect its costs)
 *   2. Estimated Daily Spend breakdown (Space Heat, Hot Water, Desk, Blanket, Lighting, Other, Standing)
 *   3. Live Room, External & Heat Pump Pressures + 24h/7d multi-line curves
 *   4. Collapsed day-by-day table for drill-down only
 *
 * All maths lives in `heating.ts`.
 */

import { LitElement, css, html, nothing, svg } from "lit";
import { property, state } from "lit/decorators.js";
import { customElement } from "./custom-element";
import type { Hass } from "./api";
import {
  averageCosts,
  buildHeatingDays,
  extractSeries,
  FOUR_PERIOD_SWITCH_DAY,
  normaliseRows,
  type CostBreakdown,
  type DaySummary,
  type HourRow,
  type ModelCalibration,
  type SeriesPoint,
  type StatIds,
} from "./heating";
import { tokens } from "./tokens";

const MPRN = "10309721554";
const IDS: StatIds = {
  kwhDay: `esb_smart_meter:usage_day_${MPRN}`,
  kwhNight: `esb_smart_meter:usage_night_${MPRN}`,
  kwhPeak: `esb_smart_meter:usage_peak_${MPRN}`,
  costDay: `esb_smart_meter:usage_cost_day_${MPRN}`,
  costNight: `esb_smart_meter:usage_cost_night_${MPRN}`,
  costPeak: `esb_smart_meter:usage_cost_peak_${MPRN}`,
  standing: `esb_smart_meter:standing_charge_${MPRN}`,
  outdoor: "sensor.entry_exterior_temperature",
  indoor: "sensor.indoor_temperature_average",
  living: "sensor.office_temperature",
  bedroom: "sensor.bedroom_temperature",
  bathroom: "sensor.bathroom_temperature",
  storage: "sensor.entrance_temperature",
  hpHigh: "sensor.heat_pump_high_pressure_temperature",
  hpLow: "sensor.heat_pump_low_pressure_temperature",
  deskEnergy: "sensor.desk_outlet_energy",
  upsPower: "sensor.eaton_ups_power_1m_throttled",
  blanketEnergy: "sensor.electric_blanket_energy",
  lightingEnergy: "sensor.all_lighting_energy",
  chargerEnergy: "sensor.bedroom_smart_plug_today_s_consumption",
};

type EffMetric = "eur_hdd" | "kwh_hdd" | "cop";
type CurveWindow = 24 | 168;

const RANGES = [14, 30] as const;
const METRIC_KEY = "solace.heating.v2.metric";
const RANGE_KEY = "solace.heating.v2.range";
const CURVE_KEY = "solace.heating.v2.curve";

const load = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window */
  }
};

const fmt = (v: number | null | undefined, digits = 1, unit = "") =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}${unit}`;
const eur = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `€${v.toFixed(2)}`;
const shortDay = (iso: string) => {
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = months[Number(parts[1]) - 1] ?? parts[1];
  return `${Number(parts[2])} ${m}`;
};

const COST_ITEMS: Array<{ key: keyof CostBreakdown; label: string; color: string; est?: boolean }> = [
  { key: "spaceHeat", label: "Space heating", color: "#4fc3f7", est: true },
  { key: "hotWater", label: "Hot water (DHW)", color: "#ffb74d", est: true },
  { key: "desk", label: "Desk", color: "#9575cd" },
  { key: "blanket", label: "Electric blanket", color: "#f06292" },
  { key: "lighting", label: "Lighting (18 bulbs)", color: "#ffd54f" },
  { key: "other", label: "Other / always-on", color: "#78909c" },
  { key: "standing", label: "Standing charge", color: "#546e7a" },
];

const ROOM_LINES = [
  { id: IDS.living, label: "Living Room", color: "#ffb74d" },
  { id: IDS.bedroom, label: "Bedroom", color: "#4fc3f7" },
  { id: IDS.bathroom, label: "Bathroom", color: "#81c784" },
  { id: IDS.storage, label: "Storage", color: "#90a4ae" },
  { id: IDS.outdoor, label: "Outside", color: "#9575cd" },
] as const;

const HP_LINES = [
  { id: IDS.hpHigh, label: "High pressure (discharge)", color: "#ff8a65" },
  { id: IDS.hpLow, label: "Low pressure (return)", color: "#4fc3f7" },
] as const;

@customElement("sol-tab-heating")
export class SolTabHeating extends LitElement {
  @property({ attribute: false }) hass!: Hass;

  @state() private days: DaySummary[] = [];
  @state() private stats: Record<string, HourRow[]> = {};
  @state() private calibration: ModelCalibration | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;

  @state() private rangeDays: number = load(RANGE_KEY, 14);
  @state() private metric: EffMetric = load(METRIC_KEY, "eur_hdd");
  @state() private curveHours: CurveWindow = load(CURVE_KEY, 24);
  @state() private selectedDay: string | null = null;

  private fetchedFor = "";

  static styles = [
    tokens,
    css`
      :host {
        display: block;
      }
      .stack {
        display: grid;
        gap: 14px;
      }
      .head-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 12px;
      }
      .head-row .card-head {
        margin-bottom: 0;
      }
      .controls {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .pills {
        display: inline-flex;
        gap: 3px;
        background: var(--sol-block);
        padding: 3px;
        border-radius: 9px;
      }
      .pill {
        border: none;
        background: transparent;
        color: var(--sol-text-3);
        font: inherit;
        font-size: 12px;
        padding: 5px 10px;
        border-radius: 7px;
        cursor: pointer;
      }
      .pill.active {
        background: var(--sol-cyan-tint);
        color: var(--sol-cyan);
        font-weight: 500;
      }
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 10px;
        margin-bottom: 14px;
      }
      .kpi {
        background: var(--sol-block);
        border-radius: var(--sol-r-block);
        padding: 11px 13px;
      }
      .kpi-val {
        font-size: 22px;
        font-weight: 500;
        color: var(--sol-text);
        line-height: 1.2;
        margin-top: 2px;
      }
      .kpi-sub {
        font-size: 11.5px;
        color: var(--sol-text-3);
        margin-top: 3px;
      }
      .chart {
        width: 100%;
      }
      .chart svg {
        width: 100%;
        height: auto;
        display: block;
      }
      .axis-label {
        font-size: 10.5px;
        fill: var(--sol-text-4);
        font-family: var(--sol-font-body);
      }
      .bar-val {
        font-size: 10px;
        fill: var(--sol-text-2);
        font-family: var(--sol-font-body);
      }
      .bar-hit {
        cursor: pointer;
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        font-size: 11.5px;
        color: var(--sol-text-3);
        margin-top: 8px;
        align-items: center;
      }
      .swatch {
        display: inline-block;
        width: 9px;
        height: 9px;
        border-radius: 2px;
        margin-right: 6px;
        vertical-align: middle;
      }
      .swatch.round {
        border-radius: 50%;
      }
      .stacked-bar {
        display: flex;
        height: 14px;
        border-radius: 7px;
        overflow: hidden;
        background: var(--sol-block);
        margin: 10px 0 14px;
        gap: 2px;
      }
      .stacked-seg {
        height: 100%;
        min-width: 3px;
        transition: opacity 0.15s;
      }
      .cost-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 8px 18px;
      }
      .cost-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 5px 0;
        border-bottom: 1px solid var(--sol-hair-faint);
        font-size: 13px;
      }
      .cost-name {
        color: var(--sol-text-2);
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .cost-num {
        color: var(--sol-text);
        font-weight: 500;
      }
      .cost-kwh {
        color: var(--sol-text-4);
        font-size: 11.5px;
        margin-left: 6px;
        font-weight: 400;
      }
      .tag {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        padding: 1px 5px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.07);
        color: var(--sol-text-3);
      }
      .tag.est {
        background: rgba(79, 195, 247, 0.14);
        color: var(--sol-cyan);
      }
      .tag.warn {
        background: rgba(255, 183, 77, 0.16);
        color: var(--sol-amber);
      }
      .tag.hot {
        background: rgba(239, 83, 80, 0.16);
        color: #ef9a9a;
      }
      .tag.ok {
        background: rgba(102, 187, 106, 0.15);
        color: #81c784;
      }
      .live-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 14px;
        align-items: center;
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid var(--sol-hair-faint);
        font-size: 12px;
        color: var(--sol-text-3);
      }
      .live-bar strong {
        color: var(--sol-text-2);
        font-weight: 500;
      }
      .sensor-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
        gap: 8px;
        margin-bottom: 14px;
      }
      .sensor-tile {
        background: var(--sol-block);
        border-radius: var(--sol-r-block);
        padding: 9px 11px;
      }
      .sensor-tile-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 4px;
        font-size: 11px;
        color: var(--sol-text-3);
      }
      .sensor-tile-val {
        font-size: 18px;
        font-weight: 500;
        color: var(--sol-text);
        margin-top: 3px;
      }
      .sensor-tile-sub {
        font-size: 11px;
        color: var(--sol-text-4);
        margin-top: 2px;
      }
      .charts-2 {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 14px;
      }
      .sub-chart-title {
        font-size: 12px;
        font-weight: 500;
        color: var(--sol-text-2);
        margin: 0 0 6px;
      }
      .scroll {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
        margin-top: 8px;
      }
      th,
      td {
        text-align: right;
        padding: 6px 8px;
        border-bottom: 1px solid var(--sol-hair-faint);
        white-space: nowrap;
      }
      th:first-child,
      td:first-child {
        text-align: left;
      }
      th {
        color: var(--sol-text-4);
        font-weight: 500;
      }
      details summary {
        cursor: pointer;
        color: var(--sol-text-3);
        font-size: 13px;
      }
      .muted {
        color: var(--sol-text-4);
      }
      .reset-btn {
        border: 1px solid var(--sol-hair);
        background: var(--sol-control);
        color: var(--sol-text-2);
        font: inherit;
        font-size: 11.5px;
        padding: 3px 9px;
        border-radius: 6px;
        cursor: pointer;
      }
    `,
  ];

  updated() {
    const key = String(this.rangeDays);
    if (this.hass && key !== this.fetchedFor) {
      this.fetchedFor = key;
      void this.fetch();
    }
  }

  private get timeZone(): string {
    return (this.hass as any)?.config?.time_zone ?? "Europe/Dublin";
  }

  private async fetch() {
    this.loading = true;
    this.error = null;
    try {
      const send = this.hass.callWS
        ? this.hass.callWS.bind(this.hass)
        : this.hass.connection.sendMessagePromise.bind(this.hass.connection);
      const end = new Date();
      const start = new Date(end.getTime() - (this.rangeDays + 2) * 86_400_000);
      const raw = await send<Record<string, unknown>>({
        type: "recorder/statistics_during_period",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        statistic_ids: Object.values(IDS),
        period: "hour",
        types: ["change", "mean", "min", "max"],
      });
      const stats: Record<string, HourRow[]> = {};
      for (const [id, rows] of Object.entries(raw ?? {})) {
        stats[id] = normaliseRows(rows);
      }
      const cutoff = new Intl.DateTimeFormat("en-CA", { timeZone: this.timeZone }).format(
        new Date(end.getTime() - this.rangeDays * 86_400_000)
      );
      const built = buildHeatingDays(stats, IDS, this.timeZone, 15.5);
      this.stats = stats;
      this.days = built.days.filter((d) => d.day >= cutoff);
      this.calibration = built.calibration;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  private stateNum(entityId: string): number | null {
    const v = parseFloat(this.hass?.states?.[entityId]?.state ?? "");
    return Number.isFinite(v) ? v : null;
  }

  private isStale(entityId: string, hours = 24): boolean {
    const lc = this.hass?.states?.[entityId]?.last_changed;
    if (!lc) return false;
    const ms = Date.parse(lc);
    return Number.isFinite(ms) && Date.now() - ms > hours * 3_600_000;
  }

  private metricVal(d: DaySummary): number | null {
    if (this.metric === "eur_hdd") return d.hpCostPerHdd;
    if (this.metric === "kwh_hdd") return d.hpKwhPerHdd;
    return d.estCop;
  }

  private renderEfficiencyChart(completeDays: DaySummary[]) {
    const plotted = completeDays.filter((d) => this.metricVal(d) !== null);
    const W = 760;
    const H = 250;
    const P = { x0: 48, x1: 744, y0: 22, y1: 212 };

    const vals = plotted.map((d) => this.metricVal(d) as number);
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    const maxRaw = Math.max(
      this.metric === "cop" ? 5.5 : this.metric === "eur_hdd" ? 0.3 : 1.2,
      ...vals
    );
    const yMax = maxRaw * 1.18;
    const sy = (v: number) => P.y1 - (v / yMax) * (P.y1 - P.y0);

    const tickCount = 4;
    const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => (yMax / tickCount) * i);

    const slotW = plotted.length ? (P.x1 - P.x0) / plotted.length : 40;
    const barW = Math.min(44, Math.max(10, slotW * 0.62));

    const fmtTick = (v: number) =>
      this.metric === "eur_hdd" ? `€${v.toFixed(2)}` : v.toFixed(1);
    const fmtBar = (v: number) =>
      this.metric === "eur_hdd" ? `€${v.toFixed(2)}` : v.toFixed(this.metric === "cop" ? 1 : 2);

    const switchIdx = plotted.findIndex((d) => d.day >= FOUR_PERIOD_SWITCH_DAY);
    const switchX = switchIdx > 0 ? P.x0 + switchIdx * slotW : null;

    const latestComplete = completeDays.length ? completeDays[completeDays.length - 1] : null;
    const last7 = completeDays.slice(-7);
    const avgCost = averageCosts(last7);
    const avgCopVals = last7.map((d) => d.estCop).filter((v): v is number => v !== null);
    const avgCop = avgCopVals.length ? avgCopVals.reduce((a, b) => a + b, 0) / avgCopVals.length : null;

    return html`
      <div class="card">
        <div class="head-row">
          <div class="card-head">
            <ha-icon icon="mdi:chart-bar"></ha-icon>
            <h2>Daily efficiency per HDD</h2>
          </div>
          <div class="controls">
            <div class="pills">
              ${(
                [
                  ["eur_hdd", "€/HDD"],
                  ["kwh_hdd", "kWh/HDD"],
                  ["cop", "Est. COP"],
                ] as const
              ).map(
                ([m, label]) => html`
                  <button
                    class="pill ${this.metric === m ? "active" : ""}"
                    @click=${() => {
                      this.metric = m;
                      save(METRIC_KEY, m);
                    }}
                  >
                    ${label}
                  </button>
                `
              )}
            </div>
            <div class="pills">
              ${RANGES.map(
                (r) => html`
                  <button
                    class="pill ${this.rangeDays === r ? "active" : ""}"
                    @click=${() => {
                      this.rangeDays = r;
                      save(RANGE_KEY, r);
                    }}
                  >
                    ${r}d
                  </button>
                `
              )}
            </div>
          </div>
        </div>

        <div class="kpi-strip">
          <div class="kpi">
            <div class="eyebrow">Heating efficiency (${last7.length}d avg)</div>
            <div class="kpi-val tab-num">
              ${avg !== null
                ? this.metric === "eur_hdd"
                  ? `${eur(avg)}/HDD`
                  : this.metric === "kwh_hdd"
                    ? `${fmt(avg, 2)} kWh/HDD`
                    : `${fmt(avg, 1)} COP`
                : "—"}
            </div>
            <div class="kpi-sub">
              ${this.metric === "cop" ? "Higher is better · weather + probes" : "Lower is better · heat pump only"}
            </div>
          </div>
          <div class="kpi">
            <div class="eyebrow">Est. heating + DHW (${last7.length}d avg)</div>
            <div class="kpi-val tab-num">
              ${avgCost ? eur(avgCost.spaceHeat + avgCost.hotWater) : "—"}<span style="font-size:13px;color:var(--sol-text-3)">/day</span>
            </div>
            <div class="kpi-sub">
              Space ${eur(avgCost?.spaceHeat)} · Hot water ${eur(avgCost?.hotWater)}
            </div>
          </div>
          <div class="kpi">
            <div class="eyebrow">Total electricity (${last7.length}d avg)</div>
            <div class="kpi-val tab-num">
              ${eur(avgCost?.total)}<span style="font-size:13px;color:var(--sol-text-3)">/day</span>
            </div>
            <div class="kpi-sub">
              Incl. ${eur(avgCost?.standing)} standing · Est. COP ${fmt(avgCop, 1)}
            </div>
          </div>
          <div class="kpi">
            <div class="eyebrow">Latest full day (${latestComplete ? shortDay(latestComplete.day) : "—"})</div>
            <div class="kpi-val tab-num">
              ${eur(latestComplete?.costs.total)}
              ${latestComplete?.estimated ? html`<span class="tag est" style="vertical-align:middle">Est</span>` : nothing}
            </div>
            <div class="kpi-sub">
              Out ${fmt(latestComplete?.outdoorMean, 1, "°")} · ${fmt(latestComplete?.hdd, 1)} HDD · COP ${fmt(latestComplete?.estCop, 1)}
            </div>
          </div>
        </div>

        ${this.loading
          ? html`<p class="caption">Loading recorder statistics...</p>`
          : plotted.length === 0
            ? html`<p class="caption">Waiting for complete outdoor + energy days.</p>`
            : html`
                <div class="chart">
                  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily heating efficiency per HDD">
                    <defs>
                      <pattern id="estHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                        <line x1="0" y1="0" x2="0" y2="6" stroke="var(--sol-cyan)" stroke-width="2" stroke-opacity="0.55" />
                      </pattern>
                    </defs>

                    ${yTicks.map(
                      (t) => svg`
                        <line x1=${P.x0} x2=${P.x1} y1=${sy(t)} y2=${sy(t)} stroke="var(--sol-hair)" />
                        <text class="axis-label tab-num" x=${P.x0 - 6} y=${sy(t) + 3.5} text-anchor="end">${fmtTick(t)}</text>
                      `
                    )}

                    ${avg !== null
                      ? svg`
                          <line x1=${P.x0} x2=${P.x1} y1=${sy(avg)} y2=${sy(avg)}
                            stroke="var(--sol-text-3)" stroke-width="1" stroke-dasharray="4 4" opacity="0.6" />
                        `
                      : nothing}

                    ${switchX !== null
                      ? svg`
                          <line x1=${switchX} x2=${switchX} y1=${P.y0 - 4} y2=${P.y1}
                            stroke="var(--sol-amber)" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.7" />
                          <text class="axis-label" x=${switchX + 4} y=${P.y0 + 6} fill="var(--sol-amber)">4-period</text>
                        `
                      : nothing}

                    ${plotted.map((d, i) => {
                      const val = this.metricVal(d) as number;
                      const cx = P.x0 + (i + 0.5) * slotW;
                      const x = cx - barW / 2;
                      const y = sy(val);
                      const h = Math.max(2, P.y1 - y);
                      const selected = this.selectedDay === d.day;
                      const fill = d.estimated
                        ? "url(#estHatch)"
                        : this.metric === "cop"
                          ? "#66bb6a"
                          : "var(--sol-cyan)";
                      const stroke = selected
                        ? "#ffffff"
                        : d.estimated
                          ? "var(--sol-cyan)"
                          : "none";
                      const strokeW = selected ? 2 : d.estimated ? 1.2 : 0;
                      const showXLabel = plotted.length <= 16 || i % 2 === 0 || i === plotted.length - 1;
                      return svg`
                        <g class="bar-hit" @click=${() => {
                          this.selectedDay = this.selectedDay === d.day ? null : d.day;
                        }}>
                          <rect x=${x} y=${y} width=${barW} height=${h} rx="4"
                            fill=${fill} fill-opacity=${selected ? 1 : d.estimated ? 0.9 : 0.82}
                            stroke=${stroke} stroke-width=${strokeW}
                            stroke-dasharray=${d.estimated && !selected ? "3 2" : "none"}>
                            <title>${shortDay(d.day)} (${d.estimated ? "Probe estimate — ESB pending" : "ESB actual"})
Outside ${fmt(d.outdoorMean, 1, "°C")} · ${fmt(d.hdd, 1)} HDD · Est. COP ${fmt(d.estCop, 2)}
Heat pump: ${eur(d.costs.spaceHeat + d.costs.hotWater)} (${fmt(d.hpCostPerHdd, 2)} €/HDD, ${fmt(d.hpKwhPerHdd, 2)} kWh/HDD)
Total spend: ${eur(d.costs.total)} (Space ${eur(d.costs.spaceHeat)}, Hot water ${eur(d.costs.hotWater)}, Desk ${eur(d.costs.desk)}, Blanket ${eur(d.costs.blanket)}, Lights ${eur(d.costs.lighting)}, Standing ${eur(d.costs.standing)})</title>
                          </rect>
                          <text class="bar-val tab-num" x=${cx} y=${y - 5} text-anchor="middle">${fmtBar(val)}</text>
                          ${showXLabel
                            ? svg`<text class="axis-label" x=${cx} y=${P.y1 + 16} text-anchor="middle">${shortDay(d.day)}</text>`
                            : nothing}
                          ${d.boosterDetected
                            ? svg`<circle cx=${cx} cy=${P.y1 + 26} r="2.5" fill="var(--sol-amber)"><title>2 kW DHW booster / sanitizer cycle</title></circle>`
                            : nothing}
                        </g>
                      `;
                    })}
                  </svg>
                </div>
                <div class="legend">
                  <span><span class="swatch" style="background:${this.metric === "cop" ? "#66bb6a" : "var(--sol-cyan)"}"></span>ESB actual</span>
                  <span><span class="swatch" style="background:transparent;border:1.5px dashed var(--sol-cyan)"></span>Probe estimate (ESB lag)</span>
                  <span><span class="swatch round" style="background:var(--sol-amber)"></span>2 kW DHW booster / sanitizer day</span>
                  <span class="muted">Click any bar to inspect that day's spend</span>
                </div>
              `}
      </div>
    `;
  }

  private renderCostBreakdown(completeDays: DaySummary[]) {
    const picked = this.selectedDay ? completeDays.find((d) => d.day === this.selectedDay) ?? null : null;
    const avgWindow = completeDays.slice(-7);
    const costs = picked ? picked.costs : averageCosts(avgWindow);
    const titleSuffix = picked
      ? `${shortDay(picked.day)}${picked.estimated ? " (Est.)" : ""}`
      : `${avgWindow.length}-day average`;

    const kwhFor = (key: keyof CostBreakdown): number | null => {
      const list = picked ? [picked] : avgWindow;
      if (!list.length) return null;
      const avg = (f: (d: DaySummary) => number) => list.reduce((a, d) => a + f(d), 0) / list.length;
      switch (key) {
        case "spaceHeat": return avg((d) => d.spaceHeatKwh);
        case "hotWater": return avg((d) => d.hotWaterKwh);
        case "desk": return avg((d) => d.deskKwh);
        case "blanket": return avg((d) => d.blanketKwh);
        case "lighting": return avg((d) => d.lightingKwh);
        case "other": return avg((d) => d.otherKwh);
        default: return null;
      }
    };

    const deskFallback = picked
      ? picked.deskFromUpsFallback
      : avgWindow.length > 0 && avgWindow.every((d) => d.deskFromUpsFallback);

    const deskW = this.stateNum("sensor.desk_outlet_power");
    const blanketW = this.stateNum("sensor.electric_blanket_power");
    const lightsW = this.stateNum("sensor.all_lighting_power");
    const rateZone = this.hass?.states?.["sensor.electricity_rate_zone"]?.state ?? "—";

    const visibleItems = costs
      ? COST_ITEMS.filter((item) => {
          const val = costs[item.key];
          if (item.key === "blanket" || item.key === "lighting") return val >= 0.005;
          return true;
        })
      : [];

    return html`
      <div class="card">
        <div class="head-row">
          <div class="card-head">
            <ha-icon icon="mdi:currency-eur"></ha-icon>
            <h2>Estimated spend breakdown — ${titleSuffix}</h2>
          </div>
          <div class="controls">
            ${picked
              ? html`<button class="reset-btn" @click=${() => (this.selectedDay = null)}>Show ${avgWindow.length}-day avg</button>`
              : nothing}
            ${costs
              ? html`<span class="tab-num" style="font-size:17px;font-weight:600">${eur(costs.total)}<span class="muted" style="font-size:12px;font-weight:400">/day</span></span>`
              : nothing}
          </div>
        </div>

        ${costs && costs.total > 0
          ? html`
              <div class="stacked-bar" role="img" aria-label="Daily electricity cost share">
                ${visibleItems.map((item) => {
                  const pct = (costs[item.key] / costs.total) * 100;
                  if (pct < 0.4) return nothing;
                  return html`<div
                    class="stacked-seg"
                    style="width:${pct.toFixed(2)}%;background:${item.color}"
                    title="${item.label}: ${eur(costs[item.key])} (${pct.toFixed(0)}%)"
                  ></div>`;
                })}
              </div>

              <div class="cost-grid">
                ${visibleItems.map((item) => {
                  const val = costs[item.key];
                  const kwh = kwhFor(item.key);
                  const pct = costs.total > 0 ? (val / costs.total) * 100 : 0;
                  const label = item.key === "desk" && deskFallback ? "Desk (UPS est.)" : item.label;
                  return html`
                    <div class="cost-row">
                      <span class="cost-name">
                        <span class="swatch" style="background:${item.color};margin-right:2px"></span>
                        ${label}
                        ${item.est ? html`<span class="tag">est</span>` : nothing}
                      </span>
                      <span class="cost-num tab-num">
                        ${eur(val)}
                        <span class="cost-kwh">${kwh !== null ? `${kwh.toFixed(1)} kWh · ` : ""}${pct.toFixed(0)}%</span>
                      </span>
                    </div>
                  `;
                })}
              </div>
            `
          : html`<p class="caption">No complete days in the selected window yet.</p>`}

        <div class="live-bar tab-num">
          <span>Live now:</span>
          <span>Desk <strong>${fmt(deskW, 0, " W")}</strong></span>
          <span>Blanket <strong>${fmt(blanketW, 0, " W")}</strong></span>
          <span>Lighting <strong>${fmt(lightsW, 0, " W")}</strong></span>
          <span class="muted">${rateZone}</span>
        </div>
      </div>
    `;
  }

  private renderLineChart(
    series: Array<{ label: string; color: string; points: SeriesPoint[] }>,
    opts: { refLineY?: number; refLabel?: string; unit?: string } = {}
  ) {
    const allPts = series.flatMap((s) => s.points);
    if (allPts.length < 2) {
      return html`<p class="caption">Not enough history points yet.</p>`;
    }
    const W = 520;
    const H = 190;
    const P = { x0: 40, x1: 506, y0: 14, y1: 160 };

    const tMin = Math.min(...allPts.map((p) => p.ts));
    const tMax = Math.max(...allPts.map((p) => p.ts));
    const tSpan = Math.max(3_600_000, tMax - tMin);

    let yMin = Math.min(...allPts.map((p) => p.v));
    let yMax = Math.max(...allPts.map((p) => p.v));
    if (opts.refLineY !== undefined) {
      yMin = Math.min(yMin, opts.refLineY);
      yMax = Math.max(yMax, opts.refLineY);
    }
    const yPad = Math.max(1.5, (yMax - yMin) * 0.1);
    yMin = Math.floor(yMin - yPad);
    yMax = Math.ceil(yMax + yPad);
    const ySpan = Math.max(2, yMax - yMin);

    const sx = (ts: number) => P.x0 + ((ts - tMin) / tSpan) * (P.x1 - P.x0);
    const sy = (v: number) => P.y1 - ((v - yMin) / ySpan) * (P.y1 - P.y0);

    const yTicks = [yMin, yMin + ySpan * 0.33, yMin + ySpan * 0.67, yMax];
    const xTickCount = this.curveHours <= 24 ? 4 : 5;
    const xTicks = Array.from({ length: xTickCount + 1 }, (_, i) => tMin + (tSpan / xTickCount) * i);
    const fmtX = (ts: number) =>
      this.curveHours <= 24
        ? new Intl.DateTimeFormat("en-GB", {
            timeZone: this.timeZone,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).format(new Date(ts))
        : new Intl.DateTimeFormat("en-GB", {
            timeZone: this.timeZone,
            day: "numeric",
            month: "short",
          }).format(new Date(ts));

    const unit = opts.unit ?? "°";

    return html`
      <div class="chart">
        <svg viewBox="0 0 ${W} ${H}">
          ${yTicks.map(
            (v) => svg`
              <line x1=${P.x0} x2=${P.x1} y1=${sy(v)} y2=${sy(v)} stroke="var(--sol-hair)" />
              <text class="axis-label tab-num" x=${P.x0 - 6} y=${sy(v) + 3.5} text-anchor="end">${Math.round(v)}${unit}</text>
            `
          )}
          ${xTicks.map(
            (ts) => svg`
              <text class="axis-label tab-num" x=${sx(ts)} y=${P.y1 + 16} text-anchor="middle">${fmtX(ts)}</text>
            `
          )}
          ${opts.refLineY !== undefined
            ? svg`
                <line x1=${P.x0} x2=${P.x1} y1=${sy(opts.refLineY)} y2=${sy(opts.refLineY)}
                  stroke="var(--sol-amber)" stroke-width="1" stroke-dasharray="4 4" opacity="0.55" />
                ${opts.refLabel
                  ? svg`<text class="axis-label" x=${P.x1 - 2} y=${sy(opts.refLineY) - 4} text-anchor="end" fill="var(--sol-amber)">${opts.refLabel}</text>`
                  : nothing}
              `
            : nothing}
          ${series.map((s) => {
            if (s.points.length < 2) return nothing;
            const d = s.points
              .map((p, idx) => `${idx === 0 ? "M" : "L"}${sx(p.ts).toFixed(1)},${sy(p.v).toFixed(1)}`)
              .join(" ");
            return svg`<path d=${d} fill="none" stroke=${s.color} stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" />`;
          })}
        </svg>
      </div>
      <div class="legend">
        ${series.map(
          (s) => html`<span><span class="swatch round" style="background:${s.color}"></span>${s.label}</span>`
        )}
      </div>
    `;
  }

  private renderClimateAndHeatPump() {
    const living = this.stateNum(IDS.living);
    const bedroom = this.stateNum(IDS.bedroom);
    const bathroom = this.stateNum(IDS.bathroom);
    const storage = this.stateNum(IDS.storage);
    const storageStale = this.isStale(IDS.storage, 24);
    const insideAvg = this.stateNum(IDS.indoor);
    const outside = this.stateNum(IDS.outdoor);
    const hpHi = this.stateNum(IDS.hpHigh);
    const hpLo = this.stateNum(IDS.hpLow);
    const hpDelta = hpHi !== null && hpLo !== null ? hpHi - hpLo : null;

    const weather = this.hass?.states?.["weather.forecast_home"];
    const wind = weather?.attributes?.wind_speed as number | undefined;
    const cond = weather?.state ?? "";

    let hpBadge = html`<span class="tag">Idle</span>`;
    if (hpLo !== null && hpLo <= 18 && hpHi !== null && hpHi >= 28) {
      hpBadge = html`<span class="tag warn">Defrost</span>`;
    } else if (hpHi !== null && hpHi >= 60) {
      hpBadge = html`<span class="tag hot">DHW / High</span>`;
    } else if (hpDelta !== null && hpDelta >= 3) {
      hpBadge = html`<span class="tag ok">Heating</span>`;
    }

    const fromMs = Date.now() - this.curveHours * 3_600_000;
    const roomSeries = ROOM_LINES.map((l) => ({
      label: l.label,
      color: l.color,
      points: extractSeries(this.stats[l.id], fromMs),
    }));
    const hpSeries = HP_LINES.map((l) => ({
      label: l.label,
      color: l.color,
      points: extractSeries(this.stats[l.id], fromMs),
    }));

    return html`
      <div class="card">
        <div class="head-row">
          <div class="card-head">
            <ha-icon icon="mdi:thermometer-lines"></ha-icon>
            <h2>Rooms, outside &amp; heat pump probes</h2>
          </div>
          <div class="pills">
            ${([24, 168] as const).map(
              (h) => html`
                <button
                  class="pill ${this.curveHours === h ? "active" : ""}"
                  @click=${() => {
                    this.curveHours = h;
                    save(CURVE_KEY, h);
                  }}
                >
                  ${h === 24 ? "24h" : "7d"}
                </button>
              `
            )}
          </div>
        </div>

        <div class="sensor-grid tab-num">
          <div class="sensor-tile">
            <div class="sensor-tile-head"><span>Living Room</span></div>
            <div class="sensor-tile-val">${fmt(living, 1, "°C")}</div>
            <div class="sensor-tile-sub">Inside avg ${fmt(insideAvg, 1, "°")}</div>
          </div>
          <div class="sensor-tile">
            <div class="sensor-tile-head"><span>Bedroom</span></div>
            <div class="sensor-tile-val">${fmt(bedroom, 1, "°C")}</div>
            <div class="sensor-tile-sub">
              ${living !== null && bedroom !== null ? `${(bedroom - living).toFixed(1)}° vs living` : "—"}
            </div>
          </div>
          <div class="sensor-tile">
            <div class="sensor-tile-head"><span>Bathroom</span></div>
            <div class="sensor-tile-val">${fmt(bathroom, 1, "°C")}</div>
            <div class="sensor-tile-sub">
              ${fmt(this.stateNum("sensor.bathroom_humidity"), 0, "% RH")}
            </div>
          </div>
          <div class="sensor-tile">
            <div class="sensor-tile-head">
              <span>Storage</span>
              ${storageStale ? html`<span class="tag warn">stale</span>` : nothing}
            </div>
            <div class="sensor-tile-val">${fmt(storage, 1, "°C")}</div>
            <div class="sensor-tile-sub">${storageStale ? "Unchanged >24h" : "Unheated"}</div>
          </div>
          <div class="sensor-tile">
            <div class="sensor-tile-head"><span>Outside</span></div>
            <div class="sensor-tile-val">${fmt(outside, 1, "°C")}</div>
            <div class="sensor-tile-sub">
              ${cond ? cond : "—"}${wind !== undefined ? ` · ${Math.round(wind)} km/h` : ""}
            </div>
          </div>
          <div class="sensor-tile">
            <div class="sensor-tile-head">
              <span>HP High</span>
              ${hpBadge}
            </div>
            <div class="sensor-tile-val">${fmt(hpHi, 1, "°C")}</div>
            <div class="sensor-tile-sub">Discharge line</div>
          </div>
          <div class="sensor-tile">
            <div class="sensor-tile-head"><span>HP Low</span></div>
            <div class="sensor-tile-val">${fmt(hpLo, 1, "°C")}</div>
            <div class="sensor-tile-sub">ΔT ${fmt(hpDelta, 1, "°C")}</div>
          </div>
        </div>

        <div class="charts-2">
          <div>
            <div class="sub-chart-title">All rooms &amp; external temperature (${this.curveHours === 24 ? "24h" : "7d"})</div>
            ${this.renderLineChart(roomSeries)}
          </div>
          <div>
            <div class="sub-chart-title">Heat pump high vs. low pressure (${this.curveHours === 24 ? "24h" : "7d"})</div>
            ${this.renderLineChart(hpSeries, { refLineY: 18, refLabel: "Defrost <18°" })}
          </div>
        </div>
      </div>
    `;
  }

  private renderDayLog() {
    const rows = [...this.days].reverse();
    return html`
      <div class="card">
        <details>
          <summary>Day-by-day detail (${rows.length} days)</summary>
          <div class="scroll">
            <table class="tab-num">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Outside</th>
                  <th>HDD</th>
                  <th>Total €</th>
                  <th>Heat €</th>
                  <th>DHW €</th>
                  <th>Desk €</th>
                  <th>Blanket / Lights</th>
                  <th>€/HDD</th>
                  <th>Est. COP</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(
                  (d) => html`
                    <tr class=${d.complete ? "" : "muted"}>
                      <td>
                        ${shortDay(d.day)}
                        ${d.estimated ? html`<span class="tag est">est</span>` : nothing}
                        ${d.boosterDetected ? html`<span class="tag warn">2kW</span>` : nothing}
                      </td>
                      <td>${fmt(d.outdoorMean, 1, "°")}</td>
                      <td>${fmt(d.hdd, 1)}</td>
                      <td>${d.complete ? eur(d.costs.total) : "—"}</td>
                      <td>${d.complete ? eur(d.costs.spaceHeat) : "—"}</td>
                      <td>${d.complete ? eur(d.costs.hotWater) : "—"}</td>
                      <td>${d.complete ? eur(d.costs.desk) : "—"}</td>
                      <td>${d.complete ? eur(d.costs.blanket + d.costs.lighting) : "—"}</td>
                      <td>${d.hpCostPerHdd !== null ? eur(d.hpCostPerHdd) : "—"}</td>
                      <td>${fmt(d.estCop, 1)}</td>
                    </tr>
                  `
                )}
              </tbody>
            </table>
          </div>
          ${this.calibration
            ? html`<p class="caption">
                Probe model calibrated from ${this.calibration.sampleHours} live ESB hours
                (${this.calibration.interceptKwh.toFixed(2)} kWh/h base + ${this.calibration.slopeKwhPerDeg.toFixed(3)} kWh/°C pipe ΔT).
              </p>`
            : nothing}
        </details>
      </div>
    `;
  }

  render() {
    if (this.error) {
      return html`<div class="card"><p class="caption">Could not load statistics: ${this.error}</p></div>`;
    }
    const completeDays = this.days.filter((d) => d.complete);
    return html`
      <div class="stack">
        ${this.renderEfficiencyChart(completeDays)}
        ${this.renderCostBreakdown(completeDays)}
        ${this.renderClimateAndHeatPump()}
        ${this.renderDayLog()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-tab-heating": SolTabHeating;
  }
}
