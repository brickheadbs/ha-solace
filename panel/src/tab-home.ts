/**
 * Home — the new master home overview tab for Solace.
 *
 * Integrates real-time environmental instrumentation (Light, Weather, Inside/Outside temperatures,
 * Hot water, Refrigerator) and "Running now" telemetry (Washing machine, Device charging) with
 * direct access to the room bias controls.
 */

import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Hass, RoomRow, Snapshot } from "./api";
import { setRoom } from "./api";
import { num, stopLabel } from "./fmt";
import { fetchHistory, type Sample } from "./history";
import { buildSpark, clockAt, type Spark, type SparkOptions } from "./sparkline";
import { tokens } from "./tokens";
import "./ui";

/** The band is this tall in real pixels, on every card, so nothing is stretched. */
const BAND_H = 62;

const LUX = "sensor.entry_exterior_illuminance";
const INSIDE_TEMP = "sensor.kitchen_kitchen_thermostat_temperature";
const OUTSIDE_TEMP = "sensor.entry_exterior_temperature";
const HOT_WATER_TEMP = "sensor.hot_water_temperature_temperature";
const FRIDGE_TEMP = "sensor.refrigerator_temperature_temperature";

const TRACKED = [LUX, INSIDE_TEMP, OUTSIDE_TEMP, HOT_WATER_TEMP, FRIDGE_TEMP];

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
  private timer?: number;
  private historyTimer?: number;
  private _debounceTimers: Map<string, number> = new Map();

  connectedCallback() {
    super.connectedCallback();
    this.timer = window.setInterval(() => this.requestUpdate(), 1000);
    this.historyTimer = window.setInterval(() => this.loadHistory(), HISTORY_REFRESH_MS);
    this.loadHistory();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timer) clearInterval(this.timer);
    if (this.historyTimer) clearInterval(this.historyTimer);
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

      .c-body {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: flex-end;
        gap: 22px;
        margin-top: 10px;
        flex-wrap: wrap;
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

      .high-low {
        position: relative;
        z-index: 1;
        display: flex;
        gap: 18px;
        margin-top: 10px;
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
      entity_id: "climate.kitchen_kitchen_thermostat",
      hvac_mode: mode,
    });
  }

  private bumpHvacTemp(delta: number) {
    if (!this.hass) return;
    const climateState = this.hass.states["climate.kitchen_kitchen_thermostat"];
    const current = climateState?.attributes?.temperature ?? 20.0;
    const next = Math.round((current + delta) * 2) / 2;
    this.hass.callService("climate", "set_temperature", {
      entity_id: "climate.kitchen_kitchen_thermostat",
      temperature: next,
    });
  }

  private toggleSleep() {
    if (!this.hass) return;
    this.hass.callService("input_boolean", "toggle", {
      entity_id: "input_boolean.solace_sleep",
    });
  }

  /* ---------------------------------------------------------------- sparklines */

  private spark(entityId: string, opts: SparkOptions = {}): Spark | null {
    const samples = this.history.get(entityId);
    if (!samples || samples.length < 2) return null;
    return buildSpark(samples, {
      height: BAND_H,
      from: this.windowEnd - 24 * 3_600_000,
      to: this.windowEnd,
      ...opts,
    });
  }

  /**
   * The band itself. `id` only has to be unique inside this shadow root — it names the
   * fill gradient, and two cards sharing one would silently take each other's colour.
   */
  private renderBand(id: string, spark: Spark | null, colour: string) {
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
        <span>High <b>${spark.max.toFixed(digits)}${unit}</b> ${clockAt(spark.maxAt)}</span>
        <span>Low <b>${spark.min.toFixed(digits)}${unit}</b> ${clockAt(spark.minAt)}</span>
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
          <button
            class="btn-pill"
            style="background: ${sleepActive ? "rgba(149,117,205,.2)" : "var(--sol-control)"}; color: ${sleepActive ? "#b39ddb" : "var(--sol-text-3)"};"
            @click=${() => this.toggleSleep()}
          >
            <ha-icon icon="mdi:weather-night"></ha-icon>
            ${sleepActive ? "Sleep ON" : "Sleep"}
          </button>
        </div>

        <div class="c-body">
          <div>
            <div class="big-val mono-gold">${targetPct}<span class="unit" style="font-size: 15px; margin-left: 3px;">%</span></div>
            <div class="high-low" style="margin-top: 6px;">
              ${masterTarget} lvl${spark
                ? html` · peak <b>${num(Math.round(spark.max))} lx</b> ${clockAt(spark.maxAt)}`
                : nothing}
            </div>
          </div>
          <div class="stat-grid">
            <div class="stat-item">
              <span class="stat-label">Lux</span>
              <span class="stat-val" style="color: var(--sol-amber);">${num(luxVal)}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">Sun</span>
              <span class="stat-val">${elevVal}°</span>
            </div>
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

        ${this.renderBand("lux", spark, "var(--sol-amber)")}
      </div>
    `;
  }

  private renderWeatherCard() {
    const weather = this.hass.states["weather.forecast_home"];
    const weatherState = weather?.state ?? "clear";
    const cloudCover = weather?.attributes?.cloud_coverage ?? 70;
    const isRaining = weatherState.includes("rain");

    return html`
      <div class="card-wrap">
        <div class="c-head">
          <ha-icon icon="mdi:radar" style="color: var(--sol-cyan);"></ha-icon>
          <span class="c-title">Weather Radar &amp; Forecast</span>
          <span class="grow"></span>
          <span class="c-status">${isRaining ? "precipitation active" : "no rain expected"}</span>
        </div>

        <div
          style="flex: 1; margin-top: 10px; border-radius: 10px; background: repeating-linear-gradient(135deg,#1e1f21 0 10px,#191a1b 10px 20px); display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 96px; padding: 12px; box-sizing: border-box; text-align: center; position: relative; z-index: 1;"
        >
          <div style="font-size: 15px; font-weight: 500; color: var(--sol-text); text-transform: capitalize; margin-bottom: 4px;">
            ${weatherState.replace(/_/g, " ")}
          </div>
          <div style="font-size: 12px; color: var(--sol-text-3);">
            ${cloudCover}% cloud cover · ${weather?.attributes?.temperature ?? "—"}°C
          </div>
          <div style="font-size: 10.5px; color: var(--sol-faint); margin-top: 4px;">
            weather.forecast_home
          </div>
        </div>
      </div>
    `;
  }

  private renderInsideCard() {
    const tempState = this.hass.states["sensor.kitchen_kitchen_thermostat_temperature"];
    const climateState = this.hass.states["climate.kitchen_kitchen_thermostat"];
    const currentTemp = parseFloat(tempState?.state ?? "20.0");
    const hvacMode = climateState?.state ?? "heat";
    const targetTemp = climateState?.attributes?.temperature ?? 20.5;

    const spark = this.spark(INSIDE_TEMP, { minSpan: 1.5 });

    return html`
      <div class="card-wrap">
        <div class="c-head">
          <ha-icon icon="mdi:home-thermometer" style="color: #ef5350;"></ha-icon>
          <span class="c-title">Inside · Kitchen</span>
          <span class="grow"></span>
          <div class="hvac-modes">
            <button
              class="hvac-btn ${hvacMode === "off" ? "active" : ""}"
              @click=${() => this.setHvacMode("off")}
            >
              Off
            </button>
            <button
              class="hvac-btn ${hvacMode === "heat" ? "active-heat" : ""}"
              @click=${() => this.setHvacMode("heat")}
            >
              Heat
            </button>
            <button
              class="hvac-btn ${hvacMode === "eco" ? "active-eco" : ""}"
              @click=${() => this.setHvacMode("eco")}
            >
              Eco
            </button>
          </div>
        </div>

        <div class="c-body">
          <div class="big-val">
            ${isNaN(currentTemp) ? "—" : currentTemp.toFixed(1)}<span class="unit">°</span>
          </div>
          ${hvacMode !== "off"
            ? html`
                <div style="display: flex; align-items: center; gap: 10px; padding-bottom: 5px;">
                  <div>
                    <div class="stat-label">${hvacMode === "eco" ? "Eco hold" : "Heating to"}</div>
                    <div class="stat-val" style="color: ${hvacMode === "eco" ? "#81c784" : "#ef5350"};">
                      ${targetTemp}°
                    </div>
                  </div>
                  <div class="temp-stepper">
                    <button class="step-btn" @click=${() => this.bumpHvacTemp(0.5)}>+</button>
                    <button class="step-btn" @click=${() => this.bumpHvacTemp(-0.5)}>−</button>
                  </div>
                </div>
              `
            : nothing}
        </div>

        ${this.renderHighLow(spark, "°")}
        ${this.renderBand("inside", spark, "#ef5350")}
      </div>
    `;
  }

  private renderOutsideCard() {
    const tempState = this.hass.states["sensor.entry_exterior_temperature"];
    const currentTemp = parseFloat(tempState?.state ?? "14.1");
    const weather = this.hass.states["weather.forecast_home"];
    const humidityState = this.hass.states["sensor.kitchen_kitchen_thermostat_humidity"];
    const gateState = this.hass.states["binary_sensor.entry_ambient_gate"];

    const pressure = weather?.attributes?.pressure ?? 1020.5;
    const windSpeed = weather?.attributes?.wind_speed ?? 13;
    const windBearing = weather?.attributes?.wind_bearing ?? 300;
    const cloud = weather?.attributes?.cloud_coverage ?? 75;
    const humidity = humidityState?.state ?? 47;
    const gateOpen = gateState?.state === "on";

    const spark = this.spark(OUTSIDE_TEMP, { minSpan: 2 });

    return html`
      <div class="card-wrap">
        <div class="c-head">
          <ha-icon icon="mdi:tree" style="color: var(--sol-cyan);"></ha-icon>
          <span class="c-title">Outside · Entry</span>
          <span class="grow"></span>
          <span class="c-status">${weather?.state?.replace(/_/g, " ") ?? "partly cloudy"}</span>
        </div>

        <div class="c-body">
          <div class="big-val">
            ${isNaN(currentTemp) ? "—" : currentTemp.toFixed(1)}<span class="unit">°</span>
          </div>
          <div class="small-grid">
            <span class="sg-k">Pressure</span>
            <span class="sg-v">${pressure} hPa</span>
            <span class="sg-k">Wind</span>
            <span class="sg-v">${windBearing}° · ${windSpeed} km/h</span>
            <span class="sg-k">Cloud cover</span>
            <span class="sg-v">${cloud}%</span>
            <span class="sg-k">Humidity, kitchen</span>
            <span class="sg-v">${humidity}%</span>
            <span class="sg-k">Ambient gate</span>
            <span class="sg-v">${gateOpen ? "open (dark enough)" : "closed (bright)"}</span>
          </div>
        </div>

        ${this.renderHighLow(spark, "°")}
        ${this.renderBand("outside", spark, "var(--sol-cyan)")}
      </div>
    `;
  }

  private renderHotWaterCard() {
    const hwTempState = this.hass.states["sensor.hot_water_temperature_temperature"];
    const currentTemp = parseFloat(hwTempState?.state ?? "51.2");
    const running = this.hass.states["input_boolean.hw_cycle_running"]?.state === "on";
    const nextStart = this.hass.states["sensor.hot_water_next_start"]?.state ?? "06:10";
    const targetState =
      this.hass.states["input_number.hw_target_summer"]?.state ??
      this.hass.states["input_number.hw_target_winter"]?.state ??
      "56.0";

    const spark = this.spark(HOT_WATER_TEMP, { minSpan: 4 });

    return html`
      <div class="card-wrap">
        <div class="c-head">
          <ha-icon icon="mdi:water-boiler" style="color: var(--sol-amber);"></ha-icon>
          <span class="c-title">Hot Water</span>
          <span class="grow"></span>
          <span class="c-status">${running ? "heating now" : `idle · next ${nextStart}`}</span>
        </div>

        <div class="c-body">
          <div class="big-val">
            ${isNaN(currentTemp) ? "—" : currentTemp.toFixed(1)}<span class="unit">°</span>
          </div>
          <div class="stat-grid">
            <div class="stat-item">
              <span class="stat-label">Target</span>
              <span class="stat-val" style="color: var(--sol-amber);">${targetState}°</span>
            </div>
          </div>
        </div>

        ${this.renderHighLow(spark, "°")}
        ${this.renderBand("hotwater", spark, "var(--sol-amber)")}
      </div>
    `;
  }

  private renderFridgeCard() {
    const fridgeTempState = this.hass.states["sensor.refrigerator_temperature_temperature"];
    const currentTemp = parseFloat(fridgeTempState?.state ?? "3.6");

    const spark = this.spark(FRIDGE_TEMP, { minSpan: 2 });

    return html`
      <div class="card-wrap">
        <div class="c-head">
          <ha-icon icon="mdi:fridge" style="color: #81d4fa;"></ha-icon>
          <span class="c-title">Refrigerator</span>
        </div>

        <div class="c-body">
          <div class="big-val">
            ${isNaN(currentTemp) ? "—" : currentTemp.toFixed(1)}<span class="unit">°</span>
          </div>
        </div>

        ${this.renderHighLow(spark, "°")}
        ${this.renderBand("fridge", spark, "#81d4fa")}
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
              <div>
                <div class="run-phase">${washerPhase}</div>
                <div class="high-low" style="margin-top: 8px;">
                  ${Math.round(washerProgress)}% through · remaining ${washerRemaining}
                </div>
              </div>
              <div class="small-grid">
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
              <div>
                <div class="big-val" style="color: var(--sol-green);">
                  ${chargerPower.toFixed(2)}<span class="unit">W</span>
                </div>
                <div class="high-low" style="margin-top: 8px;">Active charging cycle</div>
              </div>
              <div class="small-grid">
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
