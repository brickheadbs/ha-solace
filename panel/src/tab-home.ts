/**
 * Home — the new master home overview tab for Solace.
 *
 * Integrates real-time environmental instrumentation (Light, Weather, Inside/Outside temperatures,
 * Hot water, Refrigerator) and "Running now" telemetry (Washing machine, Device charging) with
 * direct access to the room bias controls.
 */

import { LitElement, css, html, nothing, svg } from "lit";
import { property, state } from "lit/decorators.js";
import { customElement } from "./custom-element";
import type { Hass, RoomRow, Snapshot } from "./api";
import { setRoom } from "./api";
import { num, stopLabel } from "./fmt";
import { fetchHistory, type Sample } from "./history";
import { buildSpark, clockAt, type Spark, type SparkOptions } from "./sparkline";
import { tokens } from "./tokens";
import "./ui";

/** The band is this tall in real pixels, on every card, so nothing is stretched. */
const BAND_H = 96;
/**
 * Where the series mean sits inside the band, measured from the floor. Lifts every
 * curve to the same height so a row of cards reads as one set rather than five
 * unrelated charts that each happen to hug their own minimum.
 */
const SPARK_ANCHOR = 0.66;

const LUX = "sensor.entry_exterior_illuminance";
const INSIDE_TEMP = "sensor.kitchen_kitchen_thermostat_temperature";
const OUTSIDE_TEMP = "sensor.entry_exterior_temperature";
const HOT_WATER_TEMP = "sensor.hot_water_temperature_temperature";
const FRIDGE_TEMP = "sensor.refrigerator_temperature_temperature";

const WEATHER = "weather.forecast_home";
const HEAT_LINK = "water_heater.kitchen_kitchen_heat_link";
const THERMOSTAT = "climate.kitchen_kitchen_thermostat";

const TRACKED = [LUX, INSIDE_TEMP, OUTSIDE_TEMP, HOT_WATER_TEMP, FRIDGE_TEMP];

/**
 * Refrigerator alarm thresholds, °C — calibrated against this fridge's own history rather
 * than food-safety guidance, because the alarm has to describe *this* fridge.
 *
 * **Cold — 1 °C.** Counting only dips that survive the 30-minute debounce over 14 days:
 * 0.3 → 0 alerts (never reached; decorative), **1.0 → 1** (the real 233-minute dip to
 * 0.8 on 08-12), 1.5 → 6, 2.5 → 23. The fridge's moody wobbles bottom out at 1.3, so 1
 * sits just under them and still catches a genuine excursion.
 *
 * **Warm — 5 °C, and deliberately noisy.** 40 days of daily statistics show *no* drift
 * (+0.025 °C/week; first-third mean 3.40 vs last-third 3.64). What they do show is a
 * discrete six-day warm episode, 08-04 → 08-09, daily means 4.0–4.8 against a 3.4
 * baseline. Split at the recovery:
 *
 *   08-04 → 08-11 (warm spell)   mean 3.85  p95 5.3   >5 °C: 16 alerts   >6 °C: 0
 *   08-12 → now   (healthy)      mean 3.16  p95 4.3   >5 °C:  0 alerts   >6 °C: 0
 *
 * 5 °C fires sixteen times through the fault and *not once* while healthy — which is the
 * alarm working, not the alarm being noisy. An earlier pass set this to 6 to quieten
 * those sixteen; that tuned the threshold to hide the only event it existed to catch.
 * Do not raise it again without checking which window the "noise" came from.
 *
 * Hour-of-day is flat (means 2.9–3.9 across all 24), so warm periods are not hiding at
 * night — the discrepancy with "it reads under 4 whenever I look" was the anomaly week.
 *
 * Duplicated in `automation.refrigerator_temperature_out_of_range`. Move both.
 */
const FRIDGE_COLD = 1;
const FRIDGE_WARM = 5;

/** `weather.forecast_home` condition → the mdi icon HA already ships for it. */
const WEATHER_ICON: Record<string, string> = {
  "clear-night": "mdi:weather-night",
  cloudy: "mdi:weather-cloudy",
  exceptional: "mdi:alert-circle-outline",
  fog: "mdi:weather-fog",
  hail: "mdi:weather-hail",
  lightning: "mdi:weather-lightning",
  "lightning-rainy": "mdi:weather-lightning-rainy",
  partlycloudy: "mdi:weather-partly-cloudy",
  pouring: "mdi:weather-pouring",
  rainy: "mdi:weather-rainy",
  snowy: "mdi:weather-snowy",
  "snowy-rainy": "mdi:weather-snowy-rainy",
  sunny: "mdi:weather-sunny",
  windy: "mdi:weather-windy",
  "windy-variant": "mdi:weather-windy-variant",
};

const weatherIcon = (condition?: string) =>
  WEATHER_ICON[condition ?? ""] ?? "mdi:weather-cloudy";

interface ForecastPoint {
  datetime: string;
  condition?: string;
  temperature?: number;
  templow?: number;
  precipitation?: number;
}

/** Forecasts move slowly; met.no updates hourly at best. */
const FORECAST_REFRESH_MS = 600_000;

/** How often the 24h window is re-pulled. The cards themselves tick every second. */
const HISTORY_REFRESH_MS = 120_000;

@customElement("sol-tab-home")
export class SolTabHome extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;

  @state() private biasOpen = false;
  @state() private draftBias: Record<string, number> = {};
  @state() private history: Map<string, Sample[]> = new Map();
  /** Window the sparklines share, so all six cards line up on the same 24 hours. */
  @state() private windowEnd = Date.now();
  @state() private hourly: ForecastPoint[] = [];
  @state() private daily: ForecastPoint[] = [];
  @state() private hwOpen = false;
  private timer?: number;
  private historyTimer?: number;
  private forecastTimer?: number;
  private _debounceTimers: Map<string, number> = new Map();

  connectedCallback() {
    super.connectedCallback();
    this.timer = window.setInterval(() => this.requestUpdate(), 1000);
    this.historyTimer = window.setInterval(() => this.loadHistory(), HISTORY_REFRESH_MS);
    this.forecastTimer = window.setInterval(() => this.loadForecast(), FORECAST_REFRESH_MS);
    this.loadHistory();
    this.loadForecast();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timer) clearInterval(this.timer);
    if (this.historyTimer) clearInterval(this.historyTimer);
    if (this.forecastTimer) clearInterval(this.forecastTimer);
    for (const t of this._debounceTimers.values()) {
      clearTimeout(t);
    }
    this._debounceTimers.clear();
  }

  updated() {
    // `hass` usually lands after the first connection, so the initial pull is kicked
    // from here rather than only from connectedCallback.
    if (this.hass && !this.historyRequested) {
      this.historyRequested = true;
      this.loadHistory();
      this.loadForecast();
    }
  }

  private historyRequested = false;

  private async loadHistory() {
    if (!this.hass) return;
    const data = await fetchHistory(this.hass, TRACKED, 24);
    if (!data.size) return;
    this.history = data;
    this.windowEnd = Date.now();
  }

  /**
   * `weather.get_forecasts` with `return_response`, over the WS `call_service` command.
   *
   * Preferred over `weather/subscribe_forecast` because a forecast changes hourly at
   * best — a live subscription would be a lifecycle to manage for no extra freshness.
   */
  private async loadForecast() {
    if (!this.hass) return;
    const send = this.hass.callWS
      ? this.hass.callWS.bind(this.hass)
      : this.hass.connection.sendMessagePromise.bind(this.hass.connection);

    const pull = async (type: "hourly" | "daily"): Promise<ForecastPoint[]> => {
      try {
        const res = await send<{ response?: Record<string, { forecast?: ForecastPoint[] }> }>({
          type: "call_service",
          domain: "weather",
          service: "get_forecasts",
          service_data: { type },
          target: { entity_id: WEATHER },
          return_response: true,
        });
        return res?.response?.[WEATHER]?.forecast ?? [];
      } catch {
        return [];
      }
    };

    const [hourly, daily] = await Promise.all([pull("hourly"), pull("daily")]);
    if (hourly.length) this.hourly = hourly;
    if (daily.length) this.daily = daily;
  }

  static styles = [
    tokens,
    css`
      :host {
        display: block;
      }

      .g2 {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 10px;
        margin-bottom: 10px;
      }
      @media (max-width: 720px) {
        .g2 {
          grid-template-columns: 1fr;
        }
      }

      .sec-head {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 18px 0 10px;
      }
      .sec-head:first-child {
        margin-top: 0;
      }
      .sec-head ha-icon {
        --mdc-icon-size: 18px;
        color: var(--sol-text-4);
      }
      .sec-title {
        font-size: 11px;
        font-weight: 500;
        letter-spacing: 1.3px;
        text-transform: uppercase;
        color: var(--sol-text-3);
      }
      .sec-line {
        flex: 1;
        height: 1px;
        background: rgba(255, 255, 255, 0.08);
      }
      .sec-sub {
        font-size: 11px;
        color: var(--sol-faint);
      }

      /* Cards */
      .card-wrap {
        position: relative;
        overflow: hidden;
        background: var(--sol-card, #1a1a1b);
        border-radius: var(--sol-r-card, 14px);
        padding: 14px 18px;
        min-height: 150px;
        display: flex;
        flex-direction: column;
        box-shadow: var(--sol-shadow);
      }

      .c-head {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 9px;
        flex-wrap: wrap;
      }
      .c-head ha-icon {
        --mdc-icon-size: 19px;
      }
      .c-title {
        font-size: 12px;
        font-weight: 500;
        letter-spacing: 0.8px;
        text-transform: uppercase;
        color: var(--sol-text-3);
      }
      .grow {
        flex: 1;
      }
      .c-status {
        font-size: 11.5px;
        color: var(--sol-text-4);
      }

      .btn-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: none;
        border-radius: 11px;
        padding: 5px 11px;
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
        transition: filter 0.15s ease;
      }
      .btn-pill:hover {
        filter: brightness(1.25);
      }
      .btn-pill ha-icon {
        --mdc-icon-size: 15px;
      }
      .head-btn-stack {
        display: inline-flex;
        flex-direction: column;
        gap: 5px;
      }

      /* One body shape for every card: main readout left, sub-data hard right, both on
         the same baseline. The cards drifted apart because each one improvised. */
      .c-body {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: flex-start;
        gap: 22px;
        margin-top: 12px;
        flex-wrap: nowrap;
      }
      .c-main {
        /* The main figure sits slightly in from the card edge rather than flush with
           the title above it. */
        padding-left: 6px;
        min-width: 0;
      }
      .c-side {
        margin-left: auto;
        text-align: right;
        flex-shrink: 0;
      }

      .big-val {
        font-family: var(--sol-font-body);
        font-weight: 300;
        font-size: 48px;
        line-height: 0.85;
        letter-spacing: -0.03em;
        font-variant-numeric: tabular-nums;
        color: var(--sol-text);
        min-width: 150px;
      }
      .big-val.mono-gold {
        color: var(--sol-amber, #ffb74d);
        font-size: 50px;
      }
      .big-val .unit {
        font-size: 20px;
        color: var(--sol-text-4);
      }

      .stat-grid {
        display: flex;
        gap: 20px;
        padding-bottom: 4px;
        flex-wrap: wrap;
      }
      .stat-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .stat-label {
        font-size: 10.5px;
        letter-spacing: 0.7px;
        text-transform: uppercase;
        color: var(--sol-text-4);
      }
      .stat-val {
        font-family: var(--sol-font-body);
        font-weight: 500;
        font-size: 19px;
        font-variant-numeric: tabular-nums;
        color: var(--sol-text-2);
      }

      .small-grid {
        display: grid;
        grid-template-columns: auto auto;
        gap: 3px 12px;
        margin-left: auto;
        text-align: right;
        font-size: 11px;
        white-space: nowrap;
      }
      .sg-k {
        color: var(--sol-faint);
      }
      .sg-v {
        font-family: var(--sol-font-body);
        font-variant-numeric: tabular-nums;
        color: var(--sol-text-3);
      }
      /* The side column overlaps the sparkline on tall cards, same as the captions. */
      .small-grid span {
        text-shadow:
          0 0 4px var(--sol-card),
          0 0 8px var(--sol-card);
      }

      /* High stacked above Low, both flush left, so "higher" reads vertically. */
      .high-low {
        position: relative;
        z-index: 1;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
        margin-top: auto;
        padding-top: 10px;
        font-size: 11.5px;
        color: var(--sol-text-3);
        white-space: nowrap;
        flex-wrap: wrap;
        /* The caption sits over the sparkline's densest ink. A halo in the card colour
           keeps it readable without a scrim rectangle, and follows the theme. */
        text-shadow:
          0 0 4px var(--sol-card),
          0 0 8px var(--sol-card);
      }
      .high-low b {
        font-family: var(--sol-font-body);
        font-variant-numeric: tabular-nums;
        color: var(--sol-text-2);
        font-weight: 500;
      }
      /* A label column of fixed width is what actually aligns the two numbers; without
         it "High" and "Low" are different widths and the values step sideways. */
      .hl-k {
        display: inline-block;
        width: 30px;
        color: var(--sol-faint);
      }
      .hl-t {
        margin-left: 6px;
        color: var(--sol-faint);
      }

      /* Sparkline band.
         Fixed pixel height, anchored to the card floor, stretched horizontally only —
         see sparkline.ts. The old full-bleed SVG scaled a 60px viewBox to the whole
         card and distorted every curve vertically. */
      .band {
        position: absolute;
        left: 0;
        bottom: 0;
        /* An absolutely positioned <svg> is a replaced element: left/right:0 alone
           leaves it at its intrinsic viewBox width (300px) instead of stretching, which
           parks the curve against the card's right edge. The width is not optional. */
        width: 100%;
        height: ${BAND_H}px;
        display: block;
        z-index: 0;
        pointer-events: none;
        /* Feather the left edge so the curve enters rather than starting mid-air. */
        -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 9%, #000 100%);
        mask-image: linear-gradient(90deg, transparent 0, #000 9%, #000 100%);
      }
      .band-dot {
        /* Non-scaling so the horizontal stretch cannot turn it into an ellipse. */
        vector-effect: non-scaling-stroke;
      }
      .band-empty {
        position: absolute;
        left: 18px;
        bottom: 12px;
        z-index: 0;
        font-size: 10.5px;
        letter-spacing: 0.4px;
        color: var(--sol-faint);
        pointer-events: none;
      }

      /* Collapsible Bias Drawer */
      .bias-drawer {
        position: relative;
        z-index: 1;
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 8px 18px;
      }
      @media (max-width: 580px) {
        .bias-drawer {
          grid-template-columns: 1fr;
        }
      }
      .room-bias-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .rb-name {
        flex: 0 0 70px;
        font-size: 11.5px;
        color: var(--sol-text-2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .rb-val {
        flex: 0 0 44px;
        text-align: right;
        font-family: var(--sol-font-body);
        font-variant-numeric: tabular-nums;
        font-size: 11px;
        color: var(--sol-text-3);
      }
      .rb-val.active {
        color: var(--sol-amber);
      }

      /* HVAC Control */
      .hvac-modes {
        display: flex;
        background: var(--sol-control, #232426);
        border-radius: 11px;
        padding: 2px;
        gap: 2px;
      }
      .hvac-btn {
        border: none;
        cursor: pointer;
        border-radius: 9px;
        padding: 4px 10px;
        font-size: 11px;
        font-weight: 500;
        background: transparent;
        color: var(--sol-text-3);
      }
      .hvac-btn.active {
        background: #3a3d40;
        color: var(--sol-text);
      }
      .hvac-btn.active-heat {
        background: rgba(239, 83, 80, 0.25);
        color: #ef5350;
      }
      .hvac-btn.active-eco {
        background: rgba(102, 187, 106, 0.25);
        color: #81c784;
      }
      .temp-stepper {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .step-btn {
        background: var(--sol-control, #242426);
        border: none;
        border-radius: 6px;
        color: var(--sol-text-2);
        width: 28px;
        height: 20px;
        font-size: 14px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .step-btn:hover {
        background: #35383b;
      }

      /* − [Target 20.5°] + on one row, so the control reads as a single unit instead
         of a value with two loose buttons beside it. */
      .setpoint {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .setpoint .step-btn {
        width: 24px;
        height: 24px;
        font-size: 15px;
      }
      .setpoint-val {
        display: flex;
        flex-direction: column;
        align-items: center;
        line-height: 1.15;
        min-width: 62px;
      }
      .setpoint-val span:last-child {
        font-family: var(--sol-font-body);
        font-weight: 500;
        font-size: 17px;
        font-variant-numeric: tabular-nums;
      }

      /* Progress Bars for Running Now */
      .bar-track {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 12px;
        background: rgba(0, 0, 0, 0.35);
      }
      .bar-fill {
        position: absolute;
        left: 0;
        bottom: 0;
        height: 12px;
        background: var(--sol-cyan);
        transition: width 0.3s ease;
      }
      .bar-needle {
        position: absolute;
        bottom: 0;
        height: 12px;
        width: 2px;
        background: #ef5350;
      }

      /* Running now — the idle form.
         An appliance that is off has one fact to report, so it gets one line instead of
         a 150px card holding a 34px "Off / Standby". */
      .idle-strip {
        display: flex;
        align-items: center;
        gap: 14px;
        flex-wrap: wrap;
        background: var(--sol-card, #1a1a1b);
        border-radius: var(--sol-r-card, 14px);
        box-shadow: var(--sol-shadow);
        padding: 10px 16px;
        min-height: 0;
      }
      .idle-item {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        font-size: 12px;
        color: var(--sol-text-4);
        white-space: nowrap;
      }
      .idle-item ha-icon {
        --mdc-icon-size: 16px;
        color: var(--sol-faint);
      }
      .idle-item b {
        font-family: var(--sol-font-body);
        font-variant-numeric: tabular-nums;
        font-weight: 500;
        color: var(--sol-text-3);
      }
      .idle-sep {
        width: 1px;
        align-self: stretch;
        background: var(--sol-hair);
      }
      /* When one appliance runs and the other doesn't, the chip must not stretch to the
         running card's height — it sits at the top of its grid cell instead. */
      .g2-run {
        align-items: start;
      }

      .run-phase {
        font-size: 34px;
        font-weight: 200;
        line-height: 0.9;
        color: var(--sol-text);
        text-transform: capitalize;
      }
      .run-badge {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 11px;
        font-weight: 500;
        text-transform: uppercase;
        color: var(--sol-green);
      }
      .run-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--sol-green);
        display: inline-block;
      }

      /* Threshold states. Amber and red are load-bearing here (a fridge out of range),
         which is the one case tokens.ts allows amber for something other than light. */
      .alert-cold {
        color: var(--sol-amber) !important;
      }
      .alert-warm {
        color: #ef5350 !important;
      }
      .alert-tag {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 11px;
        font-weight: 500;
        letter-spacing: 0.6px;
        text-transform: uppercase;
      }

      /* Weather forecast — hourly precipitation bars under a temperature line, then a
         six-day strip. Replaces the placeholder hatched panel. */
      .fc {
        position: relative;
        z-index: 1;
        margin-top: 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        flex: 1;
      }
      .fc-now {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .fc-now ha-icon {
        --mdc-icon-size: 40px;
        color: var(--sol-cyan);
      }
      .fc-temp {
        font-family: var(--sol-font-body);
        font-weight: 300;
        font-size: 38px;
        line-height: 0.9;
        letter-spacing: -0.03em;
        font-variant-numeric: tabular-nums;
      }
      .fc-cond {
        font-size: 12px;
        color: var(--sol-text-3);
        text-transform: capitalize;
      }
      .fc-sub {
        font-size: 11px;
        color: var(--sol-faint);
      }
      .fc-hours {
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: 1fr;
        align-items: end;
        gap: 2px;
        height: 42px;
      }
      .fc-hour {
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        align-items: center;
        gap: 3px;
        height: 100%;
      }
      .fc-bar {
        width: 60%;
        min-height: 1px;
        border-radius: 2px 2px 0 0;
        background: var(--sol-cyan);
        opacity: 0.75;
      }
      /* A dry hour still has to occupy the timeline, or a dry morning looks like
         missing data rather than "no rain". */
      .fc-bar.dry {
        background: var(--sol-text-4);
        opacity: 0.45;
      }
      .fc-hlabel {
        font-size: 9px;
        color: var(--sol-faint);
        font-variant-numeric: tabular-nums;
      }
      .fc-days {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: 4px;
        border-top: 1px solid var(--sol-hair);
        padding-top: 8px;
      }
      .fc-day {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
      }
      .fc-day ha-icon {
        --mdc-icon-size: 18px;
        color: var(--sol-text-3);
      }
      .fc-dname {
        font-size: 10px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        color: var(--sol-text-4);
      }
      .fc-dtemp {
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: var(--sol-text-2);
      }
      .fc-dtemp span {
        color: var(--sol-faint);
      }

      /* Hot-water drawer — same disclosure pattern as the Light card's bias drawer. */
      .hw-drawer {
        position: relative;
        z-index: 1;
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid var(--sol-hair);
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 8px 18px;
      }
      @media (max-width: 580px) {
        .hw-drawer {
          grid-template-columns: 1fr;
        }
      }
      .hw-row {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 24px;
      }
      .hw-k {
        flex: 1;
        font-size: 11.5px;
        color: var(--sol-text-2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .hw-v {
        flex: 0 0 auto;
        font-family: var(--sol-font-body);
        font-variant-numeric: tabular-nums;
        font-size: 11.5px;
        color: var(--sol-text-3);
      }
      .hw-wide {
        grid-column: 1 / -1;
      }
      .hw-seg {
        display: flex;
        background: var(--sol-control, #232426);
        border-radius: 9px;
        padding: 2px;
        gap: 2px;
      }
      .hw-seg button {
        border: none;
        cursor: pointer;
        border-radius: 7px;
        padding: 3px 8px;
        font-size: 10.5px;
        font-weight: 500;
        background: transparent;
        color: var(--sol-text-3);
      }
      .hw-seg button.on {
        background: var(--sol-amber-surface, #2a2418);
        color: var(--sol-amber);
      }
      .hw-time {
        background: var(--sol-control, #242426);
        border: none;
        border-radius: 6px;
        color: var(--sol-text-2);
        font-family: var(--sol-font-body);
        font-size: 11.5px;
        padding: 3px 6px;
      }
    `,
  ];

  /* ---------------------------------------------------------------- writes */

  private async pushRoomBias(room: RoomRow, val: number) {
    this.draftBias = { ...this.draftBias, [room.subentry_id]: val };
    const existing = this._debounceTimers.get(room.subentry_id);
    if (existing) clearTimeout(existing);

    const timer = window.setTimeout(async () => {
      this._debounceTimers.delete(room.subentry_id);
      await setRoom(this.hass, room.subentry_id, { bias_stops: val });
    }, 400);
    this._debounceTimers.set(room.subentry_id, timer);
  }

  private setHvacMode(mode: string) {
    if (!this.hass) return;
    this.hass.callService("climate", "set_hvac_mode", {
      entity_id: THERMOSTAT,
      hvac_mode: mode,
    });
  }

  /**
   * Eco is a **preset**, not an hvac mode.
   *
   * `climate.kitchen_kitchen_thermostat` reports `hvac_modes: ["off", "heat"]` and
   * `preset_modes: ["none", "eco"]`. The old Eco button called `set_hvac_mode("eco")`,
   * which HA rejects — the button looked live and did nothing.
   *
   * Setting the preset is the whole job: measured on the live Nest 2026-08-18, an eco
   * preset applied while `hvac_mode: off` moves the thermostat to `heat` / `idle` by
   * itself. Nudging `hvac_mode` first would be a redundant second call racing the first.
   */
  private setPreset(preset: string) {
    if (!this.hass) return;
    this.hass.callService("climate", "set_preset_mode", {
      entity_id: THERMOSTAT,
      preset_mode: preset,
    });
  }

  private bumpHvacTemp(delta: number) {
    if (!this.hass) return;
    const c = this.hass.states[THERMOSTAT];
    const min = Number(c?.attributes?.min_temp ?? 9);
    const max = Number(c?.attributes?.max_temp ?? 32);
    const step = Number(c?.attributes?.target_temp_step ?? 0.5);
    // `temperature` is null whenever the thermostat is off, so there is no target to
    // nudge; start from the room instead of inventing a number.
    const base = c?.attributes?.temperature ?? c?.attributes?.current_temperature ?? 20;
    const next = Math.min(max, Math.max(min, Math.round((base + delta) / step) * step));
    this.hass.callService("climate", "set_temperature", {
      entity_id: THERMOSTAT,
      temperature: Math.round(next * 10) / 10,
    });
  }

  /* ------------------------------------------------------------------- hot water */

  private setNumber(entityId: string, value: number) {
    this.hass?.callService("input_number", "set_value", { entity_id: entityId, value });
  }

  private toggleBool(entityId: string) {
    this.hass?.callService("input_boolean", "toggle", { entity_id: entityId });
  }

  private setDateTime(entityId: string, time: string) {
    this.hass?.callService("input_datetime", "set_datetime", { entity_id: entityId, time });
  }

  private setHeatLink(mode: string) {
    if (!this.hass) return;
    if (mode === "heat_now" || mode === "boost_2h") {
      this.hass.callService("script", "hw_heat_now");
      return;
    }
    if (mode === "off") {
      this.hass.callService("water_heater", "set_operation_mode", {
        entity_id: HEAT_LINK,
        operation_mode: "off",
      });
      if (this.hass.states["input_boolean.hw_cycle_running"]?.state === "on") {
        this.hass.callService("input_boolean", "turn_off", {
          entity_id: "input_boolean.hw_cycle_running",
        });
      }
      return;
    }
    this.hass.callService("water_heater", "set_operation_mode", {
      entity_id: HEAT_LINK,
      operation_mode: mode,
    });
  }

  private toggleSleep() {
    if (!this.hass) return;
    this.hass.callService("input_boolean", "toggle", {
      entity_id: "input_boolean.solace_sleep",
    });
  }

  private toggleWorkMode() {
    if (!this.hass) return;
    this.hass.callService("input_boolean", "toggle", {
      entity_id: "input_boolean.work_mode",
    });
  }

  /* ---------------------------------------------------------------- sparklines */

  private spark(entityId: string, opts: SparkOptions = {}): Spark | null {
    const samples = this.history.get(entityId);
    if (!samples || samples.length < 2) return null;
    return buildSpark(samples, {
      height: BAND_H,
      anchorMean: SPARK_ANCHOR,
      from: this.windowEnd - 24 * 3_600_000,
      to: this.windowEnd,
      ...opts,
    });
  }

  /**
   * The band itself. `id` only has to be unique inside this shadow root — it names the
   * fill gradient, and two cards sharing one would silently take each other's colour.
   */
  private renderBand(id: string, spark: Spark | null, colour: string, hidden = false) {
    // A band is pinned to the card floor, so an open disclosure drawer would have the
    // curve running straight through its rows. The drawer wins while it is open.
    if (hidden) return nothing;
    if (!spark) {
      return html`<div class="band-empty">no recorder history yet</div>`;
    }
    return html`
      <svg
        class="band"
        viewBox="0 0 ${spark.width} ${spark.height}"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        ${svg`
          <defs>
            <linearGradient id=${`fill-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color=${colour} stop-opacity="0.22"></stop>
              <stop offset="55%" stop-color=${colour} stop-opacity="0.07"></stop>
              <stop offset="100%" stop-color=${colour} stop-opacity="0"></stop>
            </linearGradient>
          </defs>
          <path d=${spark.area} fill=${`url(#fill-${id})`} stroke="none"></path>
          <path
            d=${spark.line}
            fill="none"
            stroke=${colour}
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            opacity="0.75"
            vector-effect="non-scaling-stroke"
          ></path>
          <circle
            class="band-dot"
            cx=${spark.dotX}
            cy=${spark.dotY}
            r="2.2"
            fill=${colour}
            stroke="var(--sol-card)"
            stroke-width="1.5"
          ></circle>
        `}
      </svg>
    `;
  }

  /** High/low straight off the samples, so the caption cannot disagree with the curve. */
  private renderHighLow(spark: Spark | null, unit: string, digits = 1) {
    if (!spark) return nothing;
    return html`
      <div class="high-low">
        <span
          ><span class="hl-k">High</span><b>${spark.max.toFixed(digits)}${unit}</b
          ><span class="hl-t">${clockAt(spark.maxAt)}</span></span
        >
        <span
          ><span class="hl-k">Low</span><b>${spark.min.toFixed(digits)}${unit}</b
          ><span class="hl-t">${clockAt(spark.minAt)}</span></span
        >
      </div>
    `;
  }

  /* ---------------------------------------------------------------- render */

  private renderLightCard() {
    const w = this.snap.world;
    const masterTarget =
      w.master_target_brightness ??
      (w.demand !== null && w.demand !== undefined ? Math.round(w.demand * 254) : 254);
    const targetPct = Math.round((masterTarget / 254) * 100);
    const luxVal = Math.round(w.lux ?? 0);
    const elevVal = w.elevation !== null && w.elevation !== undefined ? w.elevation.toFixed(1) : "—";
    const gateOpen = this.hass.states["binary_sensor.entry_ambient_gate"]?.state === "on";
    const sleepActive =
      this.hass.states["input_boolean.solace_sleep"]?.state === "on" || w.night_active;
    const workActive =
      this.hass.states["input_boolean.work_mode"]?.state === "on" || !!w.work_mode;

    // Outdoor lux spans four decades between a dark night and midday, so a linear axis
    // renders the whole night as a flat line against one spike. Log keeps the shape.
    const spark = this.spark(LUX, { scale: "log" });

    return html`
      <div class="card-wrap">
        <div class="c-head">
          <ha-icon icon="mdi:lightbulb" style="color: var(--sol-amber);"></ha-icon>
          <span class="c-title">Light</span>
          <span class="grow"></span>
          <span class="c-status">${gateOpen ? "ambient gate open" : "ambient gate closed"}</span>
          <button
            class="btn-pill"
            style="background: ${this.biasOpen ? "var(--sol-cyan-tint)" : "var(--sol-control)"}; color: ${this.biasOpen ? "var(--sol-cyan)" : "var(--sol-text-3)"};"
            @click=${() => (this.biasOpen = !this.biasOpen)}
          >
            <ha-icon icon="mdi:tune"></ha-icon>
            Bias
            <ha-icon icon=${this.biasOpen ? "mdi:chevron-up" : "mdi:chevron-down"}></ha-icon>
          </button>
          <div class="head-btn-stack">
            <button
              class="btn-pill"
              style="background: ${workActive ? "rgba(33,150,243,.25)" : "var(--sol-control)"}; color: ${workActive ? "#64b5f6" : "var(--sol-text-3)"};"
              @click=${() => this.toggleWorkMode()}
            >
              <ha-icon icon="mdi:desk-lamp"></ha-icon>
              ${workActive ? "Work ON" : "Work"}
            </button>
            <button
              class="btn-pill"
              style="background: ${sleepActive ? "rgba(149,117,205,.2)" : "var(--sol-control)"}; color: ${sleepActive ? "#b39ddb" : "var(--sol-text-3)"};"
              @click=${() => this.toggleSleep()}
            >
              <ha-icon icon="mdi:weather-night"></ha-icon>
              ${sleepActive ? "Sleep ON" : "Sleep"}
            </button>
          </div>
        </div>

        <div class="c-body">
          <div class="c-main">
            <div class="big-val mono-gold">
              ${targetPct}<span class="unit" style="font-size: 15px; margin-left: 3px;">%</span>
            </div>
          </div>
          <div class="small-grid c-side">
            <span class="sg-k">Lux</span>
            <span class="sg-v" style="color: var(--sol-amber);">${num(luxVal)}</span>
            <span class="sg-k">Sun</span>
            <span class="sg-v">${elevVal}°</span>
            <span class="sg-k">Peak</span>
            <span class="sg-v">
              ${spark ? `${num(Math.round(spark.max))} lx · ${clockAt(spark.maxAt)}` : "—"}
            </span>
          </div>
        </div>

        ${this.biasOpen
          ? html`
              <div class="bias-drawer">
                ${this.snap.rooms.map((r) => {
                  const val =
                    this.draftBias[r.subentry_id] ?? Number(r.settings.bias_stops ?? 0);
                  const isMoved = val !== 0;
                  return html`
                    <div class="room-bias-row">
                      <span class="rb-name" title=${r.name}>${r.name}</span>
                      <sol-slider
                        small
                        .value=${val}
                        .min=${-2}
                        .max=${2}
                        .step=${0.25}
                        @value-changed=${(e: CustomEvent) =>
                          this.pushRoomBias(r, e.detail.value)}
                      ></sol-slider>
                      <span class="rb-val ${isMoved ? "active" : ""}">
                        ${stopLabel(val).replace(" stops", "").replace(" stop", "")}
                      </span>
                    </div>
                  `;
                })}
              </div>
            `
          : nothing}

        ${this.renderBand("lux", spark, "var(--sol-amber)", this.biasOpen)}
      </div>
    `;
  }

  private renderWeatherCard() {
    const weather = this.hass.states[WEATHER];
    const condition = weather?.state ?? "cloudy";
    const attrs = weather?.attributes ?? {};

    // met.no publishes no radar imagery and HA exposes no radar entity here, so the
    // card shows what the integration actually has: 12h of precipitation and a 6-day
    // strip. See the PR for why a third-party tile server was not the answer.
    const hours = this.hourly.slice(0, 12);
    const maxRain = Math.max(0.6, ...hours.map((h) => h.precipitation ?? 0));
    const rainSoon = hours.slice(0, 6).some((h) => (h.precipitation ?? 0) > 0.1);

    const hourLabel = (iso: string) =>
      new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", hour12: false });
    const dayLabel = (iso: string, i: number) =>
      i === 0 ? "Today" : new Date(iso).toLocaleDateString(undefined, { weekday: "short" });

    return html`
      <div class="card-wrap">
        <div class="c-head">
          <ha-icon icon="mdi:cloud-outline" style="color: var(--sol-cyan);"></ha-icon>
          <span class="c-title">Forecast</span>
          <span class="grow"></span>
          <span class="c-status">${rainSoon ? "rain within 6h" : "no rain in 6h"}</span>
        </div>

        <div class="fc">
          <div class="fc-now">
            <ha-icon icon=${weatherIcon(condition)}></ha-icon>
            <div>
              <div class="fc-temp">
                ${attrs.temperature ?? "—"}<span class="unit" style="font-size: 16px;">°</span>
              </div>
              <div class="fc-cond">${condition.replace(/[-_]/g, " ")}</div>
            </div>
            <div class="small-grid c-side">
              <span class="sg-k">Wind</span>
              <span class="sg-v">${Math.round(attrs.wind_speed ?? 0)} km/h</span>
              <span class="sg-k">Pressure</span>
              <span class="sg-v">${attrs.pressure ?? "—"} hPa</span>
              <span class="sg-k">UV</span>
              <span class="sg-v">${attrs.uv_index ?? "—"}</span>
            </div>
          </div>

          ${hours.length
            ? html`
                <div class="fc-hours">
                  ${hours.map((h) => {
                    const mm = h.precipitation ?? 0;
                    return html`
                      <div class="fc-hour" title="${hourLabel(h.datetime)} · ${mm} mm">
                        <div
                          class="fc-bar ${mm > 0.05 ? "" : "dry"}"
                          style="height: ${mm > 0.05 ? Math.max(6, Math.round((mm / maxRain) * 30)) : 3}px;"
                        ></div>
                        <span class="fc-hlabel">${hourLabel(h.datetime)}</span>
                      </div>
                    `;
                  })}
                </div>
              `
            : nothing}

          ${this.daily.length
            ? html`
                <div class="fc-days">
                  ${this.daily.slice(0, 6).map(
                    (d, i) => html`
                      <div class="fc-day">
                        <span class="fc-dname">${dayLabel(d.datetime, i)}</span>
                        <ha-icon icon=${weatherIcon(d.condition)}></ha-icon>
                        <span class="fc-dtemp">
                          ${Math.round(d.temperature ?? 0)}°<span
                            >/${Math.round(d.templow ?? 0)}°</span
                          >
                        </span>
                      </div>
                    `
                  )}
                </div>
              `
            : html`<div class="fc-sub">forecast unavailable</div>`}
        </div>
      </div>
    `;
  }

  private renderInsideCard() {
    const tempState = this.hass.states[INSIDE_TEMP];
    const climate = this.hass.states[THERMOSTAT];
    const currentTemp = parseFloat(tempState?.state ?? "");
    const hvacMode = climate?.state ?? "off";
    const preset = climate?.attributes?.preset_mode ?? "none";
    const action = climate?.attributes?.hvac_action ?? hvacMode;
    // Null whenever the thermostat is off — showing a fabricated 20.5 was worse than
    // showing that there is no setpoint.
    const target = climate?.attributes?.temperature ?? null;
    const humidity = climate?.attributes?.current_humidity;

    const spark = this.spark(INSIDE_TEMP, { minSpan: 1.5 });

    return html`
      <div class="card-wrap">
        <div class="c-head">
          <ha-icon icon="mdi:home-thermometer" style="color: #ef5350;"></ha-icon>
          <span class="c-title">Inside</span>
          <span class="grow"></span>
          <span class="c-status">${action === "heating" ? "heating" : "idle"}</span>
        </div>

        <div class="c-body">
          <div class="c-main">
            <div class="big-val">
              ${isNaN(currentTemp) ? "—" : currentTemp.toFixed(1)}<span class="unit">°</span>
            </div>
          </div>

          <div class="c-side" style="display: flex; flex-direction: column; align-items: flex-end; gap: 8px;">
            <div class="hvac-modes">
              <button
                class="hvac-btn ${hvacMode === "off" ? "active" : ""}"
                @click=${() => this.setHvacMode("off")}
              >
                Off
              </button>
              <button
                class="hvac-btn ${hvacMode === "heat" && preset !== "eco" ? "active-heat" : ""}"
                @click=${() => {
                  this.setHvacMode("heat");
                  if (preset === "eco") this.setPreset("none");
                }}
              >
                Heat
              </button>
              <button
                class="hvac-btn ${preset === "eco" ? "active-eco" : ""}"
                @click=${() => this.setPreset("eco")}
              >
                Eco
              </button>
            </div>

            <div class="setpoint">
              <button class="step-btn" @click=${() => this.bumpHvacTemp(-0.5)}>−</button>
              <div class="setpoint-val">
                <span class="stat-label">${hvacMode === "off" ? "No setpoint" : "Target"}</span>
                <span
                  style="color: ${hvacMode === "off"
                    ? "var(--sol-text-4)"
                    : preset === "eco"
                      ? "#81c784"
                      : "#ef5350"};"
                >
                  ${target === null ? "—" : `${target.toFixed(1)}°`}
                </span>
              </div>
              <button class="step-btn" @click=${() => this.bumpHvacTemp(0.5)}>+</button>
            </div>

            <div class="small-grid">
              <span class="sg-k">Humidity</span>
              <span class="sg-v">${humidity ?? "—"}%</span>
            </div>
          </div>
        </div>

        ${this.renderHighLow(spark, "°")}
        ${this.renderBand("inside", spark, "#ef5350")}
      </div>
    `;
  }

  private renderOutsideCard() {
    const tempState = this.hass.states[OUTSIDE_TEMP];
    const currentTemp = parseFloat(tempState?.state ?? "");
    const weather = this.hass.states[WEATHER];
    const attrs = weather?.attributes ?? {};
    const condition = weather?.state ?? "cloudy";

    const humidityIn = this.hass.states["sensor.kitchen_kitchen_thermostat_humidity"]?.state;
    // Exterior humidity comes off the weather entity — there is no outdoor hygrometer.
    const humidityOut = attrs.humidity;
    const fmtPct = (v: unknown) => (v === undefined || v === null ? "—" : Number(v).toFixed(1));

    const spark = this.spark(OUTSIDE_TEMP, { minSpan: 2 });

    return html`
      <div class="card-wrap">
        <div class="c-head">
          <ha-icon icon="mdi:tree" style="color: var(--sol-cyan);"></ha-icon>
          <span class="c-title">Outside</span>
          <span class="grow"></span>
          <span class="c-status">${condition.replace(/[-_]/g, " ")}</span>
          <ha-icon
            icon=${weatherIcon(condition)}
            title=${condition}
            style="--mdc-icon-size: 22px; color: var(--sol-cyan);"
          ></ha-icon>
        </div>

        <div class="c-body">
          <div class="c-main">
            <div class="big-val">
              ${isNaN(currentTemp) ? "—" : currentTemp.toFixed(1)}<span class="unit">°</span>
            </div>
          </div>
          <div class="small-grid c-side">
            <span class="sg-k">Pressure</span>
            <span class="sg-v">${attrs.pressure ?? "—"} hPa</span>
            <span class="sg-k">Wind</span>
            <span class="sg-v">
              ${Math.round(attrs.wind_bearing ?? 0)}° · ${Math.round(attrs.wind_speed ?? 0)} km/h
            </span>
            <span class="sg-k">Cloud cover</span>
            <span class="sg-v">${Math.round(attrs.cloud_coverage ?? 0)}%</span>
            <span class="sg-k">Humidity in/out</span>
            <span class="sg-v">${fmtPct(humidityIn)}/${fmtPct(humidityOut)}%</span>
          </div>
        </div>

        ${this.renderHighLow(spark, "°")}
        ${this.renderBand("outside", spark, "var(--sol-cyan)")}
      </div>
    `;
  }

  /**
   * Observed recovery rate, °C per minute, from the steepest sustained rise in the last
   * 24h of tank temperature.
   *
   * Derived from the tank curve rather than from `input_boolean.hw_cycle_running`,
   * because that helper misses cycles: on 2026-08-17 the heat link ran `boost_2h` for
   * 35 minutes and the boolean never flipped. A rate divided by a run time that did not
   * get recorded is worse than no rate at all.
   */
  private recoveryRate(): number | null {
    const samples = this.history.get(HOT_WATER_TEMP);
    if (!samples || samples.length < 3) return null;

    let best: { gain: number; minutes: number } | null = null;
    let runStart = 0;
    for (let i = 1; i < samples.length; i++) {
      // A drop of more than a tenth ends the run; smaller wobbles are sensor noise.
      if (samples[i].v < samples[i - 1].v - 0.1) {
        runStart = i;
        continue;
      }
      const gain = samples[i].v - samples[runStart].v;
      const minutes = (samples[i].t - samples[runStart].t) / 60_000;
      if (gain >= 3 && minutes >= 5 && (!best || gain / minutes > best.gain / best.minutes)) {
        best = { gain, minutes };
      }
    }
    return best ? best.gain / best.minutes : null;
  }

  private renderHotWaterCard() {
    const hwTempState = this.hass.states[HOT_WATER_TEMP];
    const currentTemp = parseFloat(hwTempState?.state ?? "");
    const running = this.hass.states["input_boolean.hw_cycle_running"]?.state === "on";
    const nextStart = this.hass.states["sensor.hot_water_next_start"]?.state ?? "—";
    const winter = this.hass.states["input_boolean.hw_winter_mode"]?.state === "on";
    const enabled = this.hass.states["input_boolean.hw_enabled"]?.state === "on";
    const heatLink = this.hass.states[HEAT_LINK];
    const heatLinkMode = heatLink?.state ?? "off";
    const boosting = heatLinkMode.startsWith("boost");

    const num_ = (id: string, fallback: number) =>
      parseFloat(this.hass.states[id]?.state ?? String(fallback));

    const targetSummer = num_("input_number.hw_target_summer", 47);
    const targetWinter = num_("input_number.hw_target_winter", 53);
    const target = winter ? targetWinter : targetSummer;
    const learnedRate = num_("input_number.hw_heat_rate", 0.53);
    const observed = this.recoveryRate();

    const spark = this.spark(HOT_WATER_TEMP, { minSpan: 4 });

    return html`
      <div class="card-wrap">
        <div class="c-head">
          <ha-icon icon="mdi:water-boiler" style="color: var(--sol-amber);"></ha-icon>
          <span class="c-title">Hot Water</span>
          <span class="grow"></span>
          <span class="c-status">
            ${running ? `heating to ${target.toFixed(0)}°` : boosting ? heatLinkMode.replace("boost_", "boost ") : `next ${nextStart}`}
          </span>
          <button
            class="btn-pill"
            style="background: ${this.hwOpen ? "var(--sol-cyan-tint)" : "var(--sol-control)"}; color: ${this.hwOpen ? "var(--sol-cyan)" : "var(--sol-text-3)"};"
            @click=${() => (this.hwOpen = !this.hwOpen)}
          >
            <ha-icon icon="mdi:tune"></ha-icon>
            Controls
            <ha-icon icon=${this.hwOpen ? "mdi:chevron-up" : "mdi:chevron-down"}></ha-icon>
          </button>
        </div>

        <div class="c-body">
          <div class="c-main">
            <div class="big-val">
              ${isNaN(currentTemp) ? "—" : currentTemp.toFixed(1)}<span class="unit">°</span>
            </div>
          </div>
          <div class="small-grid c-side">
            <span class="sg-k">Target</span>
            <span class="sg-v" style="color: var(--sol-amber);">
              ${target.toFixed(1)}° ${winter ? "winter" : "summer"}
            </span>
          </div>
        </div>

        ${this.hwOpen
          ? html`
              <div class="hw-drawer">
                <div class="hw-row hw-wide">
                  <span class="hw-k">Heat link</span>
                  <div class="hw-seg">
                    ${["off", "schedule", "boost_30m", "boost_1h", "heat_now"].map(
                      (m: string) => {
                        const isHeatNow = m === "heat_now";
                        const isOn = isHeatNow ? running : !running && heatLinkMode === m;
                        const label = isHeatNow ? "heat now" : m.replace("boost_", "");
                        return html`
                          <button
                            class=${isOn ? "on" : ""}
                            @click=${() => this.setHeatLink(m)}
                          >
                            ${label}
                          </button>
                        `;
                      }
                    )}
                  </div>
                </div>

                <div class="hw-row">
                  <span class="hw-k">Ready by</span>
                  <input
                    class="hw-time"
                    type="time"
                    .value=${(this.hass.states["input_datetime.hw_shower_time"]?.state ?? "08:30:00").slice(0, 5)}
                    @change=${(e: Event) =>
                      this.setDateTime(
                        "input_datetime.hw_shower_time",
                        `${(e.target as HTMLInputElement).value}:00`
                      )}
                  />
                </div>

                ${this.renderHwToggle("Automation", "input_boolean.hw_enabled", enabled)}
                ${this.renderHwToggle("Winter mode", "input_boolean.hw_winter_mode", winter)}

                <div class="hw-row">
                  <span class="hw-k">Cycle running</span>
                  <span class="hw-v">${running ? "yes" : "no"}</span>
                </div>

                ${this.renderHwNumber("Summer target", "input_number.hw_target_summer", targetSummer, "°C")}
                ${this.renderHwNumber("Winter target", "input_number.hw_target_winter", targetWinter, "°C")}
                ${this.renderHwNumber("Weekly purge", "input_number.hw_purge_temp", num_("input_number.hw_purge_temp", 60), "°C")}
                ${this.renderHwNumber("Ready margin", "input_number.hw_ready_margin", num_("input_number.hw_ready_margin", 10), "min")}
                ${this.renderHwNumber("Max runtime", "input_number.hw_max_runtime", num_("input_number.hw_max_runtime", 90), "min")}
                ${this.renderHwNumber("Learned heat rate", "input_number.hw_heat_rate", learnedRate, "°C/min")}
              </div>
            `
          : nothing}

        ${this.hwOpen ? nothing : this.renderHighLow(spark, "°")}
        ${this.renderBand("hotwater", spark, "var(--sol-amber)", this.hwOpen)}
      </div>
    `;
  }

  private renderHwNumber(label: string, entityId: string, value: number, unit: string) {
    const attrs = this.hass.states[entityId]?.attributes ?? {};
    return html`
      <div class="hw-row">
        <span class="hw-k">${label}</span>
        <sol-number
          .value=${value}
          .min=${attrs.min ?? null}
          .max=${attrs.max ?? null}
          .step=${attrs.step ?? 0.1}
          .suffix=${unit}
          .width=${58}
          @value-changed=${(e: CustomEvent) => {
            const v = Number(e.detail.value);
            if (Number.isFinite(v)) this.setNumber(entityId, v);
          }}
        ></sol-number>
      </div>
    `;
  }

  /** On/Off as a segmented control — the panel has no switch primitive of its own. */
  private renderHwToggle(label: string, entityId: string, on: boolean) {
    return html`
      <div class="hw-row">
        <span class="hw-k">${label}</span>
        <sol-segmented
          .options=${[
            { value: "off", label: "Off" },
            { value: "on", label: "On" },
          ]}
          .value=${on ? "on" : "off"}
          @value-changed=${(e: CustomEvent) => {
            if ((e.detail.value === "on") !== on) this.toggleBool(entityId);
          }}
        ></sol-segmented>
      </div>
    `;
  }

  private renderFridgeCard() {
    const fridgeTempState = this.hass.states[FRIDGE_TEMP];
    const currentTemp = parseFloat(fridgeTempState?.state ?? "");

    const tooCold = !isNaN(currentTemp) && currentTemp <= FRIDGE_COLD;
    const tooWarm = !isNaN(currentTemp) && currentTemp >= FRIDGE_WARM;
    const alertClass = tooCold ? "alert-cold" : tooWarm ? "alert-warm" : "";
    // The curve tracks the value's own state so an excursion is visible in the history,
    // not only in the current reading.
    const colour = tooCold ? "var(--sol-amber)" : tooWarm ? "#ef5350" : "#81d4fa";

    const spark = this.spark(FRIDGE_TEMP, { minSpan: 2 });

    return html`
      <div class="card-wrap">
        <div class="c-head">
          <ha-icon icon="mdi:fridge" style="color: ${colour};"></ha-icon>
          <span class="c-title">Refrigerator</span>
          <span class="grow"></span>
          ${tooCold || tooWarm
            ? html`
                <span class="alert-tag ${alertClass}">
                  <ha-icon
                    icon=${tooCold ? "mdi:snowflake-alert" : "mdi:thermometer-alert"}
                    style="--mdc-icon-size: 15px;"
                  ></ha-icon>
                  ${tooCold ? "too cold" : "too warm"}
                </span>
              `
            : html`<span class="c-status">in range</span>`}
        </div>

        <div class="c-body">
          <div class="c-main">
            <div class="big-val ${alertClass}">
              ${isNaN(currentTemp) ? "—" : currentTemp.toFixed(1)}<span class="unit">°</span>
            </div>
          </div>
          <div class="small-grid c-side">
            <span class="sg-k">Safe band</span>
            <span class="sg-v">${FRIDGE_COLD}–${FRIDGE_WARM}°</span>
            <span class="sg-k">Battery</span>
            <span class="sg-v">
              ${this.hass.states["sensor.refrigerator_temperature_battery"]?.state ?? "—"}%
            </span>
          </div>
        </div>

        ${this.renderHighLow(spark, "°")}
        ${this.renderBand("fridge", spark, colour)}
      </div>
    `;
  }

  private renderRunningNow() {
    const isWasherRunning =
      this.hass.states["input_boolean.washing_machine_running"]?.state === "on";
    const washerProgram = this.hass.states["sensor.washing_machine_program"]?.state ?? "Cotton 40°";
    const washerPhase = this.hass.states["sensor.washing_machine_current_phase"]?.state ?? "Idle";
    const washerProgress = parseFloat(
      this.hass.states["sensor.washing_machine_progress"]?.state ?? "0"
    );
    const washerRemaining =
      this.hass.states["sensor.washing_machine_time_remaining"]?.state ?? "—";
    const washerPower = parseFloat(
      this.hass.states["sensor.entry_washing_machine_plug_power"]?.state ??
        this.hass.states["sensor.washing_machine_current_power"]?.state ??
        "0"
    );

    const chargerPower = parseFloat(
      this.hass.states["sensor.bedroom_smart_plug_power_consumption"]?.state ?? "0"
    );
    // `charge_active_threshold` is the *per-cycle* cut-off the charge script writes; it
    // sits at 0 between cycles, so `power >= threshold` read as "charging" forever at
    // 0.00 W. `charge_off_wattage` (1.1 W) is the standing default the script falls back
    // to, and the comparison has to be strictly greater or 0 W still counts as charging.
    const cycleCutoff = parseFloat(
      this.hass.states["input_number.charge_active_threshold"]?.state ?? "0"
    );
    const defaultCutoff = parseFloat(
      this.hass.states["input_number.charge_off_wattage"]?.state ?? "1.1"
    );
    const chargeCutoff = cycleCutoff > 0 ? cycleCutoff : defaultCutoff;
    const isCharging = chargerPower > chargeCutoff;

    const idle = !isWasherRunning && !isCharging;

    return html`
      <div class="sec-head">
        <ha-icon icon="mdi:lightning-bolt"></ha-icon>
        <div class="sec-title">Running now</div>
        <div class="sec-line"></div>
        ${idle ? html`<div class="sec-sub">nothing running</div>` : nothing}
      </div>

      ${idle
        ? html`
            <div class="idle-strip">
              <span class="idle-item">
                <ha-icon icon="mdi:washing-machine"></ha-icon>
                Washing machine
                <b>idle</b>
              </span>
              <span class="idle-sep"></span>
              <span class="idle-item">
                <ha-icon icon="mdi:watch"></ha-icon>
                Device charging
                <b>${chargerPower.toFixed(2)} W</b>
              </span>
            </div>
          `
        : this.renderRunningCards(
            isWasherRunning,
            washerProgram,
            washerPhase,
            washerProgress,
            washerRemaining,
            washerPower,
            isCharging,
            chargerPower,
            chargeCutoff
          )}
    `;
  }

  /** Only reached when at least one appliance is actually doing something. */
  private renderRunningCards(
    isWasherRunning: boolean,
    washerProgram: string,
    washerPhase: string,
    washerProgress: number,
    washerRemaining: string,
    washerPower: number,
    isCharging: boolean,
    chargerPower: number,
    chargeCutoff: number
  ) {
    // Whichever appliance is off collapses to a chip, so the running one gets the room.
    const washer = isWasherRunning
      ? html`
          <div class="card-wrap" style="padding-bottom: 26px;">
            <div class="bar-track">
              <div
                class="bar-fill"
                style="width: ${Math.min(100, Math.max(5, washerProgress))}%;"
              ></div>
            </div>
            <div class="c-head">
              <ha-icon icon="mdi:washing-machine" style="color: var(--sol-cyan);"></ha-icon>
              <span class="c-title">Washing Machine</span>
              <span class="grow"></span>
              <span class="c-status">${washerProgram}</span>
            </div>

            <div class="c-body">
              <div class="c-main">
                <div class="run-phase">${washerPhase}</div>
                <div class="high-low" style="margin-top: 8px; padding-top: 0;">
                  ${Math.round(washerProgress)}% through · remaining ${washerRemaining}
                </div>
              </div>
              <div class="small-grid c-side">
                <span class="sg-k">Remaining</span>
                <span class="sg-v" style="color: var(--sol-cyan);">${washerRemaining}</span>
                <span class="sg-k">Draw</span>
                <span class="sg-v">${Math.round(washerPower)} W</span>
              </div>
            </div>
          </div>
        `
      : html`
          <div class="idle-strip">
            <span class="idle-item">
              <ha-icon icon="mdi:washing-machine"></ha-icon>
              Washing machine
              <b>idle</b>
            </span>
          </div>
        `;

    // The bar reads 0 → 2.5× the cut-off, with the cut-off marked, so the needle shows
    // how close the cycle is to finishing rather than being an arbitrary percentage.
    const barFull = Math.max(chargeCutoff, 0.1) * 2.5;
    const charging = isCharging
      ? html`
          <div class="card-wrap" style="padding-bottom: 26px;">
            <div class="bar-track">
              <div
                class="bar-fill"
                style="width: ${Math.min(100, Math.max(10, (chargerPower / barFull) * 100))}%; background: var(--sol-green);"
              ></div>
              <div
                class="bar-needle"
                style="left: ${Math.min(95, (chargeCutoff / barFull) * 100)}%;"
              ></div>
            </div>
            <div class="c-head">
              <ha-icon icon="mdi:watch" style="color: var(--sol-green);"></ha-icon>
              <span class="c-title">Device Charging</span>
              <span class="grow"></span>
              <span class="run-badge">
                <span class="run-dot"></span>
                Charging
              </span>
            </div>

            <div class="c-body">
              <div class="c-main">
                <div class="big-val" style="color: var(--sol-green);">
                  ${chargerPower.toFixed(2)}<span class="unit">W</span>
                </div>
                <div class="high-low" style="margin-top: 8px; padding-top: 0;">
                  Active charging cycle
                </div>
              </div>
              <div class="small-grid c-side">
                <span class="sg-k">Cut-off</span>
                <span class="sg-v" style="color: #ef5350;">${chargeCutoff.toFixed(2)} W</span>
                <span class="sg-k">Profile</span>
                <span class="sg-v">
                  ${this.hass.states["input_text.charge_active_profile"]?.state || "—"}
                </span>
              </div>
            </div>
          </div>
        `
      : html`
          <div class="idle-strip">
            <span class="idle-item">
              <ha-icon icon="mdi:watch"></ha-icon>
              Device charging
              <b>${chargerPower.toFixed(2)} W</b>
            </span>
          </div>
        `;

    return html`<div class="g2 g2-run">${washer}${charging}</div>`;
  }


  render() {
    // The parent gates on the snapshot before mounting this tab, but the coordinator can
    // drop one on reload and every card below dereferences `snap.world`.
    if (!this.snap || !this.hass) return nothing;

    return html`
      <div class="sec-head">
        <ha-icon icon="mdi:leaf"></ha-icon>
        <div class="sec-title">Environment</div>
        <div class="sec-line"></div>
        <div class="sec-sub">last 24 hours</div>
      </div>

      <div class="g2">
        ${this.renderLightCard()}
        ${this.renderWeatherCard()}
      </div>

      <div class="g2">
        ${this.renderInsideCard()}
        ${this.renderOutsideCard()}
      </div>

      <div class="g2">
        ${this.renderHotWaterCard()}
        ${this.renderFridgeCard()}
      </div>

      ${this.renderRunningNow()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-tab-home": SolTabHome;
  }
}
