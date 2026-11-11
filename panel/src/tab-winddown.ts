/**
 * Wind-down Tab — Dedicated evening pre-sleep & bedtime hub.
 *
 * 1. Bedtime Checklist & Controls (Aqara U200 Front Door Lock + Auto-Lock on Sleep,
 *    Sleep Mode toggle + Phone DND / Pixel Watch Bedtime sensors, Watch Charger start,
 *    Stop Speakers).
 * 2. Virtual Sunset Curve (interactive spline + HH:MM time input for Window Start,
 *    Bedroom Dwell minutes, Fade Duration minutes).
 * 3. Bedtime Dwell Cap, Night Corridor Floor & Dawn Unlatch.
 */

import { LitElement, css, html, nothing, svg } from "lit";
import { property, state } from "lit/decorators.js";
import { customElement } from "./custom-element";
import type { Hass, Snapshot } from "./api";
import { musicStop, setHouse, setRoom, setSunsetCurve, toggleSleep } from "./api";
import { clock, num, parseClock } from "./fmt";
import { MonotoneSpline } from "./spline";
import { tokens } from "./tokens";
import "./ui";

interface NodeDef {
  x: number; // 0..100 (%)
  y: number; // 0..254 (level)
}

const DEF_SUNSET: NodeDef[] = [
  { x: 0, y: 180 },
  { x: 30, y: 120 },
  { x: 70, y: 40 },
  { x: 100, y: 3 },
];

const LOCK_ENTITY = "lock.aqara_smart_lock_u200";
const LOCK_BATTERY = "sensor.aqara_smart_lock_u200_battery";
const AUTO_LOCK_SLEEP_AUTO = "automation.lock_auto_lock_u200_on_sleep_mode";
const CHARGER_POWER = "sensor.bedroom_smart_plug_power_consumption";

const X0 = 48;
const X1 = 762;
const Y0 = 14;
const Y1 = 206;
const VW = 780;
const VH = 230;

@customElement("sol-tab-winddown")
export class SolTabWinddown extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;

  @state() private localSunset: NodeDef[] | null = null;
  @state() private selSunsetIdx: number | null = null;
  @state() private hoverSunset: { x: number; y: number } | null = null;

  private _drag: { idx: number } | null = null;
  private _debounceTimer?: number;

  static styles = [
    tokens,
    css`
      :host {
        display: block;
        padding-bottom: 40px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(460px, 1fr));
        gap: 14px;
        align-items: start;
      }
      .full-col {
        grid-column: 1 / -1;
      }
      .card {
        background: var(--sol-card);
        border-radius: var(--sol-r-card);
        padding: 15px 18px 16px;
        box-shadow: var(--sol-shadow);
      }
      .head {
        display: flex;
        align-items: center;
        gap: 9px;
        margin-bottom: 12px;
      }
      .title {
        font-size: 15px;
        font-weight: 500;
        color: var(--sol-text);
      }
      .spacer {
        flex: 1;
      }
      .checklist-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 12px;
      }
      .check-tile {
        background: var(--sol-control);
        border-radius: 10px;
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        border: 1px solid rgba(255, 255, 255, 0.06);
      }
      .check-tile.ok {
        border-color: rgba(129, 199, 132, 0.32);
      }
      .check-tile.warn {
        border-color: rgba(255, 183, 77, 0.4);
      }
      .tile-top {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .tile-top ha-icon {
        --mdc-icon-size: 18px;
      }
      .tile-name {
        font-size: 13px;
        font-weight: 600;
        color: var(--sol-text);
      }
      .badge {
        margin-left: auto;
        padding: 2px 8px;
        border-radius: 5px;
        font-size: 11px;
        font-weight: 600;
      }
      .badge-green {
        background: rgba(129, 199, 132, 0.16);
        color: #81c784;
      }
      .badge-amber {
        background: rgba(255, 183, 77, 0.18);
        color: #ffb74d;
      }
      .badge-red {
        background: rgba(239, 83, 80, 0.18);
        color: #ef5350;
      }
      .badge-dim {
        background: rgba(255, 255, 255, 0.06);
        color: var(--sol-text-3);
      }
      .tile-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: auto;
      }
      .act-btn {
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: var(--sol-card);
        color: var(--sol-text-2);
        border-radius: 7px;
        padding: 6px 11px;
        font-family: inherit;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .act-btn:hover {
        background: var(--sol-card-high);
        color: var(--sol-text);
      }
      .act-btn.primary {
        border-color: rgba(255, 183, 77, 0.45);
        background: rgba(255, 183, 77, 0.16);
        color: #ffb74d;
      }
      .act-btn.cyan {
        border-color: rgba(86, 182, 194, 0.45);
        background: rgba(86, 182, 194, 0.14);
        color: var(--sol-cyan);
      }
      .act-btn ha-icon {
        --mdc-icon-size: 15px;
      }
      .mini-meta {
        font-size: 11.5px;
        color: var(--sol-text-3);
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      /* Controls & Curve */
      .curve-ctrl-bar {
        display: flex;
        align-items: center;
        gap: 14px;
        flex-wrap: wrap;
        margin: 6px 0 10px;
        padding: 9px 12px;
        background: rgba(0, 0, 0, 0.22);
        border-radius: 8px;
      }
      .curve-metric {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--sol-text-2);
      }
      .time-input {
        background: var(--sol-card);
        border: 1px solid rgba(255, 183, 77, 0.38);
        border-radius: 6px;
        padding: 4px 8px;
        font-family: inherit;
        font-size: 13px;
        font-weight: 600;
        color: #ffb74d;
        outline: none;
      }
      .num-input {
        box-sizing: border-box;
        background: var(--sol-card);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        padding: 5px 8px;
        font-family: inherit;
        font-size: 12.5px;
        color: var(--sol-text);
        text-align: right;
        outline: none;
      }
      .unit-label {
        font-size: 11.5px;
        color: var(--sol-text-3);
      }
      .toggle-btn {
        border: none;
        cursor: pointer;
        border-radius: 12px;
        padding: 4px 12px;
        font-family: inherit;
        font-size: 11.5px;
        font-weight: 500;
      }
      .toggle-on {
        background: #3b4a52;
        color: var(--sol-blue);
      }
      .toggle-off {
        background: var(--sol-card);
        color: var(--sol-text-3);
      }
      .btn-reset {
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: var(--sol-card);
        color: var(--sol-text-3);
        border-radius: 6px;
        padding: 4px 10px;
        font-family: inherit;
        font-size: 11.5px;
        cursor: pointer;
      }
      .svg-wrap {
        position: relative;
        width: 100%;
        background: var(--sol-card);
        border-radius: 8px;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.05);
        user-select: none;
      }
      svg {
        display: block;
        width: 100%;
        height: auto;
      }
      .node-editor {
        display: flex;
        align-items: center;
        gap: 8px;
        background: rgba(0, 0, 0, 0.3);
        border-radius: 8px;
        padding: 5px 10px;
        margin-top: 8px;
      }
      .node-editor input {
        width: 60px;
        box-sizing: border-box;
        background: var(--sol-card);
        border: 1px solid rgba(255, 183, 77, 0.35);
        border-radius: 5px;
        padding: 3px 5px;
        text-align: center;
        font-size: 11.5px;
        color: var(--sol-text);
      }
      .btn-node-del {
        border: 1px solid rgba(239, 83, 80, 0.3);
        background: rgba(239, 83, 80, 0.1);
        color: #ef5350;
        border-radius: 5px;
        padding: 3px 8px;
        font-size: 11px;
        cursor: pointer;
        margin-left: auto;
      }
      .inputs-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 12px 16px;
      }
      .field-lbl {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 11.5px;
        color: var(--sol-text-2);
        margin-bottom: 5px;
      }
      .input-with-unit {
        display: flex;
        align-items: center;
        gap: 6px;
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("mousemove", this._onWindowMouseMove);
    window.addEventListener("mouseup", this._onWindowMouseUp);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("mousemove", this._onWindowMouseMove);
    window.removeEventListener("mouseup", this._onWindowMouseUp);
  }

  private findBedroom() {
    return this.snap?.rooms?.find(
      (r) => r.name.toLowerCase().includes("bed") || r.subentry_id.includes("bedroom")
    );
  }

  private getSunsetNodes(): NodeDef[] {
    if (this.localSunset) return this.localSunset;
    if (this.snap?.sunset_curve?.length) {
      return this.snap.sunset_curve.map((p) => ({ x: p.progress, y: p.level }));
    }
    return DEF_SUNSET;
  }

  private toSvgX(pct: number): number {
    return X0 + (Math.max(0, Math.min(100, pct)) / 100.0) * (X1 - X0);
  }

  private fromSvgX(px: number): number {
    return Math.max(0, Math.min(100, ((px - X0) / (X1 - X0)) * 100.0));
  }

  private toSvgY(lvl: number): number {
    return Y1 - (Math.max(0, Math.min(254, lvl)) / 254.0) * (Y1 - Y0);
  }

  private fromSvgY(py: number): number {
    return Math.max(0, Math.min(254, Math.round(((Y1 - py) / (Y1 - Y0)) * 254.0)));
  }

  private buildPath(nodes: NodeDef[]): string {
    if (!nodes.length) return "";
    const spline = new MonotoneSpline(nodes);
    const steps = 100;
    let d = "";
    for (let i = 0; i <= steps; i++) {
      const pct = (i / steps) * 100.0;
      const lvl = Math.max(0, Math.min(254, spline.evaluate(pct)));
      const px = this.toSvgX(pct);
      const py = this.toSvgY(lvl);
      d += i === 0 ? `M ${px.toFixed(1)} ${py.toFixed(1)}` : ` L ${px.toFixed(1)} ${py.toFixed(1)}`;
    }
    return d;
  }

  private buildArea(nodes: NodeDef[]): string {
    const linePath = this.buildPath(nodes);
    if (!linePath) return "";
    return `${linePath} L ${X1} ${Y1} L ${X0} ${Y1} Z`;
  }

  private _onWindowMouseMove = (e: MouseEvent) => {
    if (!this._drag) return;
    const svgEl = this.shadowRoot?.getElementById("svg-sunset-wind");
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (VW / rect.width);
    const py = (e.clientY - rect.top) * (VH / rect.height);
    const newX = Math.round(this.fromSvgX(px) * 10) / 10;
    const newY = this.fromSvgY(py);
    const nodes = [...this.getSunsetNodes()];
    const idx = this._drag.idx;
    const boundedX = idx === 0 ? 0 : idx === nodes.length - 1 ? 100 : Math.max(1, Math.min(99, newX));
    nodes[idx] = { x: boundedX, y: newY };
    this.localSunset = nodes;
    this.debounceSaveSunset();
  };

  private _onWindowMouseUp = () => {
    this._drag = null;
  };

  private handleSvgClick(e: MouseEvent) {
    const svgEl = this.shadowRoot?.getElementById("svg-sunset-wind");
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (VW / rect.width);
    const py = (e.clientY - rect.top) * (VH / rect.height);
    if (px < X0 || px > X1 || py < Y0 || py > Y1) return;
    const clickX = Math.round(this.fromSvgX(px));
    const clickY = this.fromSvgY(py);
    const nodes = [...this.getSunsetNodes()];
    const nearIdx = nodes.findIndex(
      (n) => Math.hypot(this.toSvgX(n.x) - px, this.toSvgY(n.y) - py) < 14
    );
    if (nearIdx !== -1) {
      this.selSunsetIdx = nearIdx;
      return;
    }
    nodes.push({ x: clickX, y: clickY });
    nodes.sort((a, b) => a.x - b.x);
    this.localSunset = nodes;
    this.selSunsetIdx = nodes.findIndex((n) => n.x === clickX);
    this.debounceSaveSunset();
  }

  private debounceSaveSunset() {
    window.clearTimeout(this._debounceTimer);
    this._debounceTimer = window.setTimeout(() => {
      if (this.localSunset) {
        setSunsetCurve(
          this.hass,
          this.localSunset.map((n) => ({ progress: n.x, level: n.y }))
        );
      }
    }, 250);
  }

  private resetSunset() {
    this.localSunset = DEF_SUNSET;
    this.selSunsetIdx = null;
    setSunsetCurve(
      this.hass,
      DEF_SUNSET.map((n) => ({ progress: n.x, level: n.y }))
    );
  }

  private deleteSunsetNode(idx: number) {
    const nodes = this.getSunsetNodes().filter((_, i) => i !== idx);
    if (nodes.length < 2) return;
    this.localSunset = nodes;
    this.selSunsetIdx = null;
    this.debounceSaveSunset();
  }

  private callLock(action: "lock" | "unlock") {
    this.hass?.callService("lock", action, { entity_id: LOCK_ENTITY });
  }

  private toggleAutoLockSleep() {
    if (!this.hass?.states?.[AUTO_LOCK_SLEEP_AUTO]) return;
    this.hass.callService("automation", "toggle", { entity_id: AUTO_LOCK_SLEEP_AUTO });
  }

  private startWatchCharge() {
    this.hass?.callService("script", "turn_on", {
      entity_id: "script.start_charge_cycle_from_button_data",
    });
  }

  render() {
    const house = this.snap?.house ?? {};
    const world = this.snap?.world;
    const music = this.snap?.music;
    const bed = this.findBedroom();
    const bedSettings = bed?.settings ?? {};

    const lockObj = this.hass?.states?.[LOCK_ENTITY];
    const lockState = lockObj?.state ?? "unavailable";
    const isLocked = lockState === "locked";
    const isJammed = lockState === "jammed";
    const lockBatt = this.hass?.states?.[LOCK_BATTERY]?.state;
    const autoLockSleepOn = this.hass?.states?.[AUTO_LOCK_SLEEP_AUTO]?.state !== "off";

    const sleepActive = !!world?.asleep;
    const nightLatched = !!world?.night_active;
    const phoneActive = !!world?.phone_dnd;
    const watchActive = !!world?.watch_bedtime;
    const manualSleep = !!world?.manual_sleep;

    const chargerWatts = parseFloat(this.hass?.states?.[CHARGER_POWER]?.state ?? "0");
    const defaultCutoff = parseFloat(
      this.hass?.states?.["input_number.charge_off_wattage"]?.state ?? "1.1"
    );
    const isCharging = chargerWatts > defaultCutoff;
    const audioPlaying = music?.state === "playing" || music?.state === "buffering";

    const setActive = bedSettings.sunset_enabled !== false;
    const dwellCapActive = (house.bedtime_dwell_enabled ?? 1) >= 0.5;
    const sunsetNodes = this.getSunsetNodes();
    const setProgress = world?.sunset_progress ?? null;
    const currentDemandLevel = Math.round(((world?.demand ?? 1.0) as number) * 254);
    const demandSvgY = this.toSvgY(currentDemandLevel);

    return html`
      <div class="grid">
        <!-- 1. Bedtime Checklist & Quick Controls -->
        <div class="card full-col">
          <div class="head">
            <ha-icon icon="mdi:weather-night" style="color: #ce93d8;"></ha-icon>
            <div class="title">Bedtime Checklist &amp; Controls</div>
            <sol-help
              text="One-glance pre-sleep verification: confirm the Aqara U200 front door deadbolt is locked, arm Sleep Mode, start the Pixel Watch charge cycle, and silence active Cast speakers."
            ></sol-help>
          </div>

          <div class="checklist-grid">
            <!-- Tile 1: Front Door U200 -->
            <div class="check-tile ${isLocked ? "ok" : "warn"}">
              <div class="tile-top">
                <ha-icon
                  icon=${isLocked ? "mdi:lock" : isJammed ? "mdi:lock-alert" : "mdi:lock-open-variant"}
                  style="color: ${isLocked ? "#81c784" : isJammed ? "#ef5350" : "#ffb74d"};"
                ></ha-icon>
                <span class="tile-name">Front Door (U200)</span>
                <span class="badge ${isLocked ? "badge-green" : isJammed ? "badge-red" : "badge-amber"}">
                  ${lockState.toUpperCase()}
                </span>
              </div>
              <div class="mini-meta">
                <span>Battery: <strong>${lockBatt && lockBatt !== "unavailable" ? `${lockBatt}%` : "—"}</strong></span>
                <span>Auto-lock on sleep: <strong>${autoLockSleepOn ? "ON" : "OFF"}</strong></span>
              </div>
              <div class="tile-actions">
                <button
                  class="act-btn ${!isLocked ? "primary" : ""}"
                  @click=${() => this.callLock(isLocked ? "unlock" : "lock")}
                >
                  <ha-icon icon=${isLocked ? "mdi:lock-open-outline" : "mdi:lock"}></ha-icon>
                  ${isLocked ? "Unlock Door" : "Lock Now"}
                </button>
                ${this.hass?.states?.[AUTO_LOCK_SLEEP_AUTO]
                  ? html`
                      <button class="act-btn" @click=${() => this.toggleAutoLockSleep()}>
                        Auto-Lock: ${autoLockSleepOn ? "On" : "Off"}
                      </button>
                    `
                  : nothing}
              </div>
            </div>

            <!-- Tile 2: Sleep Mode -->
            <div class="check-tile ${sleepActive || nightLatched ? "ok" : ""}">
              <div class="tile-top">
                <ha-icon icon="mdi:power-sleep" style="color: #ce93d8;"></ha-icon>
                <span class="tile-name">Sleep &amp; Night Latch</span>
                <span class="badge ${sleepActive ? "badge-amber" : nightLatched ? "badge-green" : "badge-dim"}">
                  ${sleepActive ? "ASLEEP" : nightLatched ? "NIGHT LATCHED" : "AWAKE"}
                </span>
              </div>
              <div class="mini-meta">
                <span>Phone DND: <strong>${phoneActive ? "On" : "Off"}</strong></span>
                <span>Watch: <strong>${watchActive ? "Bedtime" : "Off"}</strong></span>
              </div>
              <div class="tile-actions">
                <button
                  class="act-btn ${manualSleep ? "primary" : ""}"
                  @click=${() => toggleSleep(this.hass)}
                >
                  <ha-icon icon="mdi:weather-night"></ha-icon>
                  Sleep Switch: ${manualSleep ? "ON" : "OFF"}
                </button>
              </div>
            </div>

            <!-- Tile 3: Watch Charger -->
            <div class="check-tile ${isCharging ? "ok" : ""}">
              <div class="tile-top">
                <ha-icon icon="mdi:watch-variant" style="color: var(--sol-cyan);"></ha-icon>
                <span class="tile-name">Watch Charger</span>
                <span class="badge ${isCharging ? "badge-green" : "badge-dim"}">
                  ${isCharging ? `CHARGING ${chargerWatts.toFixed(1)}W` : "IDLE"}
                </span>
              </div>
              <div class="mini-meta">
                <span>Bedroom plug: <strong>${chargerWatts.toFixed(2)} W</strong></span>
                <span>Auto-cutoff: <strong>${defaultCutoff.toFixed(1)} W</strong></span>
              </div>
              <div class="tile-actions">
                <button class="act-btn cyan" @click=${() => this.startWatchCharge()}>
                  <ha-icon icon="mdi:flash"></ha-icon>
                  Start Charge Cycle
                </button>
              </div>
            </div>

            <!-- Tile 4: Speakers -->
            <div class="check-tile">
              <div class="tile-top">
                <ha-icon icon="mdi:speaker-multiple" style="color: var(--sol-text-2);"></ha-icon>
                <span class="tile-name">House Audio</span>
                <span class="badge ${audioPlaying ? "badge-amber" : "badge-dim"}">
                  ${audioPlaying ? "PLAYING" : "QUIET"}
                </span>
              </div>
              <div class="mini-meta">
                <span>${audioPlaying ? music?.active_playlist_name || "Cast active" : "All speakers idle"}</span>
              </div>
              <div class="tile-actions">
                <button class="act-btn" @click=${() => musicStop(this.hass)}>
                  <ha-icon icon="mdi:stop-circle-outline"></ha-icon>
                  Stop Speakers
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 2. Virtual Sunset Curve -->
        <div class="card full-col">
          <div class="head">
            <ha-icon icon="mdi:weather-sunset-down" style="color: #ff7043;"></ha-icon>
            <div class="title">Virtual Sunset Curve (Bedroom Wind-Down)</div>
            <sol-help
              text="Gradual bedroom wind-down after Window Start (HH:MM) once continuous bedroom occupancy reaches Bedroom Dwell. Smoothly fades along the spline over Fade Duration and holds at Aqara minimum (3/254) until Sleep Mode turns lights completely off."
            ></sol-help>
            <div class="spacer"></div>
            <button class="btn-reset" @click=${() => this.resetSunset()}>Reset Curve</button>
            <button
              class="toggle-btn ${setActive ? "toggle-on" : "toggle-off"}"
              style="margin-left: 6px;"
              @click=${() => {
                if (bed) setRoom(this.hass, bed.subentry_id, { sunset_enabled: !setActive });
              }}
            >
              ${setActive ? "Sunset: ON" : "Sunset: OFF"}
            </button>
          </div>

          <div class="curve-ctrl-bar">
            <div class="curve-metric">
              <span>Window start:</span>
              <sol-help
                text="Exact evening clock time (HH:MM) when bedroom wind-down evaluation arms."
              ></sol-help>
              <input
                type="time"
                class="time-input"
                .value=${clock(house.bedtime_dwell_hour ?? 22.0)}
                @change=${(e: Event) => {
                  const raw = (e.target as HTMLInputElement).value;
                  if (raw) setHouse(this.hass, { bedtime_dwell_hour: parseClock(raw) });
                }}
              />
            </div>

            <div class="curve-metric">
              <span>Bedroom dwell:</span>
              <input
                type="number"
                class="num-input"
                style="width: 58px;"
                min="1"
                max="60"
                .value=${String(house.sunset_dwell_minutes ?? 5)}
                @change=${(e: Event) => {
                  const v = parseFloat((e.target as HTMLInputElement).value);
                  if (!Number.isNaN(v)) setHouse(this.hass, { sunset_dwell_minutes: v });
                }}
              />
              <span class="unit-label">min</span>
            </div>

            <div class="curve-metric">
              <span>Fade duration:</span>
              <input
                type="number"
                class="num-input"
                style="width: 58px;"
                min="5"
                max="90"
                .value=${String(house.sunset_fade_minutes ?? 20)}
                @change=${(e: Event) => {
                  const v = parseFloat((e.target as HTMLInputElement).value);
                  if (!Number.isNaN(v)) setHouse(this.hass, { sunset_fade_minutes: v });
                }}
              />
              <span class="unit-label">min</span>
            </div>

            <div class="curve-metric" style="margin-left: auto;">
              <span>Demand Ceiling:</span>
              <strong style="color: var(--sol-cyan);">${currentDemandLevel} lvl / 254</strong>
            </div>
            ${this.hoverSunset
              ? html`
                  <div class="curve-metric">
                    <span>Progress: <strong>${this.hoverSunset.x}%</strong></span>
                    <span>Level: <strong>${this.hoverSunset.y} lvl</strong></span>
                  </div>
                `
              : nothing}
          </div>

          <div class="svg-wrap">
            <svg
              id="svg-sunset-wind"
              viewBox="0 0 ${VW} ${VH}"
              @click=${(e: MouseEvent) => this.handleSvgClick(e)}
              @mousemove=${(e: MouseEvent) => {
                const target = e.currentTarget as SVGSVGElement | null;
                if (!target) return;
                const rect = target.getBoundingClientRect();
                const px = (e.clientX - rect.left) * (VW / rect.width);
                const py = (e.clientY - rect.top) * (VH / rect.height);
                if (px >= X0 && px <= X1 && py >= Y0 && py <= Y1) {
                  this.hoverSunset = {
                    x: Math.round(this.fromSvgX(px)),
                    y: this.fromSvgY(py),
                  };
                } else {
                  this.hoverSunset = null;
                }
              }}
              @mouseleave=${() => (this.hoverSunset = null)}
            >
              <defs>
                <linearGradient id="grad-sunset-wind" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#ff7043" stop-opacity="0.32" />
                  <stop offset="100%" stop-color="#ff7043" stop-opacity="0.02" />
                </linearGradient>
              </defs>

              ${[0, 25, 50, 75, 100].map((pct) => {
                const x = this.toSvgX(pct);
                return svg`
                  <line x1="${x}" y1="${Y0}" x2="${x}" y2="${Y1}" stroke="rgba(255,255,255,0.06)" stroke-width="1" />
                  <text x="${x}" y="${VH - 6}" fill="var(--sol-text-4)" font-size="10" text-anchor="middle">${pct}%</text>
                `;
              })}
              ${[0, 64, 128, 192, 254].map((lvl) => {
                const y = this.toSvgY(lvl);
                return svg`
                  <line x1="${X0}" y1="${y}" x2="${X1}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1" />
                  <text x="${X0 - 8}" y="${y + 3}" fill="var(--sol-text-4)" font-size="9.5" text-anchor="end">${lvl}</text>
                `;
              })}

              <line
                x1="${X0}"
                y1="${demandSvgY}"
                x2="${X1}"
                y2="${demandSvgY}"
                stroke="var(--sol-cyan)"
                stroke-width="1.5"
                stroke-dasharray="4,4"
                opacity="0.75"
              />
              <text x="${X1 - 4}" y="${demandSvgY - 5}" fill="var(--sol-cyan)" font-size="9" text-anchor="end">Demand Cap</text>

              <path d="${this.buildArea(sunsetNodes)}" fill="url(#grad-sunset-wind)" />
              <path d="${this.buildPath(sunsetNodes)}" fill="none" stroke="#ff7043" stroke-width="2.5" />

              ${setProgress !== null && setProgress !== undefined
                ? svg`
                    <circle
                      cx="${this.toSvgX(setProgress * 100)}"
                      cy="${this.toSvgY(new MonotoneSpline(sunsetNodes).evaluate(setProgress * 100))}"
                      r="7"
                      fill="#ff7043"
                      stroke="#fff"
                      stroke-width="2"
                    />
                  `
                : nothing}

              ${sunsetNodes.map((n, idx) => {
                const cx = this.toSvgX(n.x);
                const cy = this.toSvgY(n.y);
                const isSel = this.selSunsetIdx === idx;
                return svg`
                  <circle
                    cx="${cx}"
                    cy="${cy}"
                    r="${isSel ? 7.5 : 5.5}"
                    fill="${isSel ? "#fff" : "#ff7043"}"
                    stroke="${isSel ? "#ff7043" : "rgba(0,0,0,0.6)"}"
                    stroke-width="2"
                    style="cursor: grab;"
                    @mousedown=${(e: MouseEvent) => {
                      e.stopPropagation();
                      this.selSunsetIdx = idx;
                      this._drag = { idx };
                    }}
                  />
                `;
              })}
            </svg>
          </div>

          ${this.selSunsetIdx !== null && sunsetNodes[this.selSunsetIdx]
            ? html`
                <div class="node-editor">
                  <span style="font-size: 11.5px; color: var(--sol-text-3);">Node:</span>
                  <span style="font-size: 11.5px; color: var(--sol-text-2);">Progress %</span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    .value=${String(sunsetNodes[this.selSunsetIdx].x)}
                    ?disabled=${this.selSunsetIdx === 0 || this.selSunsetIdx === sunsetNodes.length - 1}
                    @change=${(e: Event) => {
                      const v = Math.max(0, Math.min(100, parseFloat((e.target as HTMLInputElement).value)));
                      const nodes = [...sunsetNodes];
                      nodes[this.selSunsetIdx!] = { ...nodes[this.selSunsetIdx!], x: v };
                      nodes.sort((a, b) => a.x - b.x);
                      this.localSunset = nodes;
                      this.debounceSaveSunset();
                    }}
                  />
                  <span style="font-size: 11.5px; color: var(--sol-text-2); margin-left: 6px;">Level (0-254)</span>
                  <input
                    type="number"
                    min="0"
                    max="254"
                    .value=${String(sunsetNodes[this.selSunsetIdx].y)}
                    @change=${(e: Event) => {
                      const v = Math.max(0, Math.min(254, parseInt((e.target as HTMLInputElement).value, 10)));
                      const nodes = [...sunsetNodes];
                      nodes[this.selSunsetIdx!] = { ...nodes[this.selSunsetIdx!], y: v };
                      this.localSunset = nodes;
                      this.debounceSaveSunset();
                    }}
                  />
                  ${this.selSunsetIdx > 0 && this.selSunsetIdx < sunsetNodes.length - 1
                    ? html`
                        <button class="btn-node-del" @click=${() => this.deleteSunsetNode(this.selSunsetIdx!)}>
                          Delete node
                        </button>
                      `
                    : nothing}
                </div>
              `
            : nothing}
        </div>

        <!-- 3. Bedtime Dwell Cap & Night Corridor -->
        <div class="card full-col">
          <div class="head">
            <ha-icon icon="mdi:lamp-outline" style="color: var(--sol-amber);"></ha-icon>
            <div class="title">Bedtime Dwell Cap &amp; Night Corridor Floor</div>
            <div class="spacer"></div>
            <button
              class="toggle-btn ${dwellCapActive ? "toggle-on" : "toggle-off"}"
              @click=${() => setHouse(this.hass, { bedtime_dwell_enabled: dwellCapActive ? 0 : 1 })}
            >
              ${dwellCapActive ? "Bedtime Cap: ON" : "Bedtime Cap: OFF"}
            </button>
          </div>

          <div class="inputs-grid">
            <div>
              <div class="field-lbl">
                Bedtime dwell cap level
                <sol-help text="Brightness ceiling applied once Bedroom occupancy exceeds Bedtime Dwell minutes after Window Start."></sol-help>
              </div>
              <div class="input-with-unit">
                <input
                  type="number"
                  class="num-input"
                  style="flex: 1;"
                  min="1"
                  max="120"
                  .value=${String(house.bedtime_dwell_level ?? 15)}
                  @change=${(e: Event) => {
                    const v = parseFloat((e.target as HTMLInputElement).value);
                    if (!Number.isNaN(v)) setHouse(this.hass, { bedtime_dwell_level: v });
                  }}
                />
                <span class="unit-label">/ 254</span>
              </div>
            </div>

            <div>
              <div class="field-lbl">
                Night corridor level
                <sol-help text="Safe low-glare navigation brightness (including Stairway and 3 AM trips) while Night Latch is active."></sol-help>
              </div>
              <div class="input-with-unit">
                <input
                  type="number"
                  class="num-input"
                  style="flex: 1;"
                  min="1"
                  max="120"
                  .value=${String(house.night_level ?? 26)}
                  @change=${(e: Event) => {
                    const v = parseFloat((e.target as HTMLInputElement).value);
                    if (!Number.isNaN(v)) setHouse(this.hass, { night_level: v });
                  }}
                />
                <span class="unit-label">/ 254</span>
              </div>
            </div>

            <div>
              <div class="field-lbl">
                Night colour temperature
                <sol-help text="Warm amber Kelvin target held overnight until Dawn Release."></sol-help>
              </div>
              <div class="input-with-unit">
                <input
                  type="number"
                  class="num-input"
                  style="flex: 1;"
                  min="2000"
                  max="4000"
                  step="50"
                  .value=${String(num(house.night_kelvin ?? 2190).replace(/,/g, ""))}
                  @change=${(e: Event) => {
                    const v = parseFloat((e.target as HTMLInputElement).value);
                    if (!Number.isNaN(v)) setHouse(this.hass, { night_kelvin: v });
                  }}
                />
                <span class="unit-label">K</span>
              </div>
            </div>

            <div>
              <div class="field-lbl">
                Dawn release time &amp; lux
                <sol-help text="Earliest morning time (HH:MM) and outdoor lux threshold where Night Latch clears back to Normal Mode."></sol-help>
              </div>
              <div class="input-with-unit">
                <input
                  type="time"
                  class="time-input"
                  .value=${clock(house.morning_release_hour ?? 6.5)}
                  @change=${(e: Event) => {
                    const raw = (e.target as HTMLInputElement).value;
                    if (raw) setHouse(this.hass, { morning_release_hour: parseClock(raw) });
                  }}
                />
                <input
                  type="number"
                  class="num-input"
                  style="width: 64px;"
                  min="1"
                  max="500"
                  .value=${String(house.night_release_lux ?? 10)}
                  @change=${(e: Event) => {
                    const v = parseFloat((e.target as HTMLInputElement).value);
                    if (!Number.isNaN(v)) setHouse(this.hass, { night_release_lux: v });
                  }}
                />
                <span class="unit-label">lx</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-tab-winddown": SolTabWinddown;
  }
}
