/**
 * Master Curves Tab — Interactive Spline Curve Editors for:
 * 1. Outdoor lux demand curve (Logarithmic lux vs Demand %) + Cloudy Day Boost
 * 2. 24h Target Brightness Schedule (0-24h vs 0-254 level)
 * 3. 24h Target Colour Schedule (0-24h vs Derims [100-433 d / 2000-6000K])
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { BrightnessPoint, ColourPoint, Hass, LuxPoint, Snapshot } from "./api";
import { setBrightnessTimeline, setColourTimeline, setHouse, setLuxCurve } from "./api";
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

  // Local editable curves
  @state() private localLux: NodeDef[] | null = null;
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

  private getNodes(key: CurveKey): NodeDef[] {
    if (key === "lux") {
      if (this.localLux) return this.localLux;
      if (this.snap?.lux_curve?.length) {
        return this.snap.lux_curve.map((p) => ({ x: p.lux, y: p.demand_pct }));
      }
      return DEF_LUX;
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
      this.localLux = sorted;
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
      const nodes = this.getNodes("lux");
      const lux_curve: LuxPoint[] = nodes.map((n) => ({
        lux: n.x,
        demand_pct: n.y,
      }));
      await setLuxCurve(this.hass, lux_curve);
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
    if (key === "lux") this.setNodes("lux", DEF_LUX);
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

  private renderCard(key: CurveKey) {
    return html`
      <div class="card">
        <div class="head">
          <ha-icon icon="${key === "lux" ? "mdi:weather-sunny" : key === "bright" ? "mdi:clock-outline" : "mdi:palette-outline"}" style="color: var(--sol-blue);"></ha-icon>
          <div class="title">${this.getCardTitle(key)}</div>
          <div class="sub">${this.getCardSubtitle(key)}</div>
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
          <div class="sub">${this.getNodes(key).length} nodes</div>
          <button class="btn-sec" @click="${() => this.resetCurve(key)}">
            <ha-icon icon="mdi:restore" style="--mdc-icon-size: 14px;"></ha-icon>
            Reset curve
          </button>
        </div>

        ${key === "lux" ? this.renderCloudyBoost() : nothing}

        <div class="hint">
          Drag a node to shape the curve · click the line to add one · double-click or right-click to remove · type exact values in the node fields. Interpolation is monotone cubic spline, so the curve never overshoots.
        </div>
      </div>
    `;
  }

  private renderCloudyBoost() {
    const boost = this.snap?.house?.cloudy_boost_stops ?? 0.5;
    return html`
      <div class="boost-row">
        <ha-icon icon="mdi:cloud" style="color: var(--sol-text-3);"></ha-icon>
        <div style="font-size: 12.5px; color: var(--sol-text-2);">Cloudy day / overcast boost</div>
        <sol-help text="Lifts the whole demand curve on gloomy days so rooms do not sit dark while the meter still reads bright. Applied in stops, then clipped at 100% demand."></sol-help>
        <input
          type="range"
          min="0"
          max="2"
          step="0.25"
          .value="${String(boost)}"
          @input="${(e: Event) => {
            const v = parseFloat((e.target as HTMLInputElement).value);
            setHouse(this.hass, { cloudy_boost_stops: v });
          }}"
          style="flex: 1; min-width: 140px;"
        />
        <div style="font-size: 12.5px; font-variant-numeric: tabular-nums; color: var(--sol-text);">
          ${boost > 0 ? "+" : ""}${boost.toFixed(2)} stops
        </div>
      </div>
    `;
  }

  private renderSvgPlot(key: CurveKey) {
    const nodes = this.getNodes(key);
    const spline = this.getSpline(key);
    const world = this.snap?.world;

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

    const isSel = this.selKey === key;
    const selNodeIdx = isSel ? this.selIdx : null;

    // Live indicators
    let liveX = 0;
    let liveY = 0;
    let hasLive = false;
    if (world) {
      if (key === "lux") {
        liveX = this.xp("lux", world.lux);
        liveY = this.yp("lux", spline.evaluate(world.lux));
        hasLive = true;
      } else {
        liveX = this.xp(key, world.clock_hour);
        liveY = this.yp(key, spline.evaluate(world.clock_hour));
        hasLive = true;
      }
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
        ${key !== "lux" ? this.renderSolarVlines(key) : nothing}

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
          ? html`
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
          return html`
            <circle
              cx="${cx}"
              cy="${cy}"
              r="${selected ? 8 : 6}"
              fill="${selected ? "var(--sol-amber)" : "var(--sol-blue)"}"
              stroke="#111213"
              stroke-width="2"
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
        lines.push(html`<line x1="${px}" y1="${Y0}" x2="${px}" y2="${Y1}" stroke="rgba(255,255,255,0.08)" stroke-width="1"></line>`);
        lines.push(html`<text x="${px}" y="${Y1 + 16}" fill="var(--sol-text-3)" font-size="10.5px" text-anchor="middle">${x >= 1000 ? x / 1000 + "k" : x}</text>`);
      }
      for (const y of yt) {
        const py = this.yp("lux", y);
        lines.push(html`<line x1="${X0}" y1="${py}" x2="${X1}" y2="${py}" stroke="rgba(255,255,255,0.08)" stroke-width="1"></line>`);
        lines.push(html`<text x="${X0 - 8}" y="${py + 4}" fill="var(--sol-text-3)" font-size="10.5px" text-anchor="end">${y}%</text>`);
      }
      lines.push(html`<text x="${(X0 + X1) / 2}" y="325" fill="var(--sol-text-4)" font-size="11px" text-anchor="middle">outdoor illuminance (lx)</text>`);
    } else if (key === "bright") {
      const xt = [0, 3, 6, 9, 12, 15, 18, 21, 24];
      const yt = [0, 63, 127, 190, 254];
      for (const x of xt) {
        const px = this.xp("bright", x);
        lines.push(html`<line x1="${px}" y1="${Y0}" x2="${px}" y2="${Y1}" stroke="rgba(255,255,255,0.08)" stroke-width="1"></line>`);
        lines.push(html`<text x="${px}" y="${Y1 + 16}" fill="var(--sol-text-3)" font-size="10.5px" text-anchor="middle">${String(x).padStart(2, "0")}:00</text>`);
      }
      for (const y of yt) {
        const py = this.yp("bright", y);
        lines.push(html`<line x1="${X0}" y1="${py}" x2="${X1}" y2="${py}" stroke="rgba(255,255,255,0.08)" stroke-width="1"></line>`);
        lines.push(html`<text x="${X0 - 8}" y="${py + 4}" fill="var(--sol-text-3)" font-size="10.5px" text-anchor="end">${y}</text>`);
      }
      lines.push(html`<text x="${(X0 + X1) / 2}" y="325" fill="var(--sol-text-4)" font-size="11px" text-anchor="middle">time of day</text>`);
    } else if (key === "colour") {
      const xt = [0, 3, 6, 9, 12, 15, 18, 21, 24];
      // Derims ticks covering 2000K (100d) to 6000K (433d)
      const yt = [100, 200, 300, 400, 433.3];
      for (const x of xt) {
        const px = this.xp("colour", x);
        lines.push(html`<line x1="${px}" y1="${Y0}" x2="${px}" y2="${Y1}" stroke="rgba(255,255,255,0.08)" stroke-width="1"></line>`);
        lines.push(html`<text x="${px}" y="${Y1 + 16}" fill="var(--sol-text-3)" font-size="10.5px" text-anchor="middle">${String(x).padStart(2, "0")}:00</text>`);
      }
      for (const y of yt) {
        const py = this.yp("colour", y);
        const k = derimToKelvin(y);
        lines.push(html`<line x1="${X0}" y1="${py}" x2="${X1}" y2="${py}" stroke="rgba(255,255,255,0.08)" stroke-width="1"></line>`);
        lines.push(html`<text x="${X0 - 8}" y="${py + 4}" fill="var(--sol-text-3)" font-size="10.5px" text-anchor="end">${Math.round(y)}d (${k}K)</text>`);
      }
      lines.push(html`<text x="${(X0 + X1) / 2}" y="325" fill="var(--sol-text-4)" font-size="11px" text-anchor="middle">time of day (derims / kelvin)</text>`);
    }
    return lines;
  }

  private renderSolarVlines(key: CurveKey) {
    const world = this.snap?.world;
    if (!world) return nothing;
    const vlines = [];
    if (world.sunrise_hour !== null) {
      const x = this.xp(key, world.sunrise_hour);
      vlines.push(html`
        <line x1="${x}" y1="${Y0}" x2="${x}" y2="${Y1}" stroke="rgba(255,183,77,0.45)" stroke-dasharray="4 3"></line>
        <text x="${x + 4}" y="${Y0 + 12}" fill="#c99a4e" font-size="10px">sunrise</text>
      `);
    }
    if (world.sunset_hour !== null) {
      const x = this.xp(key, world.sunset_hour);
      vlines.push(html`
        <line x1="${x}" y1="${Y0}" x2="${x}" y2="${Y1}" stroke="rgba(255,183,77,0.45)" stroke-dasharray="4 3"></line>
        <text x="${x + 4}" y="${Y0 + 12}" fill="#ffb74d" font-size="10px">sunset</text>
      `);
    }
    if (world.dusk_hour !== null) {
      const x = this.xp(key, world.dusk_hour);
      vlines.push(html`
        <line x1="${x}" y1="${Y0}" x2="${x}" y2="${Y1}" stroke="rgba(149,117,205,0.7)" stroke-dasharray="4 3"></line>
        <text x="${x + 4}" y="${Y0 + 24}" fill="#b39ddb" font-size="10px">civil dusk</text>
      `);
    }
    return vlines;
  }

  private renderNodeEditor(key: CurveKey) {
    if (this.selKey !== key || this.selIdx === null) return nothing;
    const nodes = this.getNodes(key);
    const node = nodes[this.selIdx];
    if (!node) return nothing;

    const xLabel = key === "lux" ? "Lux" : "Hour";
    const yLabel = key === "lux" ? "Demand %" : key === "bright" ? "Level" : "Derim";

    return html`
      <div class="node-editor">
        <div style="font-size: 10.5px; text-transform: uppercase; color: var(--sol-text-3);">Node ${this.selIdx + 1}</div>
        <div style="font-size: 11px; color: var(--sol-text-2);">${xLabel}</div>
        <input
          type="text"
          .value="${key === "lux" ? String(Math.round(node.x)) : node.x.toFixed(2)}"
          @change="${(e: Event) => {
            const v = parseFloat((e.target as HTMLInputElement).value);
            if (!isNaN(v)) {
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
    if (key === "lux") return "Outdoor lux demand curve";
    if (key === "bright") return "24h target brightness schedule";
    return "24h target colour schedule (Derims)";
  }

  private getCardSubtitle(key: CurveKey): string {
    if (key === "lux") return "indoor demand against measured outdoor light";
    if (key === "bright") return "master level through the day";
    return "colour temperature in Derims (100d candle to 433d daylight)";
  }

  private renderLegend(key: CurveKey) {
    if (key === "lux") {
      return html`
        <div class="leg-item"><span class="chip" style="background: var(--sol-blue);"></span>demand</div>
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
    const spline = this.getSpline(key);
    const vx = this.px2x(key, this.hoverPx);
    const vy = spline.evaluate(vx);
    if (key === "lux") {
      return `Lux ${Math.round(vx)} lx   Demand ${Math.round(vy)}%`;
    }
    if (key === "bright") {
      const hr = Math.floor(vx);
      const min = Math.floor((vx % 1) * 60);
      const timeStr = `${String(hr).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
      return `Time ${timeStr}   Level ${Math.round(vy)} (${Math.round((vy / 254) * 100)}%)`;
    }
    const hr = Math.floor(vx);
    const min = Math.floor((vx % 1) * 60);
    const timeStr = `${String(hr).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    return `Time ${timeStr}   Colour ${formatDerimWithKelvin(vy)}`;
  }
}
