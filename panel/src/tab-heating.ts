/**
 * Heating tab — is it cheaper to leave the heat pump on, or run it only off-peak?
 *
 * Three blocks, one purpose (compare two strategies fairly):
 *   1. Strategy switch: you set this whenever you change the Ecodan schedule. It feeds
 *      `sensor.heat_pump_strategy_off_peak_share`, a 0/1 statistic, so every past day
 *      keeps its tag after the 10-day recorder history is purged.
 *   2. Verdict: each strategy's fit evaluated at the same degree days.
 *   3. Energy signature chart: one dot per day, cost or kWh against degree days.
 * The per-day table sits behind a disclosure; it is evidence, not the answer.
 *
 * All maths lives in `heating.ts`.
 */

import { LitElement, css, html, nothing, svg } from "lit";
import { property, state } from "lit/decorators.js";
import { customElement } from "./custom-element";
import type { Hass } from "./api";
import {
  buildDays,
  normaliseRows,
  predict,
  summarise,
  MIN_FIT_DAYS,
  type DayRow,
  type Fit,
  type GroupSummary,
  type HourRow,
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
  outdoor: "sensor.entry_exterior_temperature",
  indoor: "sensor.indoor_temperature_average",
  strategy: "sensor.heat_pump_strategy_off_peak_share",
};
const STRATEGY_SELECT = "input_select.heat_pump_strategy";
const OPT_ALWAYS = "Always on";
const OPT_OFFPEAK = "Off-peak only";

const RANGES = [14, 30, 60, 90];
const BASE_KEY = "solace.heating.baseTemp";
const RANGE_KEY = "solace.heating.rangeDays";
const METRIC_KEY = "solace.heating.metric";
/** Met Éireann's degree-day base temperature. Editable below the chart. */
const DEFAULT_BASE = 15.5;

const COLOURS = {
  always: "var(--sol-cyan)",
  offpeak: "var(--sol-series-dusk)",
  mixed: "var(--sol-text-4)",
  untagged: "var(--sol-faint)",
} as const;
const LABELS = {
  always: OPT_ALWAYS,
  offpeak: OPT_OFFPEAK,
  mixed: "Switch-over day",
  untagged: "Not tagged",
} as const;

type Metric = "cost" | "kwh";

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
    /* private window — the setting just won't stick */
  }
};

const fmt = (v: number | null | undefined, digits = 1, unit = "") =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}${unit}`;
const eur = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `€${v.toFixed(2)}`;

// Chart frame in viewBox units.
const W = 760;
const H = 300;
const P = { x0: 56, x1: 744, y0: 14, y1: 256 };

@customElement("sol-tab-heating")
export class SolTabHeating extends LitElement {
  @property({ attribute: false }) hass!: Hass;

  @state() private days: DayRow[] = [];
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private rangeDays: number = load(RANGE_KEY, 30);
  @state() private baseTemp: number = load(BASE_KEY, DEFAULT_BASE);
  @state() private metric: Metric = load(METRIC_KEY, "cost");

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
      .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
      }
      .pills {
        display: inline-flex;
        gap: 4px;
        background: var(--sol-block);
        padding: 4px;
        border-radius: 10px;
      }
      .pill {
        border: none;
        background: transparent;
        color: var(--sol-text-3);
        font: inherit;
        font-size: 12.5px;
        padding: 6px 12px;
        border-radius: 8px;
        cursor: pointer;
      }
      .pill.active {
        background: var(--sol-cyan-tint);
        color: var(--sol-cyan);
      }
      .pill.active.offpeak {
        background: rgba(126, 87, 194, 0.18);
        color: var(--sol-series-dusk);
      }
      .verdict {
        font-size: 15px;
        line-height: 1.5;
        margin: 0 0 6px;
      }
      .verdict b {
        font-weight: 600;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12.5px;
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
      .swatch {
        display: inline-block;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        margin-right: 6px;
        vertical-align: middle;
      }
      .chart {
        position: relative;
        width: 100%;
      }
      .chart svg {
        width: 100%;
        height: auto;
        display: block;
      }
      .axis-label {
        font-size: 11px;
        fill: var(--sol-text-4);
        font-family: var(--sol-font-body);
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 14px;
        font-size: 12px;
        color: var(--sol-text-3);
        margin-top: 6px;
      }
      .scroll {
        overflow-x: auto;
      }
      details summary {
        cursor: pointer;
        color: var(--sol-text-3);
        font-size: 13px;
      }
      input[type="number"] {
        width: 64px;
        background: var(--sol-control);
        color: var(--sol-text);
        border: 1px solid var(--sol-hair);
        border-radius: var(--sol-r-control);
        padding: 4px 6px;
        font: inherit;
      }
      .muted {
        color: var(--sol-text-4);
      }
    `,
  ];

  updated() {
    const key = `${this.rangeDays}|${this.baseTemp}`;
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
      const start = new Date(end.getTime() - (this.rangeDays + 1) * 86_400_000);
      const raw = await send<Record<string, unknown>>({
        type: "recorder/statistics_during_period",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        statistic_ids: Object.values(IDS),
        period: "hour",
        types: ["change", "mean", "min"],
      });
      const stats: Record<string, HourRow[]> = {};
      for (const [id, rows] of Object.entries(raw ?? {})) stats[id] = normaliseRows(rows);
      const cutoff = new Intl.DateTimeFormat("en-CA", { timeZone: this.timeZone }).format(start);
      this.days = buildDays(stats, IDS, this.timeZone, this.baseTemp).filter((d) => d.day > cutoff);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  private setStrategy(option: string) {
    void this.hass.callService("input_select", "select_option", { entity_id: STRATEGY_SELECT, option });
  }

  private renderSwitch() {
    const current = this.hass?.states[STRATEGY_SELECT]?.state;
    return html`
      <div class="card">
        <div class="card-head">
          <ha-icon icon="mdi:heat-pump-outline"></ha-icon>
          <h2>What the heat pump is doing now</h2>
        </div>
        <div class="row">
          <div class="pills" role="radiogroup">
            <button
              class="pill ${current === OPT_ALWAYS ? "active" : ""}"
              role="radio"
              aria-checked=${current === OPT_ALWAYS}
              @click=${() => this.setStrategy(OPT_ALWAYS)}
            >
              ${OPT_ALWAYS}
            </button>
            <button
              class="pill offpeak ${current === OPT_OFFPEAK ? "active" : ""}"
              role="radio"
              aria-checked=${current === OPT_OFFPEAK}
              @click=${() => this.setStrategy(OPT_OFFPEAK)}
            >
              ${OPT_OFFPEAK} (23:00–08:00)
            </button>
          </div>
        </div>
        <p class="caption">
          Change this on the same day you change the Ecodan schedule. Each day is tagged with whatever
          ran most of that day. A day with a switch-over is left out of the comparison.
        </p>
      </div>
    `;
  }

  private renderVerdict(always: GroupSummary, offpeak: GroupSummary, typicalHdd: number | null) {
    const fit = (g: GroupSummary): Fit | null => (this.metric === "cost" ? g.costFit : g.kwhFit);
    const a = typicalHdd === null ? null : predict(fit(always), typicalHdd);
    const o = typicalHdd === null ? null : predict(fit(offpeak), typicalHdd);
    const show = (v: number | null) => (this.metric === "cost" ? eur(v) : fmt(v, 1, " kWh"));

    let verdict;
    if (a !== null && o !== null && typicalHdd !== null) {
      const diff = o - a;
      const cheaper = diff < 0 ? OPT_OFFPEAK : OPT_ALWAYS;
      const pct = a !== 0 ? Math.abs(diff / a) * 100 : 0;
      verdict = html`<p class="verdict">
        On a typical day here (${fmt(typicalHdd, 1)} degree days), <b>${cheaper}</b>
        ${this.metric === "cost" ? "costs" : "uses"} <b>${show(Math.abs(diff))}</b> less per day
        (${fmt(pct, 0, "%")}): ${OPT_ALWAYS} ${show(a)}, ${OPT_OFFPEAK} ${show(o)}.
      </p>`;
    } else {
      const need = (g: GroupSummary) =>
        g.days >= MIN_FIT_DAYS ? "needs a wider spread of weather" : `has ${g.days} of ${MIN_FIT_DAYS} days`;
      verdict = html`<p class="verdict">
        Not enough data for a fair comparison yet. ${OPT_ALWAYS} ${need(always)}; ${OPT_OFFPEAK}
        ${need(offpeak)}. Run each for about a week, ideally alternating, so both see cold and mild
        days.
      </p>`;
    }

    const row = (label: string, f: (g: GroupSummary) => unknown) =>
      html`<tr><td>${label}</td><td>${f(always)}</td><td>${f(offpeak)}</td></tr>`;

    return html`
      <div class="card">
        <div class="card-head">
          <ha-icon icon="mdi:scale-balance"></ha-icon>
          <h2>Always on vs off-peak only</h2>
        </div>
        ${verdict}
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th></th>
                <th><span class="swatch" style="background:${COLOURS.always}"></span>${OPT_ALWAYS}</th>
                <th><span class="swatch" style="background:${COLOURS.offpeak}"></span>${OPT_OFFPEAK}</th>
              </tr>
            </thead>
            <tbody>
              ${row("Days counted", (g) => g.days)}
              ${row("Average outside", (g) => fmt(g.outdoorMean, 1, " °C"))}
              ${row("Average degree days", (g) => fmt(g.hddMean, 1))}
              ${row("Cost per day (energy only)", (g) => eur(g.costPerDay))}
              ${row("kWh per day", (g) => fmt(g.kwhPerDay, 1))}
              ${row("Share on night rate", (g) => fmt(g.nightShare === null ? null : g.nightShare * 100, 0, "%"))}
              ${row("Heating: kWh per degree day", (g) => fmt(g.kwhFit?.slope, 2))}
              ${row("Heating: € per degree day", (g) => eur(g.costFit?.slope))}
              ${row("Baseload kWh per day (fit)", (g) => fmt(g.kwhFit?.intercept, 1))}
              ${row("Fit quality (R²)", (g) => fmt(g.kwhFit?.r2, 2))}
              ${row("kWh per °C·day held inside", (g) => fmt(g.kwhPerDeltaDay, 2))}
              ${row("Average inside", (g) => fmt(g.indoorMean, 1, " °C"))}
              ${row("Coldest inside", (g) => fmt(g.indoorMin, 1, " °C"))}
            </tbody>
          </table>
        </div>
        <p class="caption">
          Cost excludes the daily standing charge, which is the same either way. "kWh per °C·day held
          inside" divides use by the indoor-outdoor difference the flat actually kept, so a strategy that
          saves money only by letting the flat get colder shows up here and in "Coldest inside".
        </p>
      </div>
    `;
  }

  private renderChart(always: GroupSummary, offpeak: GroupSummary) {
    const pts = this.days.filter((d) => d.complete);
    const y = (d: DayRow) => (this.metric === "cost" ? d.cost : d.kwh);
    const xs = pts.map((d) => d.hdd as number);
    const ys = pts.map(y);
    const xMax = Math.max(4, ...xs) * 1.08;
    const yMax = Math.max(this.metric === "cost" ? 1 : 4, ...ys) * 1.1;
    const sx = (v: number) => P.x0 + (v / xMax) * (P.x1 - P.x0);
    const sy = (v: number) => P.y1 - (v / yMax) * (P.y1 - P.y0);
    const step = (max: number, n: number) => {
      const raw = max / n;
      const mag = 10 ** Math.floor(Math.log10(raw));
      return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
    };
    const xStep = step(xMax, 6);
    const yStep = step(yMax, 5);
    const xTicks = Array.from({ length: Math.floor(xMax / xStep) + 1 }, (_, i) => i * xStep);
    const yTicks = Array.from({ length: Math.floor(yMax / yStep) + 1 }, (_, i) => i * yStep);
    const line = (fit: Fit | null, colour: string) =>
      fit
        ? svg`<line x1=${sx(0)} y1=${sy(fit.intercept)} x2=${sx(xMax)} y2=${sy(fit.intercept + fit.slope * xMax)}
            stroke=${colour} stroke-width="2" stroke-dasharray="6 5" opacity="0.8"/>`
        : nothing;
    const yLabel = this.metric === "cost" ? "€ per day (energy)" : "kWh per day";

    return html`
      <div class="card">
        <div class="card-head">
          <ha-icon icon="mdi:chart-scatter-plot"></ha-icon>
          <h2>Energy signature</h2>
        </div>
        <div class="row" style="margin-bottom:10px">
          <div class="pills">
            ${(["cost", "kwh"] as Metric[]).map(
              (m) => html`<button
                class="pill ${this.metric === m ? "active" : ""}"
                @click=${() => {
                  this.metric = m;
                  save(METRIC_KEY, m);
                }}
              >
                ${m === "cost" ? "Cost" : "kWh"}
              </button>`
            )}
          </div>
          <div class="pills">
            ${RANGES.map(
              (r) => html`<button
                class="pill ${this.rangeDays === r ? "active" : ""}"
                @click=${() => {
                  this.rangeDays = r;
                  save(RANGE_KEY, r);
                }}
              >
                ${r} days
              </button>`
            )}
          </div>
          ${this.loading ? html`<span class="muted">Loading…</span>` : nothing}
        </div>
        ${pts.length === 0
          ? html`<p class="caption">
              No complete days yet. The ESB meter reports a day or two late, and the outside sensor
              started recording on 9 November.
            </p>`
          : html`<div class="chart">
              <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily ${yLabel} against heating degree days">
                ${yTicks.map(
                  (t) => svg`<line x1=${P.x0} x2=${P.x1} y1=${sy(t)} y2=${sy(t)} stroke="var(--sol-hair)"/>
                    <text class="axis-label" x=${P.x0 - 8} y=${sy(t) + 4} text-anchor="end">${
                      this.metric === "cost" ? `€${t.toFixed(t < 1 ? 2 : t % 1 ? 1 : 0)}` : t.toFixed(t % 1 ? 1 : 0)
                    }</text>`
                )}
                ${xTicks.map(
                  (t) => svg`<text class="axis-label" x=${sx(t)} y=${P.y1 + 18} text-anchor="middle">${t.toFixed(
                    t % 1 ? 1 : 0
                  )}</text>`
                )}
                <text class="axis-label" x=${(P.x0 + P.x1) / 2} y=${H - 4} text-anchor="middle">
                  Heating degree days (base ${this.baseTemp} °C) — colder →
                </text>
                ${line(this.metric === "cost" ? always.costFit : always.kwhFit, COLOURS.always)}
                ${line(this.metric === "cost" ? offpeak.costFit : offpeak.kwhFit, COLOURS.offpeak)}
                ${pts.map(
                  (d) => svg`<circle cx=${sx(d.hdd as number)} cy=${sy(y(d))} r="6"
                    fill=${COLOURS[d.strategy]} fill-opacity=${
                      d.strategy === "always" || d.strategy === "offpeak" ? 0.9 : 0.45
                    } stroke="var(--sol-card)" stroke-width="1.5">
                    <title>${d.day}: ${fmt(d.hdd, 1)} degree days, ${fmt(d.outdoorMean, 1)} °C out, ${fmt(
                      d.kwh,
                      1
                    )} kWh, ${eur(d.cost)}, ${LABELS[d.strategy]}</title></circle>`
                )}
              </svg>
            </div>
            <div class="legend">
              ${(["always", "offpeak", "mixed", "untagged"] as const).map(
                (s) => html`<span><span class="swatch" style="background:${COLOURS[s]}"></span>${LABELS[s]}</span>`
              )}
              <span class="muted">Dashed line = each strategy's fit</span>
            </div>`}
        <p class="caption">
          One dot per day. Colder days sit further right. A lower line means that strategy spends less at
          the same weather. Degree-day base:
          <input
            type="number"
            step="0.5"
            min="10"
            max="20"
            .value=${String(this.baseTemp)}
            @change=${(e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(v) && v >= 10 && v <= 20) {
                this.baseTemp = v;
                save(BASE_KEY, v);
              }
            }}
          />
          °C (Met Éireann uses 15.5).
        </p>
      </div>
    `;
  }

  private renderDays() {
    const rows = [...this.days].reverse();
    return html`
      <div class="card">
        <details>
          <summary>Day by day (${rows.length} days)</summary>
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Strategy</th>
                  <th>Outside</th>
                  <th>Degree days</th>
                  <th>Inside</th>
                  <th>kWh</th>
                  <th>Night</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(
                  (d) => html`<tr class=${d.complete ? "" : "muted"}>
                    <td>${d.day}</td>
                    <td><span class="swatch" style="background:${COLOURS[d.strategy]}"></span>${LABELS[d.strategy]}</td>
                    <td>${fmt(d.outdoorMean, 1, " °C")}</td>
                    <td>${fmt(d.hdd, 1)}</td>
                    <td>${fmt(d.indoorMean, 1, " °C")}</td>
                    <td>${d.energyHours ? fmt(d.kwh, 1) : "—"}</td>
                    <td>${d.kwh > 0 ? fmt((d.kwhNight / d.kwh) * 100, 0, "%") : "—"}</td>
                    <td>${d.energyHours ? eur(d.cost) : "—"}</td>
                  </tr>`
                )}
              </tbody>
            </table>
          </div>
          <p class="caption">Greyed rows are incomplete: meter data not in yet, or under 20 hours of outside readings.</p>
        </details>
      </div>
    `;
  }

  render() {
    if (this.error) {
      return html`<div class="card"><p class="caption">Could not load statistics: ${this.error}</p></div>`;
    }
    const always = summarise(this.days, "always");
    const offpeak = summarise(this.days, "offpeak");
    const tagged = this.days.filter(
      (d) => d.complete && (d.strategy === "always" || d.strategy === "offpeak") && d.hdd !== null
    );
    const typicalHdd = tagged.length ? tagged.reduce((s, d) => s + (d.hdd as number), 0) / tagged.length : null;
    return html`<div class="stack">
      ${this.renderSwitch()} ${this.renderVerdict(always, offpeak, typicalHdd)}
      ${this.renderChart(always, offpeak)} ${this.renderDays()}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-tab-heating": SolTabHeating;
  }
}
