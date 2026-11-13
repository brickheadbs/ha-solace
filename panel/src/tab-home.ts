/**
 * Home — Master home overview tab for Solace.
 *
 * Cards (drag-and-drop reorderable via `card_order.home`):
 *   - Front Door & Quick Actions (Aqara U200 lock, Leaving in 5m, Start Watch Charge)
 *   - Light (read-only Master Target %, circadian K, room chips, mode pills, EV room bias drawer)
 *   - Inside (indoor average temperature, room sensors, 24h sparkline — retired Nest HVAC removed)
 *   - Outside (calibrated exterior temperature, solar clamp indicator, lux/elevation)
 *   - Forecast (12h precipitation + 6-day Met Eireann forecast)
 *   - Refrigerator (24h sparkline + 1-5 C safety alarm band, unconditionally visible)
 *   - Running now (Washing machine + Pixel Watch smart plug power cycle)
 */

import { LitElement, css, html, nothing, svg } from "lit";
import { property, state } from "lit/decorators.js";
import { customElement } from "./custom-element";
import type { Hass, RoomRow, Snapshot } from "./api";
import { setCardOrder, setRoom, toggleGate } from "./api";
import { kelvinToDerim } from "./derim";
import { num, stopLabel } from "./fmt";
import { fetchHistory, type Sample } from "./history";
import { applyOrder, moveItem, nudgeItem, reorderStyles } from "./reorder";
import { buildSpark, clockAt, type Spark, type SparkOptions } from "./sparkline";
import { tokens } from "./tokens";
import "./ui";

const BAND_H = 96;
const SPARK_ANCHOR = 0.66;

const LUX = "sensor.entry_exterior_illuminance";
const INSIDE_TEMP = "sensor.indoor_temperature_average";
const OUTSIDE_TEMP = "sensor.entry_exterior_temperature";
const FRIDGE_TEMP = "sensor.refrigerator_temperature_temperature";
const WEATHER = "weather.forecast_home";

const LOCK_ENTITY = "lock.aqara_smart_lock_u200";
const LOCK_BATTERY = "sensor.aqara_smart_lock_u200_battery";
const LEAVING_BUTTON = "input_button.leaving_soon";
const LEAVING_PENDING = "input_boolean.leaving_pending";

const BATH_TEMP = "sensor.bathroom_temperature";
const OFFICE_TEMP = "sensor.office_temperature";
const BEDROOM_TEMP = "sensor.bedroom_temperature";
const ENTRY_TEMP = "sensor.entrance_temperature";

const ROOM_SENSORS: { name: string; id: string }[] = [
  { name: "Office", id: OFFICE_TEMP },
  { name: "Bedroom", id: BEDROOM_TEMP },
  { name: "Bathroom", id: BATH_TEMP },
  // Sensor moved from the stairway to the unheated ground-floor storage on 2026-11-05.
  { name: "Storage", id: ENTRY_TEMP },
];

const TRACKED = [
  LUX,
  INSIDE_TEMP,
  OUTSIDE_TEMP,
  OFFICE_TEMP,
  BEDROOM_TEMP,
  BATH_TEMP,
  ENTRY_TEMP,
  FRIDGE_TEMP,
];

const FRIDGE_COLD = 1;
const FRIDGE_WARM = 5;

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

interface HomeCardDef {
  id: string;
  label: string;
  fullSpan?: boolean;
  render: () => unknown;
}

const FORECAST_REFRESH_MS = 600_000;
const HISTORY_REFRESH_MS = 120_000;

@customElement("sol-tab-home")
export class SolTabHome extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;
  @property({ type: Boolean }) reorderMode = false;

  @state() private biasOpen = false;
  @state() private draftBias: Record<string, number> = {};
  @state() private history: Map<string, Sample[]> = new Map();
  @state() private windowEnd = Date.now();
  @state() private hourly: ForecastPoint[] = [];
  @state() private daily: ForecastPoint[] = [];
  @state() private dragId: string | null = null;
  @state() private overId: string | null = null;

  private timer?: number;
  private historyTimer?: number;
  private forecastTimer?: number;
  private historyRequested = false;
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
    if (this.hass && !this.historyRequested) {
      this.historyRequested = true;
      this.loadHistory();
      this.loadForecast();
    }
  }

  private async loadHistory() {
    if (!this.hass) return;
    const data = await fetchHistory(this.hass, TRACKED, 24);
    if (!data.size) return;
    this.history = data;
    this.windowEnd = Date.now();
  }

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
    reorderStyles,
    css`
      :host {
        display: block;
      }
      .cards-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
      }
      @media (max-width: 760px) {
        .cards-grid {
          grid-template-columns: 1fr;
        }
      }
      .full-span {
        grid-column: 1 / -1;
      }

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
        box-sizing: border-box;
      }

      .c-head {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 9px;
        min-height: 28px;
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
        line-height: 1;
      }
      .grow {
        flex: 1;
      }
      .c-status {
        font-size: 11.5px;
        color: var(--sol-text-4);
      }

      .head-btns {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        margin-left: auto;
      }
      .btn-pill {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        border: none;
        border-radius: 11px;
        padding: 4px 9px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        transition: filter 0.15s ease;
        line-height: 1.2;
        white-space: nowrap;
        height: 24px;
        box-sizing: border-box;
      }
      .btn-pill:hover {
        filter: brightness(1.2);
      }
      .btn-pill ha-icon {
        --mdc-icon-size: 14px;
      }

      .status-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 7px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 500;
      }
      .status-badge ha-icon {
        --mdc-icon-size: 13px;
      }
      .badge-night {
        background: rgba(156, 39, 176, 0.15);
        color: #ce93d8;
      }
      .badge-away {
        background: rgba(239, 83, 80, 0.15);
        color: #ef5350;
      }
      .badge-sunrise {
        background: rgba(255, 152, 0, 0.15);
        color: #ffb74d;
      }
      .badge-locked {
        background: rgba(129, 199, 132, 0.16);
        color: #81c784;
      }

      .c-body {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: flex-start;
        gap: 18px;
        margin-top: 12px;
      }
      .c-main {
        padding-left: 4px;
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
        font-size: 46px;
        line-height: 0.88;
        letter-spacing: -0.03em;
        font-variant-numeric: tabular-nums;
        color: var(--sol-text);
      }
      .big-val.mono-gold {
        color: var(--sol-amber, #ffb74d);
      }
      .big-val .unit {
        font-size: 20px;
        color: var(--sol-text-4);
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
      .small-grid span {
        text-shadow:
          0 0 4px var(--sol-card),
          0 0 8px var(--sol-card);
      }

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
      .hl-k {
        display: inline-block;
        width: 30px;
        color: var(--sol-faint);
      }
      .hl-t {
        margin-left: 6px;
        color: var(--sol-faint);
      }

      .band {
        position: absolute;
        left: 0;
        bottom: 0;
        width: 100%;
        height: ${BAND_H}px;
        display: block;
        z-index: 0;
        pointer-events: none;
        -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 9%, #000 100%);
        mask-image: linear-gradient(90deg, transparent 0, #000 9%, #000 100%);
      }
      .band-dot {
        vector-effect: non-scaling-stroke;
      }
      .band-empty {
        position: absolute;
        left: 18px;
        bottom: 12px;
        z-index: 0;
        font-size: 10.5px;
        color: var(--sol-faint);
        pointer-events: none;
      }

      /* Bias Drawer */
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
        flex: 0 0 74px;
        font-size: 11.5px;
        color: var(--sol-text-2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .rb-val {
        flex: 0 0 44px;
        text-align: right;
        font-variant-numeric: tabular-nums;
        font-size: 11px;
        color: var(--sol-text-3);
      }
      .rb-val.active {
        color: var(--sol-amber);
      }

      /* Quick Action Buttons on Front Door Card */
      .quick-actions {
        margin-top: auto;
        padding-top: 12px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        z-index: 1;
      }
      .qa-btn {
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: var(--sol-control);
        color: var(--sol-text-2);
        border-radius: 9px;
        padding: 7px 12px;
        font-family: inherit;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .qa-btn:hover {
        background: var(--sol-card-high);
        color: var(--sol-text);
      }
      .qa-btn.lock-cta {
        border-color: rgba(255, 183, 77, 0.45);
        background: rgba(255, 183, 77, 0.16);
        color: #ffb74d;
      }
      .qa-btn.locked-cta {
        border-color: rgba(129, 199, 132, 0.35);
        background: rgba(129, 199, 132, 0.12);
        color: #81c784;
      }
      .qa-btn.active-cyan {
        border-color: rgba(86, 182, 194, 0.45);
        background: rgba(86, 182, 194, 0.16);
        color: var(--sol-cyan);
      }
      .qa-btn ha-icon {
        --mdc-icon-size: 15px;
      }

      /* Running Now */
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
      .idle-strip {
        display: flex;
        align-items: center;
        gap: 14px;
        flex-wrap: wrap;
        background: var(--sol-card, #1a1a1b);
        border-radius: var(--sol-r-card, 14px);
        box-shadow: var(--sol-shadow);
        padding: 12px 18px;
      }
      .idle-item {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        font-size: 12px;
        color: var(--sol-text-4);
      }
      .idle-item ha-icon {
        --mdc-icon-size: 16px;
        color: var(--sol-faint);
      }
      .idle-item b {
        font-variant-numeric: tabular-nums;
        font-weight: 500;
        color: var(--sol-text-3);
      }
      .idle-sep {
        width: 1px;
        height: 16px;
        background: var(--sol-hair);
      }
      .g2-run {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
        align-items: start;
      }
      @media (max-width: 760px) {
        .g2-run {
          grid-template-columns: 1fr;
        }
      }
      .run-phase {
        font-size: 32px;
        font-weight: 200;
        line-height: 0.95;
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
      }

      /* Camera */
      .cam-card {
        margin-bottom: 12px;
        padding: 14px 18px 18px;
      }
      .cam-stream-container {
        margin-top: 12px;
        width: 100%;
        border-radius: var(--sol-r-card, 14px);
        overflow: hidden;
        background: #000;
        aspect-ratio: 16 / 9;
        cursor: pointer;
      }
      .cam-stream-container ha-camera-stream {
        width: 100%;
        height: 100%;
        display: block;
      }

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

      /* Forecast */
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
        --mdc-icon-size: 38px;
        color: var(--sol-cyan);
      }
      .fc-temp {
        font-weight: 300;
        font-size: 36px;
        line-height: 0.9;
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
        height: 40px;
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
    `,
  ];

  private async pushRoomBias(room: RoomRow, val: number) {
    this.draftBias = { ...this.draftBias, [room.subentry_id]: val };
    const existing = this._debounceTimers.get(room.subentry_id);
    if (existing) clearTimeout(existing);

    const timer = window.setTimeout(async () => {
      this._debounceTimers.delete(room.subentry_id);
      await setRoom(this.hass, room.subentry_id, { bias_stops: val });
    }, 350);
    this._debounceTimers.set(room.subentry_id, timer);
  }

  private toggleSleep() {
    this.hass?.callService("input_boolean", "toggle", {
      entity_id: "input_boolean.solace_sleep",
    });
  }

  private toggleWorkMode() {
    this.hass?.callService("input_boolean", "toggle", {
      entity_id: "input_boolean.work_mode",
    });
  }

  private async toggleGate() {
    if (!this.hass) return;
    try {
      if (this.hass.callWS) {
        await this.hass.callWS({ type: "solace/toggle_gate" });
      } else {
        await toggleGate(this.hass);
      }
    } catch {
      await this.hass.callService("input_boolean", "toggle", {
        entity_id: "input_boolean.ambient_gate",
      });
    }
  }

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

  private renderBand(id: string, spark: Spark | null, colour: string, hidden = false) {
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

  private renderHighLow(spark: Spark | null, unit: string, digits = 1) {
    if (!spark) return nothing;
    return html`
      <div class="high-low">
        <span>
          <span class="hl-k">High</span><b>${spark.max.toFixed(digits)}${unit}</b>
          <span class="hl-t">${clockAt(spark.maxAt)}</span>
        </span>
        <span>
          <span class="hl-k">Low</span><b>${spark.min.toFixed(digits)}${unit}</b>
          <span class="hl-t">${clockAt(spark.minAt)}</span>
        </span>
      </div>
    `;
  }

  private renderModeBadge() {
    const w = this.snap.world;
    if (w.away) {
      return html`<span class="status-badge badge-away"><ha-icon icon="mdi:airplane"></ha-icon> Away</span>`;
    }
    if (w.sunrise_progress !== null && w.sunrise_progress !== undefined) {
      return html`<span class="status-badge badge-sunrise"><ha-icon icon="mdi:weather-sunset-up"></ha-icon> Sunrise ${Math.round(w.sunrise_progress * 100)}%</span>`;
    }
    if (w.night_active) {
      return html`<span class="status-badge badge-night"><ha-icon icon="mdi:weather-night"></ha-icon> Night</span>`;
    }
    if (w.bedtime_dwell_active) {
      return html`<span class="status-badge badge-night"><ha-icon icon="mdi:bed"></ha-icon> Bedtime</span>`;
    }
    return nothing;
  }

  /* 1. Front Door & Quick Actions Card */
  private renderDoorCard() {
    const lockObj = this.hass.states[LOCK_ENTITY];
    const lockState = lockObj?.state ?? "unavailable";
    const isLocked = lockState === "locked";
    const isJammed = lockState === "jammed";
    const batt = this.hass.states[LOCK_BATTERY]?.state;
    const leavingPending = this.hass.states[LEAVING_PENDING]?.state === "on";
    const awayActive = !!this.snap.world.away;
    const chargerWatts = parseFloat(
      this.hass.states["sensor.bedroom_smart_plug_power_consumption"]?.state ?? "0"
    );

    return html`
      <div class="card-wrap">
        <div class="c-head">
          <ha-icon
            icon=${isLocked ? "mdi:lock" : isJammed ? "mdi:lock-alert" : "mdi:lock-open-variant"}
            style="color: ${isLocked ? "#81c784" : isJammed ? "#ef5350" : "var(--sol-amber)"};"
          ></ha-icon>
          <span class="c-title">Front Door &amp; Actions</span>
          ${isJammed
            ? html`<span class="status-badge badge-away">JAMMED</span>`
            : leavingPending
              ? html`<span class="status-badge badge-sunrise">Leaving 5m</span>`
              : awayActive
                ? html`<span class="status-badge badge-away">Away Armed</span>`
                : html`<span class="status-badge ${isLocked ? "badge-locked" : "badge-sunrise"}">
                    ${isLocked ? "Secured" : "Unlocked"}
                  </span>`}
          <span class="grow"></span>
          <span class="c-status">Aqara U200</span>
        </div>

        <div class="c-body">
          <div class="c-main">
            <div
              class="big-val"
              style="font-size: 38px; color: ${isLocked
                ? "#81c784"
                : isJammed
                  ? "#ef5350"
                  : "var(--sol-amber)"};"
            >
              ${isLocked ? "Locked" : isJammed ? "Jammed" : lockState === "unlocked" ? "Unlocked" : lockState}
            </div>
            <div style="font-size: 11.5px; color: var(--sol-text-3); margin-top: 6px;">
              ${awayActive
                ? "Unlocking disarms Away Mode automatically"
                : "Auto-locks on Sleep Mode and Away Mode"}
            </div>
          </div>

          <div class="small-grid c-side">
            <span class="sg-k">Lock battery</span>
            <span class="sg-v">${batt && batt !== "unavailable" ? `${batt}%` : "—"}</span>
            <span class="sg-k">House presence</span>
            <span class="sg-v">${awayActive ? "Away" : "Home"}</span>
            <span class="sg-k">Watch plug</span>
            <span class="sg-v">${chargerWatts.toFixed(1)} W</span>
          </div>
        </div>

        <div class="quick-actions">
          <button
            class="qa-btn ${isLocked ? "locked-cta" : "lock-cta"}"
            @click=${() =>
              this.hass.callService("lock", isLocked ? "unlock" : "lock", {
                entity_id: LOCK_ENTITY,
              })}
          >
            <ha-icon icon=${isLocked ? "mdi:lock-open-outline" : "mdi:lock"}></ha-icon>
            ${isLocked ? "Unlock Door" : "Lock Door"}
          </button>

          <button
            class="qa-btn ${leavingPending ? "active-cyan" : ""}"
            @click=${() =>
              this.hass.callService("input_button", "press", { entity_id: LEAVING_BUTTON })}
          >
            <ha-icon icon="mdi:exit-run"></ha-icon>
            ${leavingPending ? "Leaving Armed (5m)" : "Leaving in 5m"}
          </button>

          <button
            class="qa-btn"
            @click=${() =>
              this.hass.callService("script", "turn_on", {
                entity_id: "script.start_charge_cycle_from_button_data",
              })}
          >
            <ha-icon icon="mdi:watch-variant"></ha-icon>
            Watch Charge
          </button>
        </div>
      </div>
    `;
  }

  /* 2. Light Card (read-only Master Target % + EV bias drawer) */
  private renderLightCard() {
    const w = this.snap.world;
    const masterTarget =
      w.master_target_brightness ??
      (w.demand !== null && w.demand !== undefined ? Math.round(w.demand * 254) : 254);
    const targetPct = Math.round((masterTarget / 254) * 100);
    const derimVal = Math.round(kelvinToDerim(w.kelvin ?? 4000));
    const gateOpen =
      this.hass.states["input_boolean.ambient_gate"]?.state === "on" ||
      this.hass.states["binary_sensor.entry_ambient_gate"]?.state === "on" ||
      !!w.gate_open;
    const sleepActive =
      this.hass.states["input_boolean.solace_sleep"]?.state === "on" || w.night_active;
    const workActive =
      this.hass.states["input_boolean.work_mode"]?.state === "on" || !!w.work_mode;

    const spark = this.spark(LUX, { scale: "log" });

    return html`
      <div class="card-wrap">
        <div class="c-head">
          <ha-icon icon="mdi:lightbulb" style="color: var(--sol-amber);"></ha-icon>
          <span class="c-title">Light</span>
          ${this.renderModeBadge()}
          <span class="grow"></span>
          <div class="head-btns">
            <button
              class="btn-pill"
              style="background: ${this.biasOpen ? "var(--sol-cyan-tint)" : "var(--sol-control)"}; color: ${this.biasOpen ? "var(--sol-cyan)" : "var(--sol-text-3)"};"
              @click=${() => (this.biasOpen = !this.biasOpen)}
            >
              <ha-icon icon="mdi:tune"></ha-icon>
              Bias
              <ha-icon icon=${this.biasOpen ? "mdi:chevron-up" : "mdi:chevron-down"}></ha-icon>
            </button>
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
              style="background: ${gateOpen ? "rgba(255,183,77,.22)" : "var(--sol-control)"}; color: ${gateOpen ? "var(--sol-amber)" : "var(--sol-text-3)"};"
              @click=${() => this.toggleGate()}
            >
              <ha-icon icon="mdi:theme-light-dark"></ha-icon>
              Ambient
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
              ${targetPct}<span class="unit" style="font-size: 16px; margin-left: 3px;">%</span>
            </div>
            <div style="font-size: 11px; color: var(--sol-text-3); margin-top: 4px;">
              Master Target (${masterTarget}/254)
            </div>
          </div>
          <div class="small-grid c-side">
            <span class="sg-k">Circadian</span>
            <span class="sg-v" style="color: var(--sol-amber); font-weight: 600;">
              ${w.kelvin ?? 4000} K
              <span style="font-weight: 400; color: var(--sol-text-3); font-size: 10px;">
                (${derimVal} M)
              </span>
            </span>
            ${this.snap.rooms.map((r) => {
              const lit = (r.level ?? 0) > 0;
              return html`
                <span class="sg-k">${r.name}</span>
                <span
                  class="sg-v"
                  style="color: ${lit ? "var(--sol-amber)" : "var(--sol-text-4)"}; font-weight: ${lit ? "600" : "400"};"
                >
                  ${r.manual.active ? "Manual" : lit ? `${r.level} lvl` : "Off"}
                </span>
              `;
            })}
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

  /* 3. Inside Temperature Card (clean indoor sensors + 24h sparkline) */
  private renderInsideCard() {
    const tempState = this.hass.states[INSIDE_TEMP];
    const currentTemp = parseFloat(tempState?.state ?? "");

    const rooms = ROOM_SENSORS.map((r) => ({
      ...r,
      temp: parseFloat(this.hass.states[r.id]?.state ?? ""),
    }));
    const valid = rooms.filter((r) => !isNaN(r.temp));
    const warmest = valid.length ? [...valid].sort((a, b) => b.temp - a.temp)[0] : null;
    const coolest = valid.length ? [...valid].sort((a, b) => a.temp - b.temp)[0] : null;

    const spark = this.spark(INSIDE_TEMP, { minSpan: 1.5 });

    return html`
      <div class="card-wrap">
        <div class="c-head">
          <ha-icon icon="mdi:home-thermometer" style="color: #ef5350;"></ha-icon>
          <span class="c-title">Inside</span>
          <span class="grow"></span>
          ${warmest && coolest
            ? html`
                <span class="c-status">
                  ${warmest.name} ${warmest.temp.toFixed(1)}° / ${coolest.name}
                  ${coolest.temp.toFixed(1)}°
                </span>
              `
            : nothing}
        </div>

        <div class="c-body">
          <div class="c-main">
            <div class="big-val">
              ${isNaN(currentTemp) ? "—" : currentTemp.toFixed(1)}<span class="unit">°</span>
            </div>
          </div>

          <div class="small-grid c-side">
            ${rooms.map(
              (r) => html`
                <span class="sg-k">${r.name}</span>
                <span class="sg-v">${isNaN(r.temp) ? "—" : `${r.temp.toFixed(1)}°`}</span>
              `
            )}
          </div>
        </div>

        ${this.renderHighLow(spark, "°")}
        ${this.renderBand("inside", spark, "#ef5350")}
      </div>
    `;
  }

  /* 4. Outside Card */
  private renderOutsideCard() {
    const tempState = this.hass.states[OUTSIDE_TEMP];
    const rawTemp = parseFloat(tempState?.state ?? "");
    const weather = this.hass.states[WEATHER];
    const attrs = weather?.attributes ?? {};
    const officialTemp =
      attrs.temperature !== undefined && attrs.temperature !== null
        ? Number(attrs.temperature)
        : null;

    const luxState = this.hass.states[LUX];
    const currentLux = parseFloat(luxState?.state ?? "0");
    const isSolarHeated = currentLux >= 25000;
    const displayTemp = isSolarHeated && officialTemp !== null ? officialTemp : rawTemp;

    const w = this.snap.world;
    const elevVal = w.elevation !== null && w.elevation !== undefined ? w.elevation.toFixed(1) : "—";
    const humidityOut = attrs.humidity;

    const spark = this.spark(OUTSIDE_TEMP, { minSpan: 2 });

    return html`
      <div class="card-wrap">
        <div class="c-head">
          <ha-icon icon="mdi:tree" style="color: var(--sol-cyan);"></ha-icon>
          <span class="c-title">Outside</span>
          ${isSolarHeated
            ? html`<span class="status-badge badge-sunrise">Solar Clamped</span>`
            : nothing}
          <span class="grow"></span>
          <span class="c-status">${isSolarHeated ? "Met fallback" : "calibrated probe"}</span>
        </div>

        <div class="c-body">
          <div class="c-main">
            <div class="big-val">
              ${isNaN(displayTemp) ? "—" : displayTemp.toFixed(1)}<span class="unit">°</span>
            </div>
            ${isSolarHeated && !isNaN(rawTemp)
              ? html`<div style="font-size: 11px; color: var(--sol-amber); margin-top: 3px;">
                  Probe ${rawTemp.toFixed(1)}° (+${(rawTemp - (officialTemp ?? 0)).toFixed(1)}° sun)
                </div>`
              : nothing}
          </div>
          <div class="small-grid c-side">
            <span class="sg-k">Lux</span>
            <span class="sg-v">${num(Math.round(currentLux))} lx</span>
            <span class="sg-k">Sun</span>
            <span class="sg-v">${elevVal}°</span>
            <span class="sg-k">Cloud cover</span>
            <span class="sg-v">${Math.round(attrs.cloud_coverage ?? 0)}%</span>
            <span class="sg-k">Humidity</span>
            <span class="sg-v">
              ${humidityOut !== undefined && humidityOut !== null ? `${humidityOut}%` : "—"}
            </span>
          </div>
        </div>

        ${this.renderHighLow(spark, "°")}
        ${this.renderBand("outside", spark, "var(--sol-cyan)")}
      </div>
    `;
  }

  /* 5. Weather Forecast Card */
  private renderWeatherCard() {
    const weather = this.hass.states[WEATHER];
    const condition = weather?.state ?? "cloudy";
    const attrs = weather?.attributes ?? {};

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
                          ${Math.round(d.temperature ?? 0)}°<span>/${Math.round(d.templow ?? 0)}°</span>
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

  /* 6. Refrigerator Card (unconditionally visible) */
  private renderFridgeCard() {
    const fridgeTempState = this.hass.states[FRIDGE_TEMP];
    const currentTemp = parseFloat(fridgeTempState?.state ?? "");

    const tooCold = !isNaN(currentTemp) && currentTemp <= FRIDGE_COLD;
    const tooWarm = !isNaN(currentTemp) && currentTemp >= FRIDGE_WARM;
    const alertClass = tooCold ? "alert-cold" : tooWarm ? "alert-warm" : "";
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

  /* 7. Running Now Card */
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
    const cycleCutoff = parseFloat(
      this.hass.states["input_number.charge_active_threshold"]?.state ?? "0"
    );
    const defaultCutoff = parseFloat(
      this.hass.states["input_number.charge_off_wattage"]?.state ?? "1.1"
    );
    const chargeCutoff = cycleCutoff > 0 ? cycleCutoff : defaultCutoff;
    const isCharging = chargerPower > chargeCutoff;

    if (!isWasherRunning && !isCharging) {
      return html`
        <div class="idle-strip">
          <span class="idle-item">
            <ha-icon icon="mdi:washing-machine"></ha-icon>
            Washing machine <b>idle</b>
          </span>
          <span class="idle-sep"></span>
          <span class="idle-item">
            <ha-icon icon="mdi:watch"></ha-icon>
            Device charging <b>${chargerPower.toFixed(2)} W</b>
          </span>
        </div>
      `;
    }

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
                  ${Math.round(washerProgress)}% · remaining ${washerRemaining}
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
              Washing machine <b>idle</b>
            </span>
          </div>
        `;

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
              </div>
              <div class="small-grid c-side">
                <span class="sg-k">Cut-off</span>
                <span class="sg-v" style="color: #ef5350;">${chargeCutoff.toFixed(2)} W</span>
              </div>
            </div>
          </div>
        `
      : html`
          <div class="idle-strip">
            <span class="idle-item">
              <ha-icon icon="mdi:watch"></ha-icon>
              Device charging <b>${chargerPower.toFixed(2)} W</b>
            </span>
          </div>
        `;

    return html`<div class="g2-run">${washer}${charging}</div>`;
  }

  private renderCameraCard() {
    if (!this.hass) return nothing;
    const streaming = this.hass.states["switch.kitchen_kitchen_streaming"]?.state === "on";
    if (!streaming) return nothing;
    const camera = this.hass.states["camera.kitchen_kitchen"];
    if (!camera) return nothing;

    const openCamera = () => {
      this.dispatchEvent(
        new CustomEvent("hass-more-info", {
          detail: { entityId: "camera.kitchen_kitchen" },
          bubbles: true,
          composed: true,
        })
      );
    };

    return html`
      <div class="card-wrap cam-card">
        <div class="c-head">
          <ha-icon icon="mdi:video" style="color: var(--sol-cyan);"></ha-icon>
          <span class="c-title">${camera.attributes.friendly_name || "Kitchen Camera"}</span>
          <span class="grow"></span>
          <button
            class="btn-pill"
            @click=${openCamera}
            style="background: rgba(38, 198, 218, 0.15); color: var(--sol-cyan);"
          >
            <ha-icon icon="mdi:fullscreen"></ha-icon>
            Expand
          </button>
        </div>
        <div class="cam-stream-container" @click=${openCamera}>
          <ha-camera-stream
            .hass=${this.hass}
            .stateObj=${camera}
            controls
            allow-exoplayer
            muted
          ></ha-camera-stream>
        </div>
      </div>
    `;
  }

  private commitOrder(nextIds: string[]) {
    setCardOrder(this.hass, "home", nextIds);
  }

  render() {
    if (!this.snap || !this.hass) return nothing;

    const defaultCards: HomeCardDef[] = [
      { id: "door", label: "Front Door & Actions", render: () => this.renderDoorCard() },
      { id: "light", label: "Light", render: () => this.renderLightCard() },
      { id: "inside", label: "Inside", render: () => this.renderInsideCard() },
      { id: "outside", label: "Outside", render: () => this.renderOutsideCard() },
      { id: "weather", label: "Forecast", render: () => this.renderWeatherCard() },
      { id: "fridge", label: "Refrigerator", render: () => this.renderFridgeCard() },
      { id: "running", label: "Running Now", fullSpan: true, render: () => this.renderRunningNow() },
    ];

    const ordered = applyOrder(defaultCards, (c) => c.id, this.snap.card_order?.home);
    const ids = ordered.map((c) => c.id);

    return html`
      ${this.renderCameraCard()}
      <div class="cards-grid">
        ${ordered.map(
          (card, idx) => html`
            <div
              class="reorder-shell ${card.fullSpan ? "full-span" : ""} ${this.reorderMode ? "reorder-armed" : ""} ${this.overId === card.id ? "drag-over" : ""}"
              draggable=${this.reorderMode ? "true" : "false"}
              @dragstart=${(e: DragEvent) => {
                if (!this.reorderMode) return;
                this.dragId = card.id;
                e.dataTransfer?.setData("text/plain", card.id);
              }}
              @dragover=${(e: DragEvent) => {
                if (!this.reorderMode || !this.dragId) return;
                e.preventDefault();
                this.overId = card.id;
              }}
              @dragleave=${() => {
                if (this.overId === card.id) this.overId = null;
              }}
              @drop=${(e: DragEvent) => {
                if (!this.reorderMode || !this.dragId) return;
                e.preventDefault();
                const from = this.dragId;
                this.dragId = null;
                this.overId = null;
                if (from !== card.id) {
                  this.commitOrder(moveItem(ids, from, card.id));
                }
              }}
              @dragend=${() => {
                this.dragId = null;
                this.overId = null;
              }}
            >
              ${this.reorderMode
                ? html`
                    <div class="reorder-bar">
                      <span class="reorder-grip">
                        <ha-icon icon="mdi:drag"></ha-icon>
                        ${card.label}
                      </span>
                      <span class="reorder-arrows">
                        <button
                          class="reorder-btn"
                          ?disabled=${idx === 0}
                          @click=${() => this.commitOrder(nudgeItem(ids, card.id, -1))}
                          title="Move earlier"
                        >
                          <ha-icon icon="mdi:arrow-left"></ha-icon>
                        </button>
                        <button
                          class="reorder-btn"
                          ?disabled=${idx === ids.length - 1}
                          @click=${() => this.commitOrder(nudgeItem(ids, card.id, 1))}
                          title="Move later"
                        >
                          <ha-icon icon="mdi:arrow-right"></ha-icon>
                        </button>
                      </span>
                    </div>
                  `
                : nothing}
              ${card.render()}
            </div>
          `
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-tab-home": SolTabHome;
  }
}
