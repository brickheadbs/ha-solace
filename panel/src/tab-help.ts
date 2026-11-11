/**
 * Help Tab — Concise, visual AuDHD-friendly Solace & Home Assistant Rules Blueprint.
 * Zero live telemetry flicker: renders static system architecture + configured cutoffs/caps.
 */

import { LitElement, css, html, svg } from "lit";
import { property } from "lit/decorators.js";
import { customElement } from "./custom-element";
import type { Hass, Snapshot } from "./api";
import { clock, num, stopLabel } from "./fmt";
import {
  CUTOFFS_AND_CLAMPS,
  HOUSE_AUTOMATIONS,
  PIPELINE_STAGES,
  PRIORITY_LADDER,
  ROOM_EXCEPTIONS,
} from "./rules-spec";
import { tokens } from "./tokens";

@customElement("sol-tab-help")
export class SolTabHelp extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;

  static styles = [
    tokens,
    css`
      :host {
        display: block;
        padding-bottom: 48px;
      }
      .stack {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .card {
        background: var(--sol-card);
        border-radius: var(--sol-r-card);
        padding: 16px 18px;
        box-shadow: var(--sol-shadow);
      }
      .head {
        display: flex;
        align-items: center;
        gap: 9px;
        margin-bottom: 12px;
      }
      .head ha-icon {
        --mdc-icon-size: 19px;
        color: var(--sol-cyan);
      }
      .head h2 {
        margin: 0;
        font-size: 15px;
        font-weight: 600;
        color: var(--sol-text);
      }
      .head .sub {
        margin-left: auto;
        font-size: 11.5px;
        color: var(--sol-text-4);
      }

      /* 1. Pipeline SVG + Stage Cards */
      .pipe-svg-wrap {
        width: 100%;
        overflow-x: auto;
        background: rgba(0, 0, 0, 0.22);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 10px;
        padding: 10px 8px;
        box-sizing: border-box;
      }
      .pipe-svg {
        display: block;
        width: 100%;
        min-width: 860px;
        height: auto;
      }
      .stage-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
        gap: 8px;
        margin-top: 12px;
      }
      .stage-box {
        background: var(--sol-control);
        border-radius: 8px;
        padding: 9px 11px;
        border-left: 3px solid var(--sol-cyan);
      }
      .stage-top {
        display: flex;
        align-items: baseline;
        gap: 6px;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--sol-text);
      }
      .stage-num {
        color: var(--sol-cyan);
        font-variant-numeric: tabular-nums;
      }
      .stage-math {
        margin-top: 4px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        color: var(--sol-amber);
        background: rgba(0, 0, 0, 0.28);
        padding: 3px 6px;
        border-radius: 4px;
        overflow-x: auto;
      }
      .stage-desc {
        margin-top: 5px;
        font-size: 11.5px;
        line-height: 1.45;
        color: var(--sol-text-3);
      }

      /* 2. Priority Ladder */
      .ladder {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .rung {
        display: grid;
        grid-template-columns: 32px 190px minmax(180px, 1fr) minmax(220px, 1.3fr) minmax(170px, 0.9fr);
        gap: 10px;
        align-items: center;
        background: var(--sol-control);
        border-radius: 8px;
        padding: 8px 12px;
        font-size: 12px;
      }
      @media (max-width: 900px) {
        .rung {
          grid-template-columns: 28px 1fr;
        }
      }
      .rank {
        width: 24px;
        height: 24px;
        border-radius: 6px;
        background: rgba(86, 182, 194, 0.16);
        color: var(--sol-cyan);
        font-weight: 700;
        font-size: 12px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .rung-top .rank {
        background: rgba(255, 183, 77, 0.2);
        color: var(--sol-amber);
      }
      .r-mode {
        font-weight: 600;
        color: var(--sol-text);
      }
      .r-trig {
        color: var(--sol-text-2);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
      }
      .r-out {
        color: var(--sol-text-2);
      }
      .r-rel {
        color: var(--sol-text-4);
        font-size: 11.5px;
      }

      /* 3. Room Exceptions & Cutoffs */
      .exc-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
        gap: 12px;
      }
      @media (max-width: 520px) {
        .exc-grid {
          grid-template-columns: 1fr;
        }
      }
      .exc-card {
        background: var(--sol-control);
        border-radius: 10px;
        padding: 12px 14px;
        border: 1px solid rgba(255, 255, 255, 0.06);
      }
      .exc-card.highlight {
        border-color: rgba(255, 183, 77, 0.4);
        background: rgba(255, 183, 77, 0.05);
      }
      .exc-title {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
      }
      .exc-title h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--sol-text);
      }
      .exc-title span {
        font-size: 11px;
        color: var(--sol-amber);
      }
      .exc-row {
        display: grid;
        grid-template-columns: 150px 1fr;
        gap: 8px;
        padding: 6px 0;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
        font-size: 12px;
      }
      .exc-k {
        font-weight: 600;
        color: var(--sol-text-2);
      }
      .exc-v {
        color: var(--sol-text-3);
        line-height: 1.45;
      }

      /* Configured Cutoffs Table */
      .tbl {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .tbl th {
        text-align: left;
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        color: var(--sol-text-4);
        padding: 6px 8px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }
      .tbl td {
        padding: 8px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        vertical-align: top;
        color: var(--sol-text-2);
        line-height: 1.45;
      }
      .scope-pill {
        display: inline-block;
        padding: 2px 7px;
        border-radius: 5px;
        font-size: 10.5px;
        font-weight: 600;
        background: rgba(86, 182, 194, 0.15);
        color: var(--sol-cyan);
      }
      .cfg-val {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11.5px;
        color: var(--sol-amber);
        white-space: nowrap;
      }

      /* 4. Automation Strips */
      .auto-group {
        margin-top: 10px;
      }
      .auto-group:first-of-type {
        margin-top: 0;
      }
      .auto-group-lbl {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.8px;
        text-transform: uppercase;
        color: var(--sol-text-4);
        margin-bottom: 6px;
      }
      .strip-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .auto-strip {
        display: grid;
        grid-template-columns: 175px 1fr auto 1fr auto 1fr;
        gap: 8px;
        align-items: center;
        background: var(--sol-control);
        border-radius: 8px;
        padding: 8px 12px;
        font-size: 12px;
      }
      @media (max-width: 900px) {
        .auto-strip {
          grid-template-columns: 1fr;
        }
        .arrow {
          display: none;
        }
      }
      .a-name {
        font-weight: 600;
        color: var(--sol-text);
      }
      .a-box {
        background: rgba(0, 0, 0, 0.24);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 6px;
        padding: 5px 8px;
        color: var(--sol-text-2);
        font-size: 11.5px;
      }
      .a-box.guard {
        border-color: rgba(255, 183, 77, 0.25);
        color: var(--sol-text-3);
      }
      .a-box.act {
        border-color: rgba(86, 182, 194, 0.3);
        color: var(--sol-text);
      }
      .a-tag {
        display: block;
        font-size: 9.5px;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        color: var(--sol-text-4);
        margin-bottom: 2px;
      }
      .arrow {
        color: var(--sol-cyan);
        font-weight: 700;
        font-size: 13px;
      }
    `,
  ];

  private configuredValueFor(key: string): string {
    const h = this.snap?.house ?? {};
    const rooms = this.snap?.rooms ?? [];
    switch (key) {
      case "threshold_stops": {
        const parts = rooms
          .map((r) => `${r.name}: ${stopLabel(Number(r.settings.threshold_stops ?? 0))}`)
          .join(", ");
        return parts || "0 stops";
      }
      case "bias_stops":
        return `House ${stopLabel(h.bias_stops ?? 0)}`;
      case "min_cutoff":
        return `${num(h.min_cutoff ?? 48)} / 254`;
      case "clamp_min / clamp_max": {
        const count = rooms.reduce(
          (acc, r) => acc + r.lights.filter((l) => l.clamp_min !== null || l.clamp_max !== null).length,
          0
        );
        return `${count} fixture overrides`;
      }
      case "occupied_min / occupied_max": {
        const stair = rooms.find((r) => r.name.toLowerCase().includes("stair"));
        if (!stair) return "0 .. 254";
        return `Stairway: ${stair.settings.occupied_min ?? 0} .. ${stair.settings.occupied_max ?? 254}`;
      }
      case "ambience_start_lux / ambience_stop_lux":
        return `${num(h.ambience_start_lux ?? 50)} / ${num(h.ambience_stop_lux ?? 80)} lx`;
      case "family_rgb_max_kelvin":
        return `>= ${num(h.family_rgb_max_kelvin ?? 7000)} K -> RGB`;
      default:
        return "—";
    }
  }

  private renderPipelineSvg() {
    const boxW = 114;
    const boxH = 52;
    const gap = 16;
    const startX = 10;
    const y = 12;
    const totalW = startX * 2 + PIPELINE_STAGES.length * boxW + (PIPELINE_STAGES.length - 1) * gap;

    return html`
      <div class="pipe-svg-wrap">
        <svg class="pipe-svg" viewBox="0 0 ${totalW} 76" role="img" aria-label="Solace 7-stage signal pipeline">
          ${PIPELINE_STAGES.map((st, idx) => {
            const x = startX + idx * (boxW + gap);
            const nextX = x + boxW;
            return svg`
              <rect
                x="${x}"
                y="${y}"
                width="${boxW}"
                height="${boxH}"
                rx="8"
                fill="#222528"
                stroke="${idx === 4 || idx === 5 ? "#ffb74d" : "#56b6c2"}"
                stroke-width="1.4"
              />
              <text x="${x + 8}" y="${y + 18}" fill="#56b6c2" font-size="10" font-weight="700">
                STEP ${st.step}
              </text>
              <text x="${x + 8}" y="${y + 36}" fill="#eef1f4" font-size="11.5" font-weight="600">
                ${st.title}
              </text>
              ${
                idx < PIPELINE_STAGES.length - 1
                  ? svg`
                      <line
                        x1="${nextX + 2}"
                        y1="${y + boxH / 2}"
                        x2="${nextX + gap - 4}"
                        y2="${y + boxH / 2}"
                        stroke="#56b6c2"
                        stroke-width="1.6"
                      />
                      <polygon
                        points="${nextX + gap - 2},${y + boxH / 2} ${nextX + gap - 7},${y + boxH / 2 - 4} ${nextX + gap - 7},${y + boxH / 2 + 4}"
                        fill="#56b6c2"
                      />
                    `
                  : svg``
              }
            `;
          })}
        </svg>
      </div>
    `;
  }

  render() {
    const h = this.snap?.house ?? {};
    const groups = ["Front Door & U200 Lock", "Lighting & Presence", "Appliances & Safety"] as const;

    return html`
      <div class="stack">
        <!-- 1. Signal Flow Pipeline -->
        <div class="card">
          <div class="head">
            <ha-icon icon="mdi:transit-connection-variant"></ha-icon>
            <h2>1. Lighting Signal Pipeline (Left to Right)</h2>
            <span class="sub">
              Day ${num(h.day_kelvin ?? 4000)} K -> Night ${num(h.night_kelvin ?? 2190)} K · Dawn release ${clock(h.morning_release_hour ?? 6.5)}
            </span>
          </div>
          ${this.renderPipelineSvg()}
          <div class="stage-grid">
            ${PIPELINE_STAGES.map(
              (st) => html`
                <div class="stage-box">
                  <div class="stage-top">
                    <span class="stage-num">${st.step}.</span>
                    <span>${st.title}</span>
                  </div>
                  <div class="stage-math">${st.formula}</div>
                  <div class="stage-desc">${st.summary}</div>
                </div>
              `
            )}
          </div>
        </div>

        <!-- 2. Override Priority Ladder -->
        <div class="card">
          <div class="head">
            <ha-icon icon="mdi:format-list-numbered"></ha-icon>
            <h2>2. Override Priority Ladder (Highest Wins First)</h2>
            <span class="sub">First matching rule controls the fixture</span>
          </div>
          <div class="ladder">
            ${PRIORITY_LADDER.map(
              (r) => html`
                <div class="rung ${r.rank <= 3 ? "rung-top" : ""}">
                  <span class="rank">${r.rank}</span>
                  <div class="r-mode">${r.mode}</div>
                  <div class="r-trig">${r.trigger}</div>
                  <div class="r-out">${r.outputRule}</div>
                  <div class="r-rel">Unlatches: ${r.releaseRule}</div>
                </div>
              `
            )}
          </div>
        </div>

        <!-- 3. Room Exceptions & Configured Cutoffs -->
        <div class="card">
          <div class="head">
            <ha-icon icon="mdi:floor-plan"></ha-icon>
            <h2>3. Room Exceptions &amp; Special Wiring</h2>
            <span class="sub">Where individual rooms diverge from standard house rules</span>
          </div>
          <div class="exc-grid">
            ${ROOM_EXCEPTIONS.map(
              (rm) => html`
                <div class="exc-card ${rm.room === "Stairway" ? "highlight" : ""}">
                  <div class="exc-title">
                    <h3>${rm.room}</h3>
                    <span>${rm.subtitle}</span>
                  </div>
                  ${rm.rules.map(
                    (rule) => html`
                      <div class="exc-row">
                        <div class="exc-k">${rule.label}</div>
                        <div class="exc-v">${rule.detail}</div>
                      </div>
                    `
                  )}
                </div>
              `
            )}
          </div>
        </div>

        <!-- 3B. Cutoffs, Caps & Compensations -->
        <div class="card">
          <div class="head">
            <ha-icon icon="mdi:tune-vertical"></ha-icon>
            <h2>4. Cutoffs, Caps, Compensations &amp; Hardware Rails</h2>
            <span class="sub">Configured rule parameters (static settings, no live sensor noise)</span>
          </div>
          <table class="tbl">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Scope</th>
                <th>Configured</th>
                <th>Exact Behavior</th>
                <th>When Disarmed / Exempt</th>
              </tr>
            </thead>
            <tbody>
              ${CUTOFFS_AND_CLAMPS.map(
                (c) => html`
                  <tr>
                    <td><strong>${c.name}</strong></td>
                    <td><span class="scope-pill">${c.scope}</span></td>
                    <td class="cfg-val">${this.configuredValueFor(c.key)}</td>
                    <td>${c.rule}</td>
                    <td>${c.exemptions}</td>
                  </tr>
                `
              )}
            </tbody>
          </table>
        </div>

        <!-- 4. House Automations Strips -->
        <div class="card">
          <div class="head">
            <ha-icon icon="mdi:sitemap-outline"></ha-icon>
            <h2>5. House Automations ([Trigger] -> [Guard] -> [Action])</h2>
            <span class="sub">Cross-device wiring outside the core lux solver</span>
          </div>
          ${groups.map((grp) => {
            const items = HOUSE_AUTOMATIONS.filter((a) => a.group === grp);
            return html`
              <div class="auto-group">
                <div class="auto-group-lbl">${grp}</div>
                <div class="strip-list">
                  ${items.map(
                    (a) => html`
                      <div class="auto-strip">
                        <div class="a-name" title=${a.entityId}>${a.name}</div>
                        <div class="a-box">
                          <span class="a-tag">Trigger</span>
                          ${a.trigger}
                        </div>
                        <span class="arrow">-&gt;</span>
                        <div class="a-box guard">
                          <span class="a-tag">Guard</span>
                          ${a.guard}
                        </div>
                        <span class="arrow">-&gt;</span>
                        <div class="a-box act">
                          <span class="a-tag">Action</span>
                          ${a.action}
                        </div>
                      </div>
                    `
                  )}
                </div>
              </div>
            `;
          })}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-tab-help": SolTabHelp;
  }
}
