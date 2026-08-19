/**
 * The shared chart frame for both charts.
 *
 * ⚠️ **Tick labels, axis titles and reference-line annotations are HTML, absolutely
 * positioned over the SVG — not SVG `<text>`.** The handoff is emphatic about this and
 * it is not stylistic: it gives real text metrics, which is what makes collision
 * handling possible. Sunset and civil dusk sit about 30 minutes apart and overprint
 * otherwise.
 *
 * The percentage positions are computed from viewBox coordinates, so the SVG must render
 * at exactly its viewBox aspect ratio — hence `width:100%; height:auto` and no explicit
 * height anywhere in the layout.
 */

import { LitElement, css, html, nothing, svg } from "lit";
import { property } from "lit/decorators.js";
import { customElement } from "./custom-element";
import { tokens } from "./tokens";

export const VB_W = 760;
export const VB_H = 258;
const PLOT = { x0: 58, x1: 744, y0: 16, y1: 206 };

export interface Series {
  points: Array<[number, number]>;
  colour: string;
  width?: number;
  /** An SVG gradient id to stroke with instead of a flat colour. */
  gradient?: string;
  dashed?: boolean;
}

export interface RefLine {
  /** Vertical line at this x-domain value. */
  x: number;
  label: string;
  colour: string;
  textColour: string;
}

export interface Tick {
  value: number;
  label: string;
}

export interface Fact {
  label: string;
  value: string;
}

/** Real text metrics, synchronously, without a layout pass. */
let ctx: CanvasRenderingContext2D | null = null;
const textWidth = (text: string): number => {
  if (!ctx) {
    ctx = document.createElement("canvas").getContext("2d");
    if (ctx) ctx.font = "10px Roboto, system-ui, sans-serif";
  }
  return ctx ? ctx.measureText(text).width : text.length * 5.4;
};

@customElement("sol-chart")
export class SolChart extends LitElement {
  @property({ attribute: false }) series: Series[] = [];
  @property({ attribute: false }) refLines: RefLine[] = [];
  @property({ attribute: false }) xTicks: Tick[] = [];
  @property({ attribute: false }) yTicks: Tick[] = [];
  @property({ attribute: false }) facts: Fact[] = [];
  @property({ attribute: false }) xDomain: [number, number] = [0, 1];
  @property({ attribute: false }) yDomain: [number, number] = [0, 1];
  @property({ attribute: false }) marker: { x: number; y: number } | null = null;
  @property() xTitle = "";
  @property() yTitle = "";
  /** Shade the region where the ambient gate overrides demand — see below. */
  @property({ attribute: false }) shade: [number, number] | null = null;
  @property() shadeLabel = "";

  static styles = [
    tokens,
    css`
      :host {
        display: flex;
        gap: 14px;
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .plot {
        position: relative;
        flex: 1 1 420px;
        min-width: 300px;
      }
      svg {
        display: block;
        width: 100%;
        height: auto;
      }
      .lbl {
        position: absolute;
        font-size: 10px;
        color: var(--sol-text-4);
        white-space: nowrap;
        pointer-events: none;
        font-variant-numeric: tabular-nums;
      }
      .lbl.y {
        transform: translate(-100%, -50%);
        padding-right: 6px;
      }
      .lbl.x {
        transform: translate(-50%, 2px);
      }
      .lbl.ann {
        transform: translate(-50%, 0);
        font-size: 10px;
      }
      .axis-title {
        position: absolute;
        font-size: 10.5px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        color: var(--sol-text-4);
      }
      .facts {
        flex: 0 0 198px;
        background: #232426;
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: var(--sol-r-block);
        padding: 10px 12px;
        box-sizing: border-box;
      }
      .facts .row {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        font-size: 11px;
        line-height: 1.75;
      }
      .facts .row span:first-child {
        color: var(--sol-text-4);
      }
      .facts .row span:last-child {
        color: var(--sol-text-2);
        font-variant-numeric: tabular-nums;
      }
      @media (max-width: 720px) {
        .facts {
          flex: 1 1 100%;
        }
      }
    `,
  ];

  private sx(v: number): number {
    const [a, b] = this.xDomain;
    return PLOT.x0 + ((v - a) / (b - a || 1)) * (PLOT.x1 - PLOT.x0);
  }

  private sy(v: number): number {
    const [a, b] = this.yDomain;
    return PLOT.y1 - ((v - a) / (b - a || 1)) * (PLOT.y1 - PLOT.y0);
  }

  private path(points: Array<[number, number]>): string {
    let d = "";
    let pen = false;
    for (const [x, y] of points) {
      if (!isFinite(x) || !isFinite(y)) {
        // A gap, not a jump to zero — at 54°N civil dusk genuinely does not occur on
        // some midsummer days, and drawing through that would invent a curve.
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${this.sx(x).toFixed(2)} ${this.sy(y).toFixed(2)} `;
      pen = true;
    }
    return d.trim();
  }

  /**
   * Greedy row packing for the reference-line annotations: sort by x, then drop a label
   * one row (13 viewBox units) only when it would overlap the one to its left.
   */
  private packed(): Array<RefLine & { row: number; px: number }> {
    const rows: number[] = [];
    return this.refLines
      .filter((r) => isFinite(r.x))
      .map((r) => ({ ...r, px: this.sx(r.x) }))
      .sort((a, b) => a.px - b.px)
      .map((r) => {
        const half = textWidth(r.label) / 2 + 4;
        let row = 0;
        while (rows[row] !== undefined && rows[row] > r.px - half) row++;
        rows[row] = r.px + half;
        return { ...r, row };
      });
  }

  render() {
    const packed = this.packed();
    return html`
      <div class="plot">
        <svg viewBox="0 0 ${VB_W} ${VB_H}" role="img">
          <defs>
            <linearGradient id="kgrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#cfe0ff" />
              <stop offset="50%" stop-color="#ffe4c4" />
              <stop offset="100%" stop-color="#ff9a3c" />
            </linearGradient>
          </defs>

          ${this.shade
            ? svg`<rect
                x=${this.sx(this.shade[0])}
                y=${PLOT.y0}
                width=${Math.max(0, this.sx(this.shade[1]) - this.sx(this.shade[0]))}
                height=${PLOT.y1 - PLOT.y0}
                fill="rgba(240,98,146,.10)" />`
            : nothing}

          ${this.yTicks.map(
            (t) =>
              svg`<line x1=${PLOT.x0} x2=${PLOT.x1} y1=${this.sy(t.value)} y2=${this.sy(
                t.value
              )} stroke="rgba(255,255,255,.07)" stroke-width="1" />`
          )}
          ${this.xTicks.map(
            (t) =>
              svg`<line y1=${PLOT.y0} y2=${PLOT.y1} x1=${this.sx(t.value)} x2=${this.sx(
                t.value
              )} stroke="rgba(255,255,255,.07)" stroke-width="1" />`
          )}
          ${this.refLines.map(
            (r) =>
              svg`<line y1=${PLOT.y0} y2=${PLOT.y1} x1=${this.sx(r.x)} x2=${this.sx(
                r.x
              )} stroke=${r.colour} stroke-width="1" stroke-dasharray="4 3" />`
          )}
          ${this.series.map(
            (s) =>
              svg`<path d=${this.path(s.points)} fill="none"
                stroke=${s.gradient ? `url(#${s.gradient})` : s.colour}
                stroke-width=${s.width ?? 2}
                stroke-linejoin="round"
                stroke-linecap="round"
                stroke-dasharray=${s.dashed ? "4 3" : "0"} />`
          )}
          ${this.marker
            ? svg`<circle cx=${this.sx(this.marker.x)} cy=${this.sy(this.marker.y)} r="5"
                fill="var(--sol-cyan)" stroke="var(--sol-card)" stroke-width="1.5" />`
            : nothing}
        </svg>

        ${this.yTicks.map(
          (t) =>
            html`<div
              class="lbl y"
              style="left:${(PLOT.x0 / VB_W) * 100}%;top:${(this.sy(t.value) / VB_H) * 100}%"
            >
              ${t.label}
            </div>`
        )}
        ${this.xTicks.map(
          (t) =>
            html`<div
              class="lbl x"
              style="left:${(this.sx(t.value) / VB_W) * 100}%;top:${(PLOT.y1 / VB_H) * 100}%"
            >
              ${t.label}
            </div>`
        )}
        ${packed.map(
          (r) =>
            html`<div
              class="lbl ann"
              style="left:${(r.px / VB_W) * 100}%;top:${((PLOT.y0 + 2 + r.row * 13) / VB_H) *
              100}%;color:${r.textColour}"
            >
              ${r.label}
            </div>`
        )}
        ${this.shadeLabel && this.shade
          ? html`<div
              class="lbl ann"
              style="left:${((this.sx(this.shade[0]) + this.sx(this.shade[1])) / 2 / VB_W) *
              100}%;top:${((PLOT.y1 - 16) / VB_H) * 100}%;color:var(--sol-series-full)"
            >
              ${this.shadeLabel}
            </div>`
          : nothing}
        ${this.xTitle
          ? html`<div class="axis-title" style="left:50%;bottom:-2px;transform:translateX(-50%)">
              ${this.xTitle}
            </div>`
          : nothing}
      </div>

      ${this.facts.length
        ? html`<div class="facts">
            ${this.facts.map(
              (f) => html`<div class="row"><span>${f.label}</span><span>${f.value}</span></div>`
            )}
          </div>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-chart": SolChart;
  }
}
