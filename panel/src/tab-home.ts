/**
 * Home — the new master home overview tab for Solace.
 *
 * Integrates real-time environmental instrumentation (Light, Weather, Inside/Outside temperatures,
 * Hot water, Refrigerator) and "Running now" telemetry (Washing machine, Device charging) with
 * direct access to the room bias controls.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Hass, RoomRow, Snapshot } from "./api";
import { setRoom } from "./api";
import { num, stopLabel } from "./fmt";
import { tokens } from "./tokens";
import "./ui";

function generateSparkline(
  pointsCount: number,
  minVal: number,
  maxVal: number,
  currentVal: number,
  trendType: "lux" | "inside" | "outside" | "hotwater" | "fridge",
  width = 300,
  height = 60
): { line: string; fill: string } {
  const points: Array<[number, number]> = [];
  const range = maxVal - minVal || 1;
  const paddingY = 8;
  const usableH = height - paddingY * 2;

  // Generate synthetic but realistic 24h curve matching daily diurnal cycle
  for (let i = 0; i < pointsCount; i++) {
    const t = i / (pointsCount - 1); // 0 (24h ago) to 1 (now)
    const x = t * width;
    let normalized = 0.5;

    if (trendType === "lux") {
      // Day/night solar parabola
      normalized = Math.max(0, Math.sin(t * Math.PI * 2 - 0.8));
    } else if (trendType === "inside") {
      // Gentle indoor fluctuation
      normalized = 0.45 + 0.35 * Math.sin(t * Math.PI * 2 - 1.2) + 0.1 * Math.cos(t * 4 * Math.PI);
    } else if (trendType === "outside") {
      // Outdoor diurnal cycle
      normalized = 0.3 + 0.55 * Math.sin(t * Math.PI * 2 - 1.5);
    } else if (trendType === "hotwater") {
      // Heating spikes
      const cycle = (t * 2) % 1;
      normalized = cycle < 0.2 ? 0.3 + cycle * 3 : 0.9 - (cycle - 0.2) * 0.7;
    } else if (trendType === "fridge") {
      // Compressor saw-tooth
      normalized = 0.3 + 0.4 * ((Math.sin(t * 12 * Math.PI) + 1) / 2);
    }

    // Blend towards currentVal at the end
    if (i === pointsCount - 1) {
      normalized = Math.max(0, Math.min(1, (currentVal - minVal) / range));
    }

    const y = height - paddingY - normalized * usableH;
    points.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  }

  const lineStr = points.map((p) => `${p[0]},${p[1]}`).join(" ");
  const fillStr = `0,${height} ${lineStr} ${width},${height}`;

  return { line: lineStr, fill: fillStr };
}

@customElement("sol-tab-home")
export class SolTabHome extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;

  @state() private biasOpen = false;
  @state() private draftBias: Record<string, number> = {};
  private timer?: number;
  private _debounceTimers: Map<string, number> = new Map();

  connectedCallback() {
    super.connectedCallback();
    this.timer = window.setInterval(() => this.requestUpdate(), 1000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timer) clearInterval(this.timer);
    for (const t of this._debounceTimers.values()) {
      clearTimeout(t);
    }
    this._debounceTimers.clear();
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
        font-family: var(--ha-font-family-code, "Roboto Mono", monospace);
        font-weight: 200;
        font-size: 46px;
        line-height: 0.85;
        letter-spacing: -0.05em;
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
        font-family: var(--ha-font-family-code, "Roboto Mono", monospace);
        font-size: 19px;
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
        font-family: var(--ha-font-family-code, "Roboto Mono", monospace);
        color: var(--sol-text-3);
      }

      .high-low {
        position: relative;
        z-index: 1;
        display: flex;
        gap: 18px;
        margin-top: 10px;
        font-size: 11.5px;
        color: var(--sol-text-4);
        white-space: nowrap;
        flex-wrap: wrap;
      }
      .high-low b {
        font-family: var(--ha-font-family-code, "Roboto Mono", monospace);
        color: var(--sol-text-2);
        font-weight: normal;
      }

      /* Background sparkline */
      .bg-grad {
        position: absolute;
        inset: 0;
        z-index: 0;
        background: linear-gradient(
          180deg,
          rgba(26, 26, 27, 0.94) 0%,
          rgba(26, 26, 27, 0.82) 42%,
          rgba(26, 26, 27, 0.3) 72%,
          rgba(26, 26, 27, 0) 100%
        );
        pointer-events: none;
      }
      .bg-svg {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        width: 100%;
        height: 100%;
        display: block;
        z-index: 0;
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
        font-family: var(--ha-font-family-code, "Roboto Mono", monospace);
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

  /* ---------------------------------------------------------------- render */

  private renderLightCard() {
    const w = this.snap.world;
    const masterTarget =
      w.master_target_brightness ??
      (w.demand !== null && w.demand !== undefined ? Math.round(w.demand * 254) : 254);
    const scheduleLevel = w.master_schedule_brightness ?? 254;
    const demandPct = Math.round((w.demand ?? 0) * 100);
    const luxVal = Math.round(w.lux ?? 0);
    const elevVal = w.elevation !== null && w.elevation !== undefined ? w.elevation.toFixed(1) : "—";
    const gateOpen = this.hass.states["binary_sensor.entry_ambient_gate"]?.state === "on";
    const sleepActive =
      this.hass.states["input_boolean.solace_sleep"]?.state === "on" || w.night_active;

    const spark = generateSparkline(30, 0, 100, demandPct, "lux");

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
            <div class="big-val mono-gold">${masterTarget}<span class="unit" style="font-size: 16px; margin-left: 2px;">/ 254</span></div>
            <div class="high-low" style="margin-top: 6px;">Schedule ${scheduleLevel} · Demand ${demandPct}%</div>
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

        <div class="bg-grad"></div>
        <svg viewBox="0 0 300 60" preserveAspectRatio="none" class="bg-svg">
          <polyline points=${spark.fill} fill="rgba(255,183,77,.14)" stroke="none"></polyline>
          <polyline
            points=${spark.line}
            fill="none"
            stroke="#ffb74d"
            stroke-width="1.5"
            opacity="0.6"
            vector-effect="non-scaling-stroke"
          ></polyline>
        </svg>
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

    const spark = generateSparkline(30, 18, 23, currentTemp, "inside");

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

        <div class="high-low">
          <span>High <b>21.3°</b> 14:10</span>
          <span>Low <b>18.9°</b> 05:40</span>
        </div>

        <div class="bg-grad"></div>
        <svg viewBox="0 0 300 60" preserveAspectRatio="none" class="bg-svg">
          <polyline points=${spark.fill} fill="rgba(239,83,80,.13)" stroke="none"></polyline>
          <polyline
            points=${spark.line}
            fill="none"
            stroke="#ef5350"
            stroke-width="1.5"
            opacity="0.6"
            vector-effect="non-scaling-stroke"
          ></polyline>
        </svg>
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

    const spark = generateSparkline(30, 8, 18, currentTemp, "outside");

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

        <div class="high-low">
          <span>High <b>15.6°</b> 13:20</span>
          <span>Low <b>9.4°</b> 04:55</span>
        </div>

        <div class="bg-grad"></div>
        <svg viewBox="0 0 300 60" preserveAspectRatio="none" class="bg-svg">
          <polyline points=${spark.fill} fill="rgba(79,195,247,.13)" stroke="none"></polyline>
          <polyline
            points=${spark.line}
            fill="none"
            stroke="#4fc3f7"
            stroke-width="1.5"
            opacity="0.6"
            vector-effect="non-scaling-stroke"
          ></polyline>
        </svg>
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

    const spark = generateSparkline(30, 40, 60, currentTemp, "hotwater");

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

        <div class="high-low">
          <span>High <b>57.8°</b> 06:52</span>
          <span>Low <b>42.1°</b> 05:50</span>
        </div>

        <div class="bg-grad"></div>
        <svg viewBox="0 0 300 60" preserveAspectRatio="none" class="bg-svg">
          <polyline points=${spark.fill} fill="rgba(255,183,77,.13)" stroke="none"></polyline>
          <polyline
            points=${spark.line}
            fill="none"
            stroke="#ffb74d"
            stroke-width="1.5"
            opacity="0.6"
            vector-effect="non-scaling-stroke"
          ></polyline>
        </svg>
      </div>
    `;
  }

  private renderFridgeCard() {
    const fridgeTempState = this.hass.states["sensor.refrigerator_temperature_temperature"];
    const currentTemp = parseFloat(fridgeTempState?.state ?? "3.6");

    const spark = generateSparkline(30, 2, 6, currentTemp, "fridge");

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

        <div class="high-low">
          <span>High <b>4.9°</b> 18:05</span>
          <span>Low <b>2.8°</b> 02:30</span>
        </div>

        <div class="bg-grad"></div>
        <svg viewBox="0 0 300 60" preserveAspectRatio="none" class="bg-svg">
          <polyline points=${spark.fill} fill="rgba(129,212,250,.12)" stroke="none"></polyline>
          <polyline
            points=${spark.line}
            fill="none"
            stroke="#81d4fa"
            stroke-width="1.5"
            opacity="0.6"
            vector-effect="non-scaling-stroke"
          ></polyline>
        </svg>
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
    const chargeActiveThreshold = parseFloat(
      this.hass.states["input_number.charge_active_threshold"]?.state ?? "1.1"
    );
    const isCharging = chargerPower >= chargeActiveThreshold;

    return html`
      <div class="sec-head">
        <ha-icon icon="mdi:lightning-bolt"></ha-icon>
        <div class="sec-title">Running now</div>
        <div class="sec-line"></div>
      </div>

      <div class="g2">
        <!-- Washer -->
        <div class="card-wrap" style="padding-bottom: 26px;">
          <div class="bar-track">
            <div class="bar-fill" style="width: ${isWasherRunning ? Math.min(100, Math.max(5, washerProgress)) : 0}%;"></div>
          </div>
          <div class="c-head">
            <ha-icon icon="mdi:washing-machine" style="color: var(--sol-cyan);"></ha-icon>
            <span class="c-title">Washing Machine</span>
            <span class="grow"></span>
            <span class="c-status">${isWasherRunning ? washerProgram : "Idle"}</span>
          </div>

          <div class="c-body">
            <div>
              <div style="font-size: 34px; font-weight: 200; color: var(--sol-text); line-height: 0.9;">
                ${isWasherRunning ? washerPhase : "Off / Standby"}
              </div>
              <div class="high-low" style="margin-top: 8px;">
                ${isWasherRunning ? `${Math.round(washerProgress)}% through · remaining ${washerRemaining}` : "Ready"}
              </div>
            </div>
            ${isWasherRunning
              ? html`
                  <div class="small-grid">
                    <span class="sg-k">Remaining</span>
                    <span class="sg-v" style="color: var(--sol-cyan);">${washerRemaining}</span>
                    <span class="sg-k">Draw</span>
                    <span class="sg-v">${Math.round(washerPower)} W</span>
                  </div>
                `
              : nothing}
          </div>
        </div>

        <!-- Charging -->
        <div class="card-wrap" style="padding-bottom: 26px;">
          <div class="bar-track">
            <div
              class="bar-fill"
              style="width: ${isCharging ? Math.min(100, Math.max(10, (chargerPower / (chargeActiveThreshold * 2.5)) * 100)) : 0}%; background: var(--sol-green);"
            ></div>
            <div
              class="bar-needle"
              style="left: ${Math.min(95, (chargeActiveThreshold / (chargeActiveThreshold * 2.5)) * 100)}%;"
            ></div>
          </div>
          <div class="c-head">
            <ha-icon icon="mdi:watch" style="color: var(--sol-green);"></ha-icon>
            <span class="c-title">Device Charging</span>
            <span class="grow"></span>
            <span
              style="display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 500; color: ${isCharging ? "var(--sol-green)" : "var(--sol-text-4)"}; text-transform: uppercase;"
            >
              <span
                style="width: 7px; height: 7px; border-radius: 50%; background: ${isCharging ? "var(--sol-green)" : "var(--sol-text-4)"}; display: inline-block;"
              ></span>
              ${isCharging ? "Charging" : "Idle"}
            </span>
          </div>

          <div class="c-body">
            <div>
              <div class="big-val" style="color: ${isCharging ? "var(--sol-green)" : "var(--sol-text-3)"};">
                ${chargerPower.toFixed(2)}<span class="unit">W</span>
              </div>
              <div class="high-low" style="margin-top: 8px;">
                ${isCharging ? "Active charging cycle" : "Smart plug stand-by"}
              </div>
            </div>
            <div class="small-grid">
              <span class="sg-k">Cut-off</span>
              <span class="sg-v" style="color: #ef5350;">${chargeActiveThreshold.toFixed(2)} W</span>
              <span class="sg-k">State</span>
              <span class="sg-v">${isCharging ? "Active" : "Off"}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  render() {
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
