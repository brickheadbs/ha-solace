/**
 * Settings & Modes Tab — Bedroom Special Modes (Sleep, Virtual Sunrise & Sunset Spline Curves),
 * Housewide Night Mode, and 8-path Transitions Matrix.
 */

import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Hass, Snapshot } from "./api";
import { setHouse, setRoom, setSunriseCurve, setSunsetCurve, toggleSleep } from "./api";
import { MonotoneSpline } from "./spline";
import { tokens } from "./tokens";
import "./ui";

interface NodeDef {
  x: number; // 0..100 (%)
  y: number; // 0..254 (level)
}

const DEF_SUNRISE: NodeDef[] = [
  { x: 0, y: 0 },
  { x: 30, y: 15 },
  { x: 70, y: 90 },
  { x: 100, y: 180 },
];

const DEF_SUNSET: NodeDef[] = [
  { x: 0, y: 180 },
  { x: 30, y: 120 },
  { x: 70, y: 40 },
  { x: 100, y: 0 },
];

const X0 = 48;
const X1 = 762;
const Y0 = 14;
const Y1 = 206;
const VW = 780;
const VH = 230;

@customElement("sol-tab-settings")
export class SolTabSettings extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;

  // Local editable curves for responsive dragging
  @state() private localSunrise: NodeDef[] | null = null;
  @state() private localSunset: NodeDef[] | null = null;

  @state() private selSunriseIdx: number | null = null;
  @state() private selSunsetIdx: number | null = null;

  @state() private hoverSunrise: { x: number; y: number } | null = null;
  @state() private hoverSunset: { x: number; y: number } | null = null;

  private _drag: { type: "sunrise" | "sunset"; idx: number } | null = null;
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
      .bed-grid {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .bed-card {
        background: var(--sol-control);
        border-radius: 10px;
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
      }
      .bed-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .bed-title {
        font-size: 14px;
        font-weight: 500;
        color: var(--sol-text);
      }
      .triggers-bar {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        margin: 8px 0 12px;
        padding: 9px 12px;
        background: rgba(0, 0, 0, 0.25);
        border-radius: 8px;
      }
      .trigger-item {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 5px 10px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 6px;
        font-size: 12px;
        color: var(--sol-text-3);
        transition: all 0.2s ease;
      }
      .trigger-item.active {
        background: rgba(255, 183, 77, 0.16);
        border-color: rgba(255, 183, 77, 0.35);
        color: #ffb74d;
      }
      .trigger-item.active ha-icon {
        color: #ffb74d;
      }
      .trigger-item ha-icon {
        --mdc-icon-size: 16px;
        color: var(--sol-text-4);
      }
      .manual-sleep-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border-radius: 6px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: var(--sol-card);
        color: var(--sol-text-2);
        font: 500 12px Roboto, sans-serif;
        cursor: pointer;
        transition: all 0.15s ease;
        margin-left: auto;
      }
      .manual-sleep-btn:hover {
        background: var(--sol-card-high);
        color: var(--sol-text);
      }
      .manual-sleep-btn.active {
        background: rgba(255, 183, 77, 0.22);
        border-color: #ffb74d;
        color: #ffb74d;
      }
      .manual-sleep-btn.active ha-icon {
        color: #ffb74d;
      }
      .sleep-inputs-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px 18px;
        margin-top: auto;
        padding-top: 10px;
        border-top: 1px solid rgba(255, 255, 255, 0.07);
      }
      .input-with-unit {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .unit-label {
        font-size: 11.5px;
        color: var(--sol-text-3);
        white-space: nowrap;
      }
      .badge {
        display: inline-block;
        padding: 3px 8px;
        border-radius: 5px;
        font: 500 11px Roboto, sans-serif;
      }
      .badge-amber {
        background: rgba(255, 183, 77, 0.18);
        color: #ffb74d;
      }
      .badge-dim {
        background: rgba(255, 255, 255, 0.06);
        color: var(--sol-text-3);
      }
      .toggle-btn {
        border: none;
        cursor: pointer;
        border-radius: 12px;
        padding: 4px 11px;
        font: 500 11.5px Roboto, sans-serif;
        transition: background 0.15s;
      }
      .toggle-on {
        background: #3b4a52;
        color: var(--sol-blue);
      }
      .toggle-off {
        background: var(--sol-card);
        color: var(--sol-text-3);
      }
      .num-input {
        box-sizing: border-box;
        background: var(--sol-card);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        padding: 5px 8px;
        font: 12.5px Roboto, sans-serif;
        color: var(--sol-text);
        text-align: right;
        outline: none;
      }
      .num-input:focus {
        border-color: var(--sol-blue);
      }
      .curve-ctrl-bar {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        margin: 6px 0 10px;
        padding: 8px 12px;
        background: rgba(0, 0, 0, 0.2);
        border-radius: 8px;
      }
      .curve-metric {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--sol-text-2);
      }
      .curve-metric strong {
        color: var(--sol-text);
      }
      .btn-reset {
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: var(--sol-card);
        color: var(--sol-text-3);
        border-radius: 6px;
        padding: 3px 8px;
        font: 500 11px Roboto, sans-serif;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .btn-reset:hover {
        background: var(--sol-card-high);
        color: var(--sol-text);
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
        outline: none;
      }
      .btn-node-del {
        border: 1px solid rgba(239, 83, 80, 0.3);
        background: rgba(239, 83, 80, 0.1);
        color: #ef5350;
        border-radius: 5px;
        padding: 3px 8px;
        font: 500 11px Roboto, sans-serif;
        cursor: pointer;
        margin-left: auto;
      }
      .btn-node-del:hover {
        background: rgba(239, 83, 80, 0.25);
      }

      /* Transitions Matrix styling */
      .trans-grp {
        background: var(--sol-control);
        border-radius: 8px;
        padding: 12px 14px;
      }
      .grp-lbl {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        font-weight: 700;
        color: var(--sol-text-3);
        margin-bottom: 7px;
      }
      .trans-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 7px;
        cursor: help;
        transition: opacity 0.15s ease;
      }
      .trans-row:hover .trans-lbl {
        color: var(--sol-text);
      }
      .trans-row:hover .trans-path {
        color: var(--sol-blue);
        background: rgba(86, 182, 194, 0.15);
      }
      .trans-lbl {
        font-size: 12.5px;
        color: var(--sol-text-2);
        min-width: 0;
        white-space: nowrap;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .trans-dots {
        flex: 1;
        border-bottom: 1px dotted rgba(255, 255, 255, 0.12);
        height: 1px;
      }
      .trans-path {
        font-size: 10.5px;
        color: var(--sol-text-4);
        background: rgba(255, 255, 255, 0.04);
        padding: 1px 6px;
        border-radius: 4px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        transition: all 0.15s ease;
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

  // --- Node Retrieval & Coordinate Transforms ---------------------------------

  private getSunriseNodes(): NodeDef[] {
    if (this.localSunrise) return this.localSunrise;
    if (this.snap?.sunrise_curve?.length) {
      return this.snap.sunrise_curve.map((p) => ({ x: p.progress, y: p.level }));
    }
    return DEF_SUNRISE;
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

  // --- Spline Path Generation -------------------------------------------------

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

  // --- Interaction & Saving ---------------------------------------------------

  private _onWindowMouseMove = (e: MouseEvent) => {
    if (!this._drag) return;
    const svgEl = this.shadowRoot?.getElementById(`svg-${this._drag.type}`);
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const scaleX = VW / rect.width;
    const scaleY = VH / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;

    const newX = Math.round(this.fromSvgX(px) * 10) / 10;
    const newY = this.fromSvgY(py);

    if (this._drag.type === "sunrise") {
      const nodes = [...this.getSunriseNodes()];
      const idx = this._drag.idx;
      // Anchor endpoints at 0% and 100%
      const boundedX = idx === 0 ? 0 : idx === nodes.length - 1 ? 100 : Math.max(1, Math.min(99, newX));
      nodes[idx] = { x: boundedX, y: newY };
      this.localSunrise = nodes;
      this.debounceSaveSunrise();
    } else {
      const nodes = [...this.getSunsetNodes()];
      const idx = this._drag.idx;
      const boundedX = idx === 0 ? 0 : idx === nodes.length - 1 ? 100 : Math.max(1, Math.min(99, newX));
      nodes[idx] = { x: boundedX, y: newY };
      this.localSunset = nodes;
      this.debounceSaveSunset();
    }
  };

  private _onWindowMouseUp = () => {
    if (this._drag) {
      this._drag = null;
    }
  };

  private handleSvgClick(type: "sunrise" | "sunset", e: MouseEvent) {
    const svgEl = this.shadowRoot?.getElementById(`svg-${type}`);
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const scaleX = VW / rect.width;
    const scaleY = VH / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;

    if (px < X0 || px > X1 || py < Y0 || py > Y1) return;

    const clickX = Math.round(this.fromSvgX(px));
    const clickY = this.fromSvgY(py);

    if (type === "sunrise") {
      const nodes = [...this.getSunriseNodes()];
      // Check if near existing node
      const nearIdx = nodes.findIndex((n) => Math.hypot(this.toSvgX(n.x) - px, this.toSvgY(n.y) - py) < 14);
      if (nearIdx !== -1) {
        this.selSunriseIdx = nearIdx;
        return;
      }
      // Add node
      nodes.push({ x: clickX, y: clickY });
      nodes.sort((a, b) => a.x - b.x);
      this.localSunrise = nodes;
      this.selSunriseIdx = nodes.findIndex((n) => n.x === clickX);
      this.debounceSaveSunrise();
    } else {
      const nodes = [...this.getSunsetNodes()];
      const nearIdx = nodes.findIndex((n) => Math.hypot(this.toSvgX(n.x) - px, this.toSvgY(n.y) - py) < 14);
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
  }

  private debounceSaveSunrise() {
    window.clearTimeout(this._debounceTimer);
    this._debounceTimer = window.setTimeout(() => {
      if (this.localSunrise) {
        setSunriseCurve(
          this.hass,
          this.localSunrise.map((n) => ({ progress: n.x, level: n.y }))
        );
      }
    }, 250);
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

  private resetSunrise() {
    this.localSunrise = DEF_SUNRISE;
    this.selSunriseIdx = null;
    setSunriseCurve(
      this.hass,
      DEF_SUNRISE.map((n) => ({ progress: n.x, level: n.y }))
    );
  }

  private resetSunset() {
    this.localSunset = DEF_SUNSET;
    this.selSunsetIdx = null;
    setSunsetCurve(
      this.hass,
      DEF_SUNSET.map((n) => ({ progress: n.x, level: n.y }))
    );
  }

  private deleteSunriseNode(idx: number) {
    const nodes = this.getSunriseNodes().filter((_, i) => i !== idx);
    if (nodes.length < 2) return;
    this.localSunrise = nodes;
    this.selSunriseIdx = null;
    this.debounceSaveSunrise();
  }

  private deleteSunsetNode(idx: number) {
    const nodes = this.getSunsetNodes().filter((_, i) => i !== idx);
    if (nodes.length < 2) return;
    this.localSunset = nodes;
    this.selSunsetIdx = null;
    this.debounceSaveSunset();
  }

  // --- Render -----------------------------------------------------------------

  render() {
    const house = this.snap?.house ?? {};
    const bed = this.findBedroom();
    const bedSettings = bed?.settings ?? {};

    const world = this.snap?.world;
    const sleepActive = !!world?.asleep;
    const phoneActive = !!world?.phone_dnd;
    const watchActive = !!world?.watch_bedtime;
    const manualActive = !!world?.manual_sleep;

    const riseActive = !!bedSettings.sunrise_enabled;
    const setActive = !!bedSettings.sunset_enabled;

    const currentDemandLevel = Math.round(((world?.demand ?? 1.0) as number) * 254);
    const demandSvgY = this.toSvgY(currentDemandLevel);

    const sunriseNodes = this.getSunriseNodes();
    const sunsetNodes = this.getSunsetNodes();

    const riseProgress = world?.sunrise_progress ?? null;
    const setProgress = world?.sunset_progress ?? null;

    return html`
      <div class="grid">
        <!-- 1. Bedroom Special Modes -->
        <div class="card full-col">
          <div class="head">
            <ha-icon icon="mdi:bed-outline" style="color: var(--sol-blue);"></ha-icon>
            <div class="title">Bedroom special modes</div>
          </div>
          <div class="bed-grid">
            <!-- Mode 1: Sleep -->
            <div class="bed-card">
              <div class="bed-head">
                <ha-icon icon="mdi:weather-night" style="color: var(--sol-amber);"></ha-icon>
                <div class="bed-title">1 · Sleep mode</div>
                <sol-help text="Forces bedroom lights to dark even during a 04:30 summer sunrise or daytime nap. Triggered by Phone DND, Watch Bedtime, or manual sleep switch. Unlatches automatically when Virtual Sunrise begins or upon dawn outdoor daylight."></sol-help>
                <div class="spacer"></div>
                <div class="badge ${sleepActive ? "badge-amber" : "badge-dim"}">
                  ${sleepActive ? "Asleep (Night active)" : "Awake (Standby)"}
                </div>
              </div>

              <!-- Triggers Status Bar -->
              <div class="triggers-bar">
                <div class="trigger-item ${phoneActive ? "active" : ""}">
                  <ha-icon icon="mdi:cellphone"></ha-icon>
                  <span>Phone DND: <strong>${phoneActive ? "Priority Only" : "Off"}</strong></span>
                </div>
                <div class="trigger-item ${watchActive ? "active" : ""}">
                  <ha-icon icon="mdi:watch-variant"></ha-icon>
                  <span>Pixel Watch: <strong>${watchActive ? "Bedtime Mode" : "Off"}</strong></span>
                </div>
                <button
                  class="manual-sleep-btn ${manualActive ? "active" : ""}"
                  @click="${() => toggleSleep(this.hass)}"
                  title="Toggle manual sleep helper"
                >
                  <ha-icon icon="mdi:power-sleep"></ha-icon>
                  <span>Manual Switch: <strong>${manualActive ? "ON" : "OFF"}</strong></span>
                </button>
              </div>

              <!-- Dawn Release Setting -->
              <div class="sleep-inputs-grid">
                <div>
                  <div style="display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">
                    <ha-icon icon="mdi:weather-sunset-up" style="--mdc-icon-size: 14px; color: var(--sol-amber);"></ha-icon>
                    Release lux (dawn unlatch)
                    <sol-help text="Outdoor light level at which sleep mode automatically unlatches so daytime lighting takes over seamlessly."></sol-help>
                  </div>
                  <div class="input-with-unit">
                    <input
                      type="number"
                      class="num-input"
                      style="flex: 1;"
                      .value="${String(house.night_release_lux ?? 10)}"
                      @change="${(e: Event) => {
                        const v = parseFloat((e.target as HTMLInputElement).value);
                        setHouse(this.hass, { night_release_lux: v });
                      }}"
                    />
                    <span class="unit-label">lx</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- Mode 2: Virtual Sunrise Spline Curve -->
            <div class="bed-card">
              <div class="bed-head">
                <ha-icon icon="mdi:weather-sunset-up" style="color: var(--sol-amber);"></ha-icon>
                <div class="bed-title">2 · Virtual sunrise curve</div>
                <sol-help text="Gradual morning fade up before alarm. Output is dynamically clamped to Master Demand so electric lights never exceed natural ambient daylight needs."></sol-help>
                <div class="spacer"></div>
                <button class="btn-reset" @click="${() => this.resetSunrise()}">Reset</button>
                <button
                  class="toggle-btn ${riseActive ? "toggle-on" : "toggle-off"}"
                  style="margin-left: 6px;"
                  @click="${() => {
                    if (bed) setRoom(this.hass, bed.subentry_id, { sunrise_enabled: !riseActive });
                  }}"
                >
                  ${riseActive ? "On" : "Off"}
                </button>
              </div>

              <!-- Controls & Readouts -->
              <div class="curve-ctrl-bar">
                <div class="curve-metric">
                  <span>Fade duration:</span>
                  <div class="input-with-unit">
                    <input
                      type="number"
                      class="num-input"
                      style="width: 58px;"
                      .value="${String(house.sunrise_fade_minutes ?? 30)}"
                      @change="${(e: Event) => {
                        const v = parseFloat((e.target as HTMLInputElement).value);
                        setHouse(this.hass, { sunrise_fade_minutes: v });
                      }}"
                    />
                    <span class="unit-label">min</span>
                  </div>
                </div>
                <div class="curve-metric" style="margin-left: auto;">
                  <span>Demand Ceiling:</span>
                  <strong style="color: var(--sol-cyan);">${currentDemandLevel} lvl / 254</strong>
                </div>
                ${this.hoverSunrise
                  ? html`
                      <div class="curve-metric">
                        <span>Progress: <strong>${this.hoverSunrise.x}%</strong></span>
                        <span>Level: <strong>${this.hoverSunrise.y} lvl</strong></span>
                      </div>
                    `
                  : nothing}
              </div>

              <!-- Interactive SVG Canvas -->
              <div class="svg-wrap">
                <svg
                  id="svg-sunrise"
                  viewBox="0 0 ${VW} ${VH}"
                  @click="${(e: MouseEvent) => this.handleSvgClick("sunrise", e)}"
                  @mousemove="${(e: MouseEvent) => {
                    const target = e.currentTarget as SVGSVGElement | null;
                    if (!target) return;
                    const rect = target.getBoundingClientRect();
                    const px = (e.clientX - rect.left) * (VW / rect.width);
                    const py = (e.clientY - rect.top) * (VH / rect.height);
                    if (px >= X0 && px <= X1 && py >= Y0 && py <= Y1) {
                      this.hoverSunrise = {
                        x: Math.round(this.fromSvgX(px)),
                        y: this.fromSvgY(py),
                      };
                    } else {
                      this.hoverSunrise = null;
                    }
                  }}"
                  @mouseleave="${() => (this.hoverSunrise = null)}"
                >
                  <defs>
                    <linearGradient id="grad-sunrise" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stop-color="#ffb74d" stop-opacity="0.32" />
                      <stop offset="100%" stop-color="#ffb74d" stop-opacity="0.02" />
                    </linearGradient>
                  </defs>

                  <!-- Grid Lines & Labels -->
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

                  <!-- Master Demand Ceiling Line -->
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

                  <!-- Spline Area & Curve Stroke -->
                  <path d="${this.buildArea(sunriseNodes)}" fill="url(#grad-sunrise)" />
                  <path d="${this.buildPath(sunriseNodes)}" fill="none" stroke="#ffb74d" stroke-width="2.5" />

                  <!-- Live Progress Indicator -->
                  ${riseProgress !== null
                    ? svg`
                        <line
                          x1="${this.toSvgX(riseProgress * 100)}"
                          y1="${Y0}"
                          x2="${this.toSvgX(riseProgress * 100)}"
                          y2="${Y1}"
                          stroke="#ffffff"
                          stroke-width="2"
                        />
                      `
                    : nothing}

                  <!-- Interactive Draggable Control Nodes -->
                  ${sunriseNodes.map((n, i) => {
                    const cx = this.toSvgX(n.x);
                    const cy = this.toSvgY(n.y);
                    const isSelected = this.selSunriseIdx === i;
                    return svg`
                      <circle
                        cx="${cx}"
                        cy="${cy}"
                        r="${isSelected ? 7 : 5.5}"
                        fill="${isSelected ? "#ffffff" : "#ffb74d"}"
                        stroke="#1a1c1e"
                        stroke-width="2"
                        style="cursor: grab;"
                        @mousedown="${(e: MouseEvent) => {
                          e.stopPropagation();
                          this._drag = { type: "sunrise", idx: i };
                          this.selSunriseIdx = i;
                        }}"
                      />
                    `;
                  })}
                </svg>
              </div>

              <!-- Node Editor Toolbar -->
              ${this.selSunriseIdx !== null && sunriseNodes[this.selSunriseIdx]
                ? html`
                    <div class="node-editor">
                      <span style="font-size: 11.5px; color: var(--sol-text-3);">Node ${this.selSunriseIdx + 1}</span>
                      <span style="font-size: 11.5px; color: var(--sol-text-2); margin-left: 10px;">Progress (%)</span>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        disabled="${this.selSunriseIdx === 0 || this.selSunriseIdx === sunriseNodes.length - 1}"
                        .value="${String(sunriseNodes[this.selSunriseIdx].x)}"
                        @change="${(e: Event) => {
                          const v = Math.max(0, Math.min(100, parseFloat((e.target as HTMLInputElement).value)));
                          const nodes = [...sunriseNodes];
                          nodes[this.selSunriseIdx!] = { ...nodes[this.selSunriseIdx!], x: v };
                          nodes.sort((a, b) => a.x - b.x);
                          this.localSunrise = nodes;
                          this.debounceSaveSunrise();
                        }}"
                      />
                      <span style="font-size: 11.5px; color: var(--sol-text-2); margin-left: 6px;">Level (0-254 lvl)</span>
                      <input
                        type="number"
                        min="0"
                        max="254"
                        .value="${String(sunriseNodes[this.selSunriseIdx].y)}"
                        @change="${(e: Event) => {
                          const v = Math.max(0, Math.min(254, parseInt((e.target as HTMLInputElement).value, 10)));
                          const nodes = [...sunriseNodes];
                          nodes[this.selSunriseIdx!] = { ...nodes[this.selSunriseIdx!], y: v };
                          this.localSunrise = nodes;
                          this.debounceSaveSunrise();
                        }}"
                      />
                      ${this.selSunriseIdx > 0 && this.selSunriseIdx < sunriseNodes.length - 1
                        ? html`
                            <button class="btn-node-del" @click="${() => this.deleteSunriseNode(this.selSunriseIdx!)}">
                              Delete node
                            </button>
                          `
                        : nothing}
                    </div>
                  `
                : nothing}
            </div>

            <!-- Mode 3: Virtual Sunset Spline Curve -->
            <div class="bed-card">
              <div class="bed-head">
                <ha-icon icon="mdi:weather-sunset-down" style="color: var(--sol-amber);"></ha-icon>
                <div class="bed-title">3 · Virtual sunset curve</div>
                <sol-help text="Fades down toward dark before bedtime. Dynamically clamped to Master Demand so it fades naturally into the evening background."></sol-help>
                <div class="spacer"></div>
                <button class="btn-reset" @click="${() => this.resetSunset()}">Reset</button>
                <button
                  class="toggle-btn ${setActive ? "toggle-on" : "toggle-off"}"
                  style="margin-left: 6px;"
                  @click="${() => {
                    if (bed) setRoom(this.hass, bed.subentry_id, { sunset_enabled: !setActive });
                  }}"
                >
                  ${setActive ? "On" : "Off"}
                </button>
              </div>

              <!-- Controls & Readouts -->
              <div class="curve-ctrl-bar">
                <div class="curve-metric">
                  <span>Window start:</span>
                  <div class="input-with-unit">
                    <input
                      type="number"
                      step="0.25"
                      class="num-input"
                      style="width: 62px;"
                      .value="${String(house.bedtime_dwell_hour ?? 22.0)}"
                      @change="${(e: Event) => {
                        const v = parseFloat((e.target as HTMLInputElement).value);
                        setHouse(this.hass, { bedtime_dwell_hour: v });
                      }}"
                    />
                    <span class="unit-label">h</span>
                  </div>
                </div>
                <div class="curve-metric">
                  <span>Bedroom dwell:</span>
                  <div class="input-with-unit">
                    <input
                      type="number"
                      class="num-input"
                      style="width: 54px;"
                      .value="${String(house.sunset_dwell_minutes ?? 5)}"
                      @change="${(e: Event) => {
                        const v = parseFloat((e.target as HTMLInputElement).value);
                        setHouse(this.hass, { sunset_dwell_minutes: v });
                      }}"
                    />
                    <span class="unit-label">min</span>
                  </div>
                </div>
                <div class="curve-metric">
                  <span>Fade duration:</span>
                  <div class="input-with-unit">
                    <input
                      type="number"
                      class="num-input"
                      style="width: 54px;"
                      .value="${String(house.sunset_fade_minutes ?? 20)}"
                      @change="${(e: Event) => {
                        const v = parseFloat((e.target as HTMLInputElement).value);
                        setHouse(this.hass, { sunset_fade_minutes: v });
                      }}"
                    />
                    <span class="unit-label">min</span>
                  </div>
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

              <!-- Interactive SVG Canvas -->
              <div class="svg-wrap">
                <svg
                  id="svg-sunset"
                  viewBox="0 0 ${VW} ${VH}"
                  @click="${(e: MouseEvent) => this.handleSvgClick("sunset", e)}"
                  @mousemove="${(e: MouseEvent) => {
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
                  }}"
                  @mouseleave="${() => (this.hoverSunset = null)}"
                >
                  <defs>
                    <linearGradient id="grad-sunset" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stop-color="#ff7043" stop-opacity="0.32" />
                      <stop offset="100%" stop-color="#ff7043" stop-opacity="0.02" />
                    </linearGradient>
                  </defs>

                  <!-- Grid Lines & Labels -->
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

                  <!-- Master Demand Ceiling Line -->
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

                  <!-- Spline Area & Curve Stroke -->
                  <path d="${this.buildArea(sunsetNodes)}" fill="url(#grad-sunset)" />
                  <path d="${this.buildPath(sunsetNodes)}" fill="none" stroke="#ff7043" stroke-width="2.5" />

                  <!-- Live Progress Indicator -->
                  ${setProgress !== null
                    ? svg`
                        <circle
                          cx="${this.toSvgX(setProgress * 100)}"
                          cy="${this.toSvgY(new MonotoneSpline(sunsetNodes).evaluate(setProgress * 100))}"
                          r="7"
                          fill="#ff7043"
                          stroke="#fff"
                          stroke-width="2"
                        >
                          <animate attributeName="r" values="6;9;6" dur="2s" repeatCount="indefinite" />
                        </circle>
                      `
                    : nothing}

                  <!-- Draggable Nodes -->
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
                        @mousedown="${(e: MouseEvent) => {
                          e.stopPropagation();
                          this.selSunsetIdx = idx;
                          this._drag = { type: "sunset", idx };
                        }}"
                      />
                    `;
                  })}
                </svg>
              </div>

              <!-- Selected Node Controls -->
              ${this.selSunsetIdx !== null && sunsetNodes[this.selSunsetIdx]
                ? html`
                    <div class="node-editor">
                      <span style="font-size: 11.5px; color: var(--sol-text-3);">Node:</span>
                      <span style="font-size: 11.5px; color: var(--sol-text-2);">Progress %</span>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        .value="${String(sunsetNodes[this.selSunsetIdx].x)}"
                        ?disabled="${this.selSunsetIdx === 0 || this.selSunsetIdx === sunsetNodes.length - 1}"
                        @change="${(e: Event) => {
                          const v = Math.max(0, Math.min(100, parseFloat((e.target as HTMLInputElement).value)));
                          const nodes = [...sunsetNodes];
                          nodes[this.selSunsetIdx!] = { ...nodes[this.selSunsetIdx!], x: v };
                          nodes.sort((a, b) => a.x - b.x);
                          this.localSunset = nodes;
                          this.debounceSaveSunset();
                        }}"
                      />
                      <span style="font-size: 11.5px; color: var(--sol-text-2); margin-left: 6px;">Level (0-254)</span>
                      <input
                        type="number"
                        min="0"
                        max="254"
                        .value="${String(sunsetNodes[this.selSunsetIdx].y)}"
                        @change="${(e: Event) => {
                          const v = Math.max(0, Math.min(254, parseInt((e.target as HTMLInputElement).value, 10)));
                          const nodes = [...sunsetNodes];
                          nodes[this.selSunsetIdx!] = { ...nodes[this.selSunsetIdx!], y: v };
                          this.localSunset = nodes;
                          this.debounceSaveSunset();
                        }}"
                      />
                      ${this.selSunsetIdx > 0 && this.selSunsetIdx < sunsetNodes.length - 1
                        ? html`
                            <button class="btn-node-del" @click="${() => this.deleteSunsetNode(this.selSunsetIdx!)}">
                              Delete node
                            </button>
                          `
                        : nothing}
                    </div>
                  `
                : nothing}
            </div>
          </div>
        </div>

        <!-- 2. Transitions Matrix -->
        <div class="card full-col">
          <div class="head">
            <ha-icon icon="mdi:speedometer" style="color: var(--sol-blue);"></ha-icon>
            <div class="title">Transitions Matrix</div>
            <div class="spacer"></div>
            <div style="font-size: 11px; color: var(--sol-text-4);">seconds</div>
          </div>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;">
            <!-- Up Group -->
            <div class="trans-grp">
              <div class="grp-lbl">Up</div>
              <div class="trans-row" title="* → L1 • Motion / enter: snappy illumination into primary level">
                <div class="trans-lbl">Occupancy</div>
                <div class="trans-dots"></div>
                <div class="trans-path">* → L1</div>
                <input
                  type="number"
                  step="0.5"
                  class="num-input"
                  style="width: 62px;"
                  .value="${String(house.transition_up_occupancy_s ?? house.transition_turn_on_l1_s ?? 2.0)}"
                  @change="${(e: Event) => {
                    setHouse(this.hass, { transition_up_occupancy_s: parseFloat((e.target as HTMLInputElement).value) });
                  }}"
                />
              </div>
              <div class="trans-row" title="Off → L3 • Dusk gate opens empty room: gentle wake to ambience floor">
                <div class="trans-lbl">Ambience</div>
                <div class="trans-dots"></div>
                <div class="trans-path">Off → L3</div>
                <input
                  type="number"
                  step="0.5"
                  class="num-input"
                  style="width: 62px;"
                  .value="${String(house.transition_up_ambience_s ?? house.transition_wake_l3_s ?? 10.0)}"
                  @change="${(e: Event) => {
                    setHouse(this.hass, { transition_up_ambience_s: parseFloat((e.target as HTMLInputElement).value) });
                  }}"
                />
              </div>
            </div>

            <!-- Down Group -->
            <div class="trans-grp">
              <div class="grp-lbl">Down</div>
              <div class="trans-row" title="L1 → L2 • Occupancy timeout: smooth warning transition to diminished level">
                <div class="trans-lbl">Diminish</div>
                <div class="trans-dots"></div>
                <div class="trans-path">L1 → L2</div>
                <input
                  type="number"
                  step="0.5"
                  class="num-input"
                  style="width: 62px;"
                  .value="${String(house.transition_down_diminish_s ?? house.transition_diminish_l2_s ?? 5.0)}"
                  @change="${(e: Event) => {
                    setHouse(this.hass, { transition_down_diminish_s: parseFloat((e.target as HTMLInputElement).value) });
                  }}"
                />
              </div>
              <div class="trans-row" title="L2 → L3 • Post-diminish: drop to background ambient glow">
                <div class="trans-lbl">Ambience</div>
                <div class="trans-dots"></div>
                <div class="trans-path">L2 → L3</div>
                <input
                  type="number"
                  step="0.5"
                  class="num-input"
                  style="width: 62px;"
                  .value="${String(house.transition_down_ambience_s ?? house.transition_clear_to_l3_s ?? 5.0)}"
                  @change="${(e: Event) => {
                    setHouse(this.hass, { transition_down_ambience_s: parseFloat((e.target as HTMLInputElement).value) });
                  }}"
                />
              </div>
              <div class="trans-row" title="* → Off • Room clears, ambient gate closes, or away: graceful shutoff">
                <div class="trans-lbl">Off</div>
                <div class="trans-dots"></div>
                <div class="trans-path">* → Off</div>
                <input
                  type="number"
                  step="0.5"
                  class="num-input"
                  style="width: 62px;"
                  .value="${String(house.transition_down_off_s ?? house.transition_clear_to_off_s ?? 4.0)}"
                  @change="${(e: Event) => {
                    setHouse(this.hass, { transition_down_off_s: parseFloat((e.target as HTMLInputElement).value) });
                  }}"
                />
              </div>
            </div>

            <!-- Continuous & Special -->
            <div class="trans-grp">
              <div class="grp-lbl">Continuous &amp; special</div>
              <div class="trans-row" title="Tracking • Steady-state lux / cloud blend / curve tracking tick transition">
                <div class="trans-lbl">Automatic</div>
                <div class="trans-dots"></div>
                <div class="trans-path">Tracking</div>
                <input
                  type="number"
                  step="0.5"
                  class="num-input"
                  style="width: 62px;"
                  .value="${String(house.transition_automatic_s ?? house.transition_tracking_s ?? 15.0)}"
                  @change="${(e: Event) => {
                    setHouse(this.hass, { transition_automatic_s: parseFloat((e.target as HTMLInputElement).value) });
                  }}"
                />
              </div>
              <div class="trans-row" title="UI Drag • Live slider adjustments and tuning response">
                <div class="trans-lbl">Manual</div>
                <div class="trans-dots"></div>
                <div class="trans-path">UI Drag</div>
                <input
                  type="number"
                  step="0.05"
                  class="num-input"
                  style="width: 62px;"
                  .value="${String(house.transition_manual_s ?? house.transition_manual_drag_s ?? 0.5)}"
                  @change="${(e: Event) => {
                    setHouse(this.hass, { transition_manual_s: parseFloat((e.target as HTMLInputElement).value) });
                  }}"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
