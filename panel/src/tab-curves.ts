/**
 * Master Curves Tab — Interactive Spline Curve Editors for:
 * 1. Outdoor lux demand curve (Logarithmic lux vs Demand %) + Cloudy Day Boost
 * 2. 24h Target Brightness Schedule (0-24h vs 0-254 level)
 * 3. 24h Target Colour Schedule (0-24h vs Derims [100-433 d / 2000-6000K])
 */

import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { BrightnessPoint, ColourPoint, Hass, LuxPoint, Snapshot } from "./api";
import { setBrightnessTimeline, setColourTimeline, setHouse, setLuxCurve, setLuxCloudyCurve } from "./api";
import { derimToKelvin, formatDerimWithKelvin, kelvinToDerim } from "./derim";
import { MonotoneSpline } from "./spline";
import { tokens } from "./tokens";
import "./ui";

const X0 = 64;
const X1 = 780;
const Y0 = 14;
const Y1 = 290;
const VW = 800;

interface NodeDef {
  x: number;
  y: number;
}

const DEF_LUX: NodeDef[] = [
  { x: 0, y: 100 },
  { x: 50, y: 90 },
  { x: 500, y: 40 },
  { x: 2500, y: 0 },
];

const DEF_LUX_CLOUDY: NodeDef[] = [
  { x: 0, y: 100 },
  { x: 50, y: 95 },
  { x: 500, y: 70 },
  { x: 2500, y: 40 },
  { x: 7000, y: 20 },
  { x: 12000, y: 0 },
];

const DEF_BRIGHT: NodeDef[] = [
  { x: 6.5, y: 120 },
  { x: 9.5, y: 254 },
  { x: 18.5, y: 180 },
  { x: 21.5, y: 80 },
  { x: 23.5, y: 25 },
];

const DEF_COLOUR: NodeDef[] = [
  { x: 7.0, y: 2700 },
  { x: 12.0, y: 4000 },
  { x: 19.0, y: 3000 },
  { x: 22.5, y: 2200 },
];

type CurveKey = "lux" | "bright" | "colour";

@customElement("sol-tab-curves")
export class SolTabCurves extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;

  @state() private full: CurveKey | null = null;
  @state() private selKey: CurveKey | null = null;
  @state() private selIdx: number | null = null;
  @state() private hoverKey: CurveKey | null = null;
  @state() private hoverPx = 0;

  // Lux mode toggle
  @state() private luxMode: "clear" | "cloudy" = "clear";

  // Local editable curves
  @state() private localLux: NodeDef[] | null = null;
  @state() private localLuxCloudy: NodeDef[] | null = null;
  @state() private localBright: NodeDef[] | null = null;
  @state() private localColour: NodeDef[] | null = null;

  private _drag: { key: CurveKey; idx: number } | null = null;
  private _debounceTimer?: number;

  static styles = [
    tokens,
    css`
      :host {
        display: block;
        padding-bottom: 40px;
      }
      .stack {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .card {
        background: var(--sol-card);
        border-radius: var(--sol-r-card);
        padding: 14px 16px 12px;
        box-shadow: var(--sol-shadow);
      }
      .head {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        margin-bottom: 8px;
      }
      .title {
        font-size: 15px;
        font-weight: 500;
        color: var(--sol-text);
      }
      .sub {
        font-size: 11.5px;
        color: var(--sol-text-3);
      }
      .spacer {
        flex: 1;
      }
      .legend {
        display: flex;
        gap: 11px;
        flex-wrap: wrap;
      }
      .leg-item {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 11px;
        color: var(--sol-text-2);
      }
      .chip {
        width: 12px;
        height: 2px;
        display: inline-block;
      }
      button.btn-sec {
        display: flex;
        align-items: center;
        gap: 5px;
        background: var(--sol-control);
        border: none;
        border-radius: 10px;
        padding: 5px 10px;
        color: var(--sol-text-2);
        font: 500 11.5px Roboto, sans-serif;
        cursor: pointer;
        transition: background 0.15s;
      }
      button.btn-sec:hover {
        background: var(--sol-card-high);
        color: var(--sol-text);
      }
      .plot-wrap {
        position: relative;
      }
      svg.plot {
        width: 100%;
        height: auto;
        display: block;
        touch-action: none;
        cursor: crosshair;
        user-select: none;
      }
      .foot {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        border-top: 1px solid rgba(255, 255, 255, 0.07);
        margin-top: 6px;
        padding-top: 8px;
      }
      .readout {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 11.5px;
        color: var(--sol-text-3);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .node-editor {
        display: flex;
        align-items: center;
        gap: 7px;
        background: var(--sol-control);
        border-radius: 8px;
        padding: 4px 8px;
      }
      .node-editor input {
        width: 66px;
        box-sizing: border-box;
        background: var(--sol-card);
        border: 1px solid rgba(79, 195, 247, 0.35);
        border-radius: 5px;
        padding: 3px 5px;
        text-align: center;
        font-size: 11.5px;
        color: var(--sol-text);
        outline: none;
      }
      .boost-row {
        display: flex;
        align-items: center;
        gap: 11px;
        flex-wrap: wrap;
        margin-top: 9px;
        padding: 9px 11px;
        background: var(--sol-control);
        border-radius: 8px;
      }
      .lux-mode-toggle {
        display: inline-flex;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 8px;
        padding: 2px;
        gap: 2px;
      }
      .lux-tab {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 6px;
        border: none;
        background: transparent;
        color: var(--sol-text-3);
        font: 500 11.5px Roboto, sans-serif;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .lux-tab:hover {
        color: var(--sol-text);
        background: rgba(255, 255, 255, 0.05);
      }
      .lux-tab.active-clear {
        background: rgba(255, 183, 77, 0.2);
        color: #ffb74d;
      }
      .lux-tab.active-cloudy {
        background: rgba(56, 189, 248, 0.2);
        color: #38bdf8;
      }
      .hint {
        font-size: 11px;
        color: var(--sol-text-4);
        padding-top: 7px;
        line-height: 1.5;
      }
      .modal-bg {
        position: fixed;
        inset: 0;
        z-index: 90;
        background: rgba(8, 9, 10, 0.88);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 22px;
      }
      .modal-box {
        width: 100%;
        max-width: 1500px;
        background: var(--sol-card);
        border-radius: 12px;
        padding: 16px 20px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.7);
      }
    `,
  ];

  private getLuxClearNodes(): NodeDef[] {
    if (this.localLux) return this.localLux;
    if (this.snap?.lux_curve?.length) {
      return this.snap.lux_curve.map((p) => ({
        x: p.lux,
        y: p.demand_pct > 1.0 ? p.demand_pct : p.demand_pct * 100.0,
      }));
    }
    return DEF_LUX;
  }

  private getLuxCloudyNodes(): NodeDef[] {
    if (this.localLuxCloudy) return this.localLuxCloudy;
    if (this.snap?.lux_cloudy_curve?.length) {
      return this.snap.lux_cloudy_curve.map((p) => ({
        x: p.lux,
        y: p.demand_pct > 1.0 ? p.demand_pct : p.demand_pct * 100.0,
      }));
    }
    return DEF_LUX_CLOUDY;
  }

  private getNodes(key: CurveKey): NodeDef[] {
    if (key === "lux") {
      return this.luxMode === "cloudy" ? this.getLuxCloudyNodes() : this.getLuxClearNodes();
    }
    if (key === "bright") {
      if (this.localBright) return this.localBright;
      if (this.snap?.brightness_timeline?.length) {
        return this.snap.brightness_timeline.map((p) => ({ x: p.hour, y: p.level }));
      }
      return DEF_BRIGHT;
    }
    if (key === "colour") {
      if (this.localColour) return this.localColour;
      if (this.snap?.colour_timeline?.length) {
        return this.snap.colour_timeline.map((p) => ({
          x: p.hour,
          y: kelvinToDerim(p.kelvin),
        }));
      }
      return DEF_COLOUR.map((p) => ({ x: p.x, y: kelvinToDerim(p.y) }));
    }
    return [];
  }

  private setNodes(key: CurveKey, nodes: NodeDef[]): void {
    const sorted = [...nodes].sort((a, b) => a.x - b.x);
    if (key === "lux") {
      if (this.luxMode === "cloudy") {
        this.localLuxCloudy = sorted;
      } else {
        this.localLux = sorted;
      }
    } else if (key === "bright") {
      this.localBright = sorted;
    } else if (key === "colour") {
      this.localColour = sorted;
    }
    this.requestUpdate();
    this.scheduleSave(key);
  }

  private scheduleSave(key: CurveKey): void {
    if (this._debounceTimer) window.clearTimeout(this._debounceTimer);
    this._debounceTimer = window.setTimeout(() => {
      this.saveCurve(key);
    }, 400);
  }

  private async saveCurve(key: CurveKey): Promise<void> {
    if (key === "lux") {
      if (this.luxMode === "cloudy") {
        const nodes = this.getLuxCloudyNodes();
        const lux_cloudy_curve: LuxPoint[] = nodes.map((n) => ({
          lux: n.x,
          demand_pct: n.y,
        }));
        await setLuxCloudyCurve(this.hass, lux_cloudy_curve);
      } else {
        const nodes = this.getLuxClearNodes();
        const lux_curve: LuxPoint[] = nodes.map((n) => ({
          lux: n.x,
          demand_pct: n.y,
        }));
        await setLuxCurve(this.hass, lux_curve);
      }
    } else if (key === "bright") {
      const nodes = this.getNodes("bright");
      const brightness_timeline: BrightnessPoint[] = nodes.map((n) => ({
        hour: n.x,
        level: Math.round(n.y),
      }));
      await setBrightnessTimeline(this.hass, brightness_timeline);
    } else if (key === "colour") {
      const nodes = this.getNodes("colour");
      const colour_timeline: ColourPoint[] = nodes.map((n) => ({
        hour: n.x,
        kelvin: derimToKelvin(n.y),
      }));
      await setColourTimeline(this.hass, colour_timeline);
    }
  }

  // --- Geometry mapping ---
  private xp(key: CurveKey, v: number): number {
    if (key === "lux") {
      const t = Math.log10(1 + Math.max(0, v)) / Math.log10(1 + 10000);
      return X0 + t * (X1 - X0);
    }
    const t = Math.max(0, Math.min(1, v / 24.0));
    return X0 + t * (X1 - X0);
  }

  private px2x(key: CurveKey, px: number): number {
    const t = Math.max(0, Math.min(1, (px - X0) / (X1 - X0)));
    if (key === "lux") {
      return Math.pow(10, t * Math.log10(1 + 10000)) - 1;
    }
    return t * 24.0;
  }

  private yp(key: CurveKey, v: number): number {
    let ymin = 0;
    let ymax = 100;
    if (key === "bright") {
      ymin = 0;
      ymax = 254;
    } else if (key === "colour") {
      ymin = 100; // 2000 K
      ymax = 433.3; // 6000 K
    }
    const t = Math.max(0, Math.min(1, (v - ymin) / (ymax - ymin)));
    return Y1 - t * (Y1 - Y0);
  }

  private py2y(key: CurveKey, py: number): number {
    let ymin = 0;
    let ymax = 100;
    if (key === "bright") {
      ymin = 0;
      ymax = 254;
    } else if (key === "colour") {
      ymin = 100;
      ymax = 433.3;
    }
    const t = Math.max(0, Math.min(1, (Y1 - py) / (Y1 - Y0)));
    return ymin + t * (ymax - ymin);
  }

  private getSpline(key: CurveKey): MonotoneSpline {
    const nodes = this.getNodes(key);
    return new MonotoneSpline(nodes, key !== "lux");
  }

  private hitNode(key: CurveKey, px: number, py: number): number {
    const nodes = this.getNodes(key);
    for (let i = 0; i < nodes.length; i++) {
      const nx = this.xp(key, nodes[i].x);
      const ny = this.yp(key, nodes[i].y);
      const dx = px - nx;
      const dy = py - ny;
      if (dx * dx + dy * dy <= 160) {
        return i;
      }
    }
    return -1;
  }

  private getPointerSvg(e: PointerEvent, target: SVGSVGElement): { px: number; py: number } {
    const r = target.getBoundingClientRect();
    const k = VW / r.width;
    return {
      px: (e.clientX - r.left) * k,
      py: (e.clientY - r.top) * k,
    };
  }

  private onPointerDown(key: CurveKey, e: PointerEvent): void {
    const target = e.currentTarget as SVGSVGElement;
    const { px, py } = this.getPointerSvg(e, target);
    const hit = this.hitNode(key, px, py);
    if (hit >= 0) {
      this._drag = { key, idx: hit };
      this.selKey = key;
      this.selIdx = hit;
      target.setPointerCapture?.(e.pointerId);
      this.requestUpdate();
      return;
    }

    // Check if clicked near curve to add a node
    if (px >= X0 && px <= X1 && py >= Y0 && py <= Y1) {
      const spline = this.getSpline(key);
      const vx = this.px2x(key, px);
      const vy = spline.evaluate(vx);
      const cy = this.yp(key, vy);
      if (Math.abs(cy - py) <= 20) {
        const nodes = [...this.getNodes(key)];
        const insertIdx = nodes.filter((n) => n.x < vx).length;
        nodes.splice(insertIdx, 0, { x: vx, y: vy });
        this.setNodes(key, nodes);
        this.selKey = key;
        this.selIdx = insertIdx;
        this._drag = { key, idx: insertIdx };
        target.setPointerCapture?.(e.pointerId);
        return;
      }
    }

    this.selKey = null;
    this.selIdx = null;
    this.requestUpdate();
  }

  private onPointerMove(key: CurveKey, e: PointerEvent): void {
    const target = e.currentTarget as SVGSVGElement;
    const { px, py } = this.getPointerSvg(e, target);
    if (this._drag && this._drag.key === key) {
      const nodes = [...this.getNodes(key)];
      const idx = this._drag.idx;
      if (nodes[idx]) {
        let vx = this.px2x(key, px);
        let vy = this.py2y(key, py);

        // Clamps
        if (key === "lux") {
          vx = Math.max(0, Math.min(10000, vx));
          vy = Math.max(0, Math.min(100, Math.round(vy)));
        } else if (key === "bright") {
          vx = Math.max(0, Math.min(24, Math.round(vx * 60) / 60));
          vy = Math.max(0, Math.min(254, Math.round(vy)));
        } else if (key === "colour") {
          vx = Math.max(0, Math.min(24, Math.round(vx * 60) / 60));
          vy = Math.max(100, Math.min(433.3, Math.round(vy * 10) / 10));
        }

        nodes[idx] = { x: vx, y: vy };
        this.setNodes(key, nodes);
      }
      return;
    }

    this.hoverKey = key;
    this.hoverPx = px;
    this.requestUpdate();
  }

  private onPointerUp(): void {
    this._drag = null;
  }

  private onPointerLeave(): void {
    this._drag = null;
    this.hoverKey = null;
    this.requestUpdate();
  }

  private onDoubleClick(key: CurveKey, e: PointerEvent): void {
    const target = e.currentTarget as SVGSVGElement;
    const { px, py } = this.getPointerSvg(e, target);
    const hit = this.hitNode(key, px, py);
    if (hit >= 0) {
      e.preventDefault();
      this.deleteNode(key, hit);
    }
  }

  private onContextMenu(key: CurveKey, e: MouseEvent): void {
    const target = e.currentTarget as SVGSVGElement;
    const { px, py } = this.getPointerSvg(e as unknown as PointerEvent, target);
    const hit = this.hitNode(key, px, py);
    if (hit >= 0) {
      e.preventDefault();
      this.deleteNode(key, hit);
    }
  }

  private deleteNode(key: CurveKey, idx: number): void {
    const nodes = this.getNodes(key);
    if (nodes.length <= 2) return; // Keep minimum 2 nodes
    const next = nodes.filter((_, i) => i !== idx);
    this.selKey = null;
    this.selIdx = null;
    this.setNodes(key, next);
  }

  private resetCurve(key: CurveKey): void {
    if (key === "lux") {
      if (this.luxMode === "cloudy") {
        this.setNodes("lux", DEF_LUX_CLOUDY);
      } else {
        this.setNodes("lux", DEF_LUX);
      }
    }
    if (key === "bright") this.setNodes("bright", DEF_BRIGHT);
    if (key === "colour") this.setNodes("colour", DEF_COLOUR.map((p) => ({ x: p.x, y: kelvinToDerim(p.y) })));
  }

  render() {
    return html`
      <svg width="0" height="0" style="position:absolute;visibility:hidden">
        <defs>
          <linearGradient id="kgrad" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stop-color="#ff9a3c"></stop>
            <stop offset="0.5" stop-color="#ffe4c4"></stop>
            <stop offset="1" stop-color="#cfe0ff"></stop>
          </linearGradient>
        </defs>
      </svg>

      <div class="stack">
        ${this.renderCard("lux")}
        ${this.renderCard("bright")}
        ${this.renderCard("colour")}
      </div>

      ${this.full ? this.renderFullscreenModal(this.full) : nothing}
    `;
  }

  private getCardHelp(key: CurveKey): string {
    if (key === "lux") {
      return "Indoor demand against measured outdoor light. Use Clear Sun vs Overcast toggle to shape each curve. Demand smoothly transitions to the Overcast curve above the configured cloudiness threshold. Drag a node to adjust · click the line to add one · double-click to remove.";
    }
    if (key === "bright") {
      return "Master brightness level through the day across the 24-hour cycle. Drag a node to adjust level across the day · click to add · double-click to remove.";
    }
    return "Colour temperature in Derims (100d candle to 433d daylight). Drag a node to shape circadian colour across the day.";
  }

  private renderCard(key: CurveKey) {
    return html`
      <div class="card">
        <div class="head">
          <ha-icon icon="${key === "lux" ? "mdi:weather-sunny" : key === "bright" ? "mdi:clock-outline" : "mdi:palette-outline"}" style="color: var(--sol-blue);"></ha-icon>
          <div class="title">${this.getCardTitle(key)}</div>
          <sol-help text="${this.getCardHelp(key)}"></sol-help>

          ${key === "lux"
            ? html`
                <div class="lux-mode-toggle">
                  <button
                    class="lux-tab ${this.luxMode === "clear" ? "active-clear" : ""}"
                    @click="${() => { this.luxMode = "clear"; this.selKey = null; this.selIdx = null; }}"
                  >
                    <ha-icon icon="mdi:white-balance-sunny" style="--mdc-icon-size: 14px;"></ha-icon>
                    Clear Sun
                  </button>
                  <button
                    class="lux-tab ${this.luxMode === "cloudy" ? "active-cloudy" : ""}"
                    @click="${() => { this.luxMode = "cloudy"; this.selKey = null; this.selIdx = null; }}"
                  >
                    <ha-icon icon="mdi:weather-cloudy" style="--mdc-icon-size: 14px;"></ha-icon>
                    Overcast
                  </button>
                </div>
              `
            : nothing}

          <div class="spacer"></div>
          <div class="legend">
            ${this.renderLegend(key)}
          </div>
          <button class="btn-sec" @click="${() => (this.full = key)}">
            <ha-icon icon="mdi:fullscreen" style="--mdc-icon-size: 16px;"></ha-icon>
            Expand
          </button>
        </div>

        <div class="plot-wrap">
          ${this.renderSvgPlot(key)}
        </div>

        <div class="foot">
          <div class="readout">
            <ha-icon icon="mdi:crosshairs-gps" style="--mdc-icon-size: 14px;"></ha-icon>
            ${this.getCursorReadout(key)}
          </div>
          <div class="spacer"></div>
          ${this.renderNodeEditor(key)}
          <div class="sub">${this.getNodes(key).length} nodes ${key === "lux" ? (this.luxMode === "cloudy" ? "(Overcast curve)" : "(Clear Sun curve)") : ""}</div>
          <button class="btn-sec" @click="${() => this.resetCurve(key)}">
            <ha-icon icon="mdi:restore" style="--mdc-icon-size: 14px;"></ha-icon>
            Reset curve
          </button>
        </div>

        ${key === "lux" ? this.renderCloudyBoost() : nothing}
      </div>
    `;
  }

  private renderCloudyBoost() {
    const thresh = this.snap?.house?.cloudy_blend_threshold ?? 50;
    const world = this.snap?.world;
    const clouds = world?.cloud_coverage;
    let blendPct: number | null = null;
    if (clouds !== null && clouds !== undefined) {
      if (clouds <= thresh) {
        blendPct = 0;
      } else if (thresh >= 100) {
        blendPct = 0;
      } else {
        blendPct = Math.round(Math.min(100, Math.max(0, ((clouds - thresh) / (100 - thresh)) * 100)));
      }
    }

    return html`
      <div class="boost-row">
        <ha-icon icon="mdi:weather-partly-cloudy" style="color: var(--sol-cyan);"></ha-icon>
        <div style="font-size: 12.5px; color: var(--sol-text-2);">Overcast blend threshold</div>
        <sol-help text="Cloudiness percentage required before the Overcast curve begins crossfading in. Above this threshold, demand smoothly transitions to the Overcast curve as cloud cover reaches 100%."></sol-help>
        <div style="font-size: 12px; color: var(--sol-text-3); margin-left: 4px;">Trigger:</div>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          .value="${String(thresh)}"
          @input="${(e: Event) => {
            const v = parseFloat((e.target as HTMLInputElement).value);
            setHouse(this.hass, { cloudy_blend_threshold: v });
          }}"
          style="flex: 1; min-width: 120px;"
        />
        <div style="font-size: 12.5px; font-variant-numeric: tabular-nums; color: var(--sol-text); min-width: 48px;">
          ${Math.round(thresh)}%
        </div>
        ${clouds !== null && clouds !== undefined
          ? html`<span class="status-badge" style="background: rgba(56, 189, 248, 0.15); color: var(--sol-cyan); font-size: 11px; padding: 3px 8px; border-radius: 6px;">
              ${Math.round(clouds)}% Clouds · ${blendPct}% Overcast active
            </span>`
          : nothing}
      </div>
    `;
  }

  private renderSvgPlot(key: CurveKey) {
    const world = this.snap?.world;
    const isSel = this.selKey === key;
    const selNodeIdx = isSel ? this.selIdx : null;

    if (key === "lux") {
      const clearNodes = this.getLuxClearNodes();
      const cloudyNodes = this.getLuxCloudyNodes();
      const clearSpline = new MonotoneSpline(clearNodes, false);
      const cloudySpline = new MonotoneSpline(cloudyNodes, false);

      const N = 240;
      let dClear = "";
      let dCloudy = "";
      for (let i = 0; i <= N; i++) {
        const px = X0 + (X1 - X0) * (i / N);
        const vx = this.px2x("lux", px);
        const vyClear = clearSpline.evaluate(vx);
        const vyCloudy = cloudySpline.evaluate(vx);
        const pyClear = Math.max(Y0, Math.min(Y1, this.yp("lux", vyClear)));
        const pyCloudy = Math.max(Y0, Math.min(Y1, this.yp("lux", vyCloudy)));
        dClear += (i === 0 ? "M" : " L") + px.toFixed(1) + " " + pyClear.toFixed(1);
        dCloudy += (i === 0 ? "M" : " L") + px.toFixed(1) + " " + pyCloudy.toFixed(1);
      }
      const dClearFill = dClear + ` L${X1} ${Y1} L${X0} ${Y1} Z`;
      const dCloudyFill = dCloudy + ` L${X1} ${Y1} L${X0} ${Y1} Z`;

      const isClearActive = this.luxMode === "clear";
      const activeNodes = isClearActive ? clearNodes : cloudyNodes;

      // Live indicators
      let liveX = 0;
      let liveY = 0;
      let hasLive = false;
      if (world && typeof world.lux === "number") {
        liveX = this.xp("lux", world.lux);
        liveY = this.yp("lux", (world.demand ?? 0) * 100);
        hasLive = true;
      }

      return html`
        <svg
          class="plot"
          viewBox="0 0 800 340"
          @pointerdown="${(e: PointerEvent) => this.onPointerDown("lux", e)}"
          @pointermove="${(e: PointerEvent) => this.onPointerMove("lux", e)}"
          @pointerup="${() => this.onPointerUp()}"
          @pointerleave="${() => this.onPointerLeave()}"
          @dblclick="${(e: PointerEvent) => this.onDoubleClick("lux", e)}"
          @contextmenu="${(e: MouseEvent) => this.onContextMenu("lux", e)}"
        >
          <!-- Background -->
          <rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}" fill="#151617"></rect>

          <!-- Grid Lines & Labels -->
          ${this.renderGrid("lux")}

          <!-- Fills -->
          <path d="${dClearFill}" fill="rgba(255,183,77,0.06)" stroke="none"></path>
          <path d="${dCloudyFill}" fill="rgba(56,189,248,0.06)" stroke="none"></path>

          <!-- Clear Sun Curve Path (Gold) -->
          <path
            d="${dClear}"
            fill="none"
            stroke="#ffb74d"
            stroke-width="${isClearActive ? "2.5" : "1.6"}"
            stroke-dasharray="${isClearActive ? "none" : "5 4"}"
            opacity="${isClearActive ? "1.0" : "0.45"}"
            stroke-linecap="round"
          ></path>

          <!-- Overcast Curve Path (Cyan) -->
          <path
            d="${dCloudy}"
            fill="none"
            stroke="#38bdf8"
            stroke-width="${!isClearActive ? "2.5" : "1.6"}"
            stroke-dasharray="${!isClearActive ? "none" : "5 4"}"
            opacity="${!isClearActive ? "1.0" : "0.45"}"
            stroke-linecap="round"
          ></path>

          <!-- Live World Pulse Cursor -->
          ${hasLive
            ? svg`
                <g>
                  <circle cx="${liveX}" cy="${liveY}" r="7" fill="rgba(255,255,255,0.18)">
                    <animate attributeName="r" values="6;14;6" dur="2.6s" repeatCount="indefinite"></animate>
                    <animate attributeName="opacity" values="0.6;0;0.6" dur="2.6s" repeatCount="indefinite"></animate>
                  </circle>
                  <circle cx="${liveX}" cy="${liveY}" r="4" fill="#ffffff" stroke="rgba(0,0,0,0.5)" stroke-width="1"></circle>
                </g>
              `
            : nothing}

          <!-- Inactive curve dimmed nodes -->
          ${(isClearActive ? cloudyNodes : clearNodes).map((n) => {
            const cx = this.xp("lux", n.x);
            const cy = this.yp("lux", n.y);
            return svg`
              <circle
                cx="${cx}"
                cy="${cy}"
                r="3.5"
                fill="${isClearActive ? "#38bdf8" : "#ffb74d"}"
                opacity="0.4"
              ></circle>
            `;
          })}

          <!-- Active Curve Control Nodes -->
          ${activeNodes.map((n, i) => {
            const cx = this.xp("lux", n.x);
            const cy = this.yp("lux", n.y);
            const selected = isSel && selNodeIdx === i;
            const nodeColor = isClearActive ? "#ffb74d" : "#38bdf8";
            return svg`
              <circle
                cx="${cx}"
                cy="${cy}"
                r="${selected ? 8 : 6}"
                fill="${selected ? "#ffffff" : nodeColor}"
                stroke="${selected ? nodeColor : "#ffffff"}"
                stroke-width="1.8"
                style="cursor: pointer;"
              ></circle>
            `;
          })}

          <!-- Outer plot border -->
          <rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}" fill="none" stroke="rgba(255,255,255,0.13)" stroke-width="1"></rect>
        </svg>
      `;
    }

    const nodes = this.getNodes(key);
    const spline = this.getSpline(key);

    // Generate curve path
    const N = 240;
    let d = "";
    for (let i = 0; i <= N; i++) {
      const px = X0 + (X1 - X0) * (i / N);
      const vx = this.px2x(key, px);
      const vy = spline.evaluate(vx);
      const py = Math.max(Y0, Math.min(Y1, this.yp(key, vy)));
      d += (i === 0 ? "M" : " L") + px.toFixed(1) + " " + py.toFixed(1);
    }
    const dFill = d + ` L${X1} ${Y1} L${X0} ${Y1} Z`;

    // Live indicators
    let liveX = 0;
    let liveY = 0;
    let hasLive = false;
    if (world) {
      liveX = this.xp(key, world.clock_hour);
      liveY = this.yp(key, spline.evaluate(world.clock_hour));
      hasLive = true;
    }

    return html`
      <svg
        class="plot"
        viewBox="0 0 800 340"
        @pointerdown="${(e: PointerEvent) => this.onPointerDown(key, e)}"
        @pointermove="${(e: PointerEvent) => this.onPointerMove(key, e)}"
        @pointerup="${() => this.onPointerUp()}"
        @pointerleave="${() => this.onPointerLeave()}"
        @dblclick="${(e: PointerEvent) => this.onDoubleClick(key, e)}"
        @contextmenu="${(e: MouseEvent) => this.onContextMenu(key, e)}"
      >
        <!-- Background -->
        <rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}" fill="#151617"></rect>

        <!-- Grid Lines & Labels -->
        ${this.renderGrid(key)}

        <!-- Sun VLines (for 24h timelines) -->
        ${this.renderSolarVlines(key)}

        <!-- Fill & Stroke -->
        <path d="${dFill}" fill="${key === "colour" ? "rgba(255,205,150,0.07)" : "rgba(79,195,247,0.09)"}" stroke="none"></path>
        <path
          d="${d}"
          fill="none"
          stroke="${key === "colour" ? "url(#kgrad)" : "var(--sol-blue)"}"
          stroke-width="2.5"
          stroke-linecap="round"
        ></path>

        <!-- Live World Pulse Cursor -->
        ${hasLive
          ? svg`
              <g>
                <circle cx="${liveX}" cy="${liveY}" r="7" fill="rgba(255,255,255,0.16)">
                  <animate attributeName="r" values="6;13;6" dur="2.6s" repeatCount="indefinite"></animate>
                  <animate attributeName="opacity" values="0.55;0;0.55" dur="2.6s" repeatCount="indefinite"></animate>
                </circle>
                <circle cx="${liveX}" cy="${liveY}" r="3.5" fill="#ffffff"></circle>
              </g>
            `
          : nothing}

        <!-- Control Nodes -->
        ${nodes.map((n, i) => {
          const cx = this.xp(key, n.x);
          const cy = this.yp(key, n.y);
          const selected = isSel && selNodeIdx === i;
          return svg`
            <circle
              cx="${cx}"
              cy="${cy}"
              r="${selected ? 8 : 6}"
              fill="${selected ? "#ffb74d" : "#38bdf8"}"
              stroke="#ffffff"
              stroke-width="1.5"
              style="cursor: pointer;"
            ></circle>
          `;
        })}

        <!-- Outer plot border -->
        <rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}" fill="none" stroke="rgba(255,255,255,0.13)" stroke-width="1"></rect>
      </svg>
    `;
  }

  private renderGrid(key: CurveKey) {
    const lines = [];
    if (key === "lux") {
      const xt = [0, 10, 100, 1000, 10000];
      const yt = [0, 25, 50, 75, 100];
      for (const x of xt) {
        const px = this.xp("lux", x);
        lines.push(svg`<line x1="${px}" y1="${Y0}" x2="${px}" y2="${Y1}" stroke="rgba(255,255,255,0.08)" stroke-width="1"></line>`);
        lines.push(svg`<text x="${px}" y="${Y1 + 16}" fill="rgba(255,255,255,0.45)" font-size="10.5px" font-family="Roboto, sans-serif" text-anchor="middle">${x >= 1000 ? x / 1000 + "k" : x}</text>`);
      }
      for (const y of yt) {
        const py = this.yp("lux", y);
        lines.push(svg`<line x1="${X0}" y1="${py}" x2="${X1}" y2="${py}" stroke="rgba(255,255,255,0.08)" stroke-width="1"></line>`);
        lines.push(svg`<text x="${X0 - 8}" y="${py + 4}" fill="rgba(255,255,255,0.45)" font-size="10.5px" font-family="Roboto, sans-serif" text-anchor="end">${y}%</text>`);
      }
      lines.push(svg`<text x="${(X0 + X1) / 2}" y="325" fill="rgba(255,255,255,0.3)" font-size="11px" font-family="Roboto, sans-serif" text-anchor="middle">outdoor illuminance (lx)</text>`);
    } else if (key === "bright") {
      const xt = [0, 3, 6, 9, 12, 15, 18, 21, 24];
      const yt = [0, 63, 127, 190, 254];
      for (const x of xt) {
        const px = this.xp("bright", x);
        lines.push(svg`<line x1="${px}" y1="${Y0}" x2="${px}" y2="${Y1}" stroke="rgba(255,255,255,0.08)" stroke-width="1"></line>`);
        lines.push(svg`<text x="${px}" y="${Y1 + 16}" fill="rgba(255,255,255,0.45)" font-size="10.5px" font-family="Roboto, sans-serif" text-anchor="middle">${String(x).padStart(2, "0")}:00</text>`);
      }
      for (const y of yt) {
        const py = this.yp("bright", y);
        lines.push(svg`<line x1="${X0}" y1="${py}" x2="${X1}" y2="${py}" stroke="rgba(255,255,255,0.08)" stroke-width="1"></line>`);
        lines.push(svg`<text x="${X0 - 8}" y="${py + 4}" fill="rgba(255,255,255,0.45)" font-size="10.5px" font-family="Roboto, sans-serif" text-anchor="end">${y}</text>`);
      }
      lines.push(svg`<text x="${(X0 + X1) / 2}" y="325" fill="rgba(255,255,255,0.3)" font-size="11px" font-family="Roboto, sans-serif" text-anchor="middle">time of day</text>`);
    } else if (key === "colour") {
      const xt = [0, 3, 6, 9, 12, 15, 18, 21, 24];
      // Derims ticks covering 2000K (100d) to 6000K (433d)
      const yt = [100, 200, 300, 400, 433.3];
      for (const x of xt) {
        const px = this.xp("colour", x);
        lines.push(svg`<line x1="${px}" y1="${Y0}" x2="${px}" y2="${Y1}" stroke="rgba(255,255,255,0.08)" stroke-width="1"></line>`);
        lines.push(svg`<text x="${px}" y="${Y1 + 16}" fill="rgba(255,255,255,0.45)" font-size="10.5px" font-family="Roboto, sans-serif" text-anchor="middle">${String(x).padStart(2, "0")}:00</text>`);
      }
      for (const y of yt) {
        const py = this.yp("colour", y);
        const k = derimToKelvin(y);
        lines.push(svg`<line x1="${X0}" y1="${py}" x2="${X1}" y2="${py}" stroke="rgba(255,255,255,0.08)" stroke-width="1"></line>`);
        lines.push(svg`<text x="${X0 - 8}" y="${py + 4}" fill="rgba(255,255,255,0.45)" font-size="10.5px" font-family="Roboto, sans-serif" text-anchor="end">${Math.round(y)} Ɯ (${k}K)</text>`);
      }
      lines.push(svg`<text x="${(X0 + X1) / 2}" y="325" fill="rgba(255,255,255,0.3)" font-size="11px" font-family="Roboto, sans-serif" text-anchor="middle">time of day (Ɯ / kelvin)</text>`);
    }
    return lines;
  }

  private renderSolarVlines(key: CurveKey) {
    const world = this.snap?.world;
    if (!world) return nothing;
    const vlines = [];
    if (world.sunrise_hour !== null) {
      const x = this.xp(key, world.sunrise_hour);
      vlines.push(svg`
        <line x1="${x}" y1="${Y0}" x2="${x}" y2="${Y1}" stroke="rgba(255,183,77,0.45)" stroke-dasharray="4 3"></line>
        <text x="${x + 4}" y="${Y0 + 12}" fill="#c99a4e" font-size="10px" font-family="Roboto, sans-serif">sunrise</text>
      `);
    }
    if (world.sunset_hour !== null) {
      const x = this.xp(key, world.sunset_hour);
      vlines.push(svg`
        <line x1="${x}" y1="${Y0}" x2="${x}" y2="${Y1}" stroke="rgba(255,183,77,0.45)" stroke-dasharray="4 3"></line>
        <text x="${x + 4}" y="${Y0 + 12}" fill="#ffb74d" font-size="10px" font-family="Roboto, sans-serif">sunset</text>
      `);
    }
    if (world.dusk_hour !== null) {
      const x = this.xp(key, world.dusk_hour);
      vlines.push(svg`
        <line x1="${x}" y1="${Y0}" x2="${x}" y2="${Y1}" stroke="rgba(149,117,205,0.7)" stroke-dasharray="4 3"></line>
        <text x="${x + 4}" y="${Y0 + 24}" fill="#b39ddb" font-size="10px" font-family="Roboto, sans-serif">civil dusk</text>
      `);
    }
    return vlines;
  }

  private renderNodeEditor(key: CurveKey) {
    if (this.selKey !== key || this.selIdx === null) return nothing;
    const nodes = this.getNodes(key);
    const node = nodes[this.selIdx];
    if (!node) return nothing;

    const xLabel = key === "lux" ? "Lux" : "Time";
    const yLabel = key === "lux" ? "Demand %" : key === "bright" ? "Level (lvl)" : "Derim (Ɯ)";

    return html`
      <div class="node-editor">
        <div style="font-size: 10.5px; text-transform: uppercase; color: var(--sol-text-3);">Node ${this.selIdx + 1}</div>
        <div style="font-size: 11px; color: var(--sol-text-2);">${xLabel}</div>
        <input
          type="text"
          style="${key !== "lux" ? "width: 68px;" : ""}"
          .value="${key === "lux" ? String(Math.round(node.x)) : this.hourToTimeStr(node.x)}"
          @change="${(e: Event) => {
            const raw = (e.target as HTMLInputElement).value;
            const v = key === "lux" ? parseFloat(raw) : this.parseTimeToHour(raw);
            if (v !== null && !isNaN(v)) {
              nodes[this.selIdx!] = { x: v, y: node.y };
              this.setNodes(key, nodes);
            }
          }}"
        />
        <div style="font-size: 11px; color: var(--sol-text-2);">${yLabel}</div>
        <input
          type="text"
          .value="${Math.round(node.y)}"
          @change="${(e: Event) => {
            const v = parseFloat((e.target as HTMLInputElement).value);
            if (!isNaN(v)) {
              nodes[this.selIdx!] = { x: node.x, y: v };
              this.setNodes(key, nodes);
            }
          }}"
        />
        <button
          style="background:none; border:none; color: var(--sol-amber); cursor:pointer; display:flex;"
          @click="${() => this.deleteNode(key, this.selIdx!)}"
          title="Delete node"
        >
          <ha-icon icon="mdi:delete" style="--mdc-icon-size: 16px;"></ha-icon>
        </button>
      </div>
    `;
  }

  private hourToTimeStr(h: number): string {
    const norm = ((h % 24) + 24) % 24;
    const hr = Math.floor(norm);
    const min = Math.round((norm - hr) * 60);
    const adjHr = min === 60 ? (hr + 1) % 24 : hr;
    const adjMin = min === 60 ? 0 : min;
    return `${String(adjHr).padStart(2, "0")}:${String(adjMin).padStart(2, "0")}`;
  }

  private parseTimeToHour(str: string): number | null {
    const trimmed = str.trim();
    if (!trimmed) return null;
    if (trimmed.includes(":")) {
      const parts = trimmed.split(":");
      const hr = parseFloat(parts[0]);
      const min = parseFloat(parts[1] || "0");
      if (isNaN(hr) || isNaN(min)) return null;
      return Math.max(0, Math.min(24, hr + min / 60.0));
    }
    const val = parseFloat(trimmed);
    if (isNaN(val)) return null;
    return Math.max(0, Math.min(24, val));
  }

  private renderFullscreenModal(key: CurveKey) {
    return html`
      <div class="modal-bg" @click="${(e: MouseEvent) => {
        if (e.target === e.currentTarget) this.full = null;
      }}">
        <div class="modal-box">
          <div class="head">
            <ha-icon icon="${key === "lux" ? "mdi:weather-sunny" : key === "bright" ? "mdi:clock-outline" : "mdi:palette-outline"}" style="color: var(--sol-blue);"></ha-icon>
            <div class="title">${this.getCardTitle(key)} (Precision Editor)</div>
            <div class="spacer"></div>
            <button class="btn-sec" @click="${() => (this.full = null)}">
              <ha-icon icon="mdi:close" style="--mdc-icon-size: 16px;"></ha-icon>
              Close
            </button>
          </div>
          <div class="plot-wrap">
            ${this.renderSvgPlot(key)}
          </div>
          <div class="foot">
            <div class="readout">${this.getCursorReadout(key)}</div>
            <div class="spacer"></div>
            ${this.renderNodeEditor(key)}
            <div class="sub">${this.getNodes(key).length} nodes</div>
            <button class="btn-sec" @click="${() => this.resetCurve(key)}">Reset curve</button>
          </div>
        </div>
      </div>
    `;
  }

  private getCardTitle(key: CurveKey): string {
    if (key === "lux") return "Outdoor lux demand curves (Clear Sun vs Overcast)";
    if (key === "bright") return "24h target brightness schedule";
    return "24h target colour schedule (Ɯ)";
  }

  private renderLegend(key: CurveKey) {
    if (key === "lux") {
      return html`
        <div class="leg-item"><span class="chip" style="background: #ffb74d;"></span>Clear Sun</div>
        <div class="leg-item"><span class="chip" style="background: #38bdf8;"></span>Overcast</div>
        <div class="leg-item"><span class="chip" style="background: #ffffff; width: 6px; height: 6px; border-radius: 50%;"></span>Live demand</div>
      `;
    }
    return html`
      <div class="leg-item"><span class="chip" style="background: ${key === "colour" ? "url(#kgrad)" : "var(--sol-blue)"};"></span>target</div>
      <div class="leg-item"><span class="chip" style="background: #ffb74d;"></span>sunrise / sunset</div>
      <div class="leg-item"><span class="chip" style="background: #b39ddb;"></span>civil dusk</div>
    `;
  }

  private getCursorReadout(key: CurveKey): string {
    if (this.hoverKey !== key) return "hover the plot to read values";
    if (key === "lux") {
      const clearSpline = new MonotoneSpline(this.getLuxClearNodes(), false);
      const cloudySpline = new MonotoneSpline(this.getLuxCloudyNodes(), false);
      const vx = this.px2x("lux", this.hoverPx);
      const vyClear = clearSpline.evaluate(vx);
      const vyCloudy = cloudySpline.evaluate(vx);
      return `Lux ${Math.round(vx)} lx   Clear: ${Math.round(vyClear)}%   Overcast: ${Math.round(vyCloudy)}%`;
    }
    const spline = this.getSpline(key);
    const vx = this.px2x(key, this.hoverPx);
    const vy = spline.evaluate(vx);
    if (key === "bright") {
      const hr = Math.floor(vx);
      const min = Math.floor((vx % 1) * 60);
      const timeStr = `${String(hr).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
      return `Time ${timeStr}   Level ${Math.round(vy)} lvl (${Math.round((vy / 254) * 100)}%)`;
    }
    const hr = Math.floor(vx);
    const min = Math.floor((vx % 1) * 60);
    const timeStr = `${String(hr).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    return `Time ${timeStr}   Colour ${formatDerimWithKelvin(vy)}`;
  }
}
