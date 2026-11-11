/**
 * Engine Tab — Consolidates deep calibration views under clean sub-pills:
 *   Master curves | Colour & hardware | Modes & gate | Remotes
 */

import { LitElement, css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { customElement } from "./custom-element";
import type { Hass, Snapshot } from "./api";
import "./tab-colour";
import "./tab-curves";
import "./tab-remotes";
import "./tab-settings";
import { tokens } from "./tokens";

type EngineSubTab = "curves" | "colour" | "modes" | "remotes";

const SUBTABS: Array<{ id: EngineSubTab; label: string; icon: string }> = [
  { id: "curves", label: "Master curves", icon: "mdi:chart-bell-curve-cumulative" },
  { id: "colour", label: "Colour & hardware", icon: "mdi:palette-outline" },
  { id: "modes", label: "Modes & gate", icon: "mdi:tune-variant" },
  { id: "remotes", label: "Remotes", icon: "mdi:remote" },
];

@customElement("sol-tab-engine")
export class SolTabEngine extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;

  @state() private sub: EngineSubTab = "curves";

  static styles = [
    tokens,
    css`
      :host {
        display: block;
      }
      .sub-bar {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 6px;
        background: var(--sol-card);
        padding: 5px;
        border-radius: 12px;
        box-shadow: var(--sol-shadow);
        margin-bottom: 16px;
      }
      .sub-pill {
        border: none;
        background: transparent;
        color: var(--sol-text-3);
        font-family: inherit;
        font-size: 12.5px;
        font-weight: 500;
        padding: 6px 13px;
        border-radius: 9px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        transition: all 0.15s ease;
      }
      .sub-pill ha-icon {
        --mdc-icon-size: 16px;
      }
      .sub-pill:hover {
        color: var(--sol-text);
      }
      .sub-pill.active {
        background: rgba(86, 182, 194, 0.18);
        color: var(--sol-cyan);
      }
    `,
  ];

  private renderBody() {
    switch (this.sub) {
      case "colour":
        return html`<sol-tab-colour .hass=${this.hass} .snap=${this.snap}></sol-tab-colour>`;
      case "modes":
        return html`<sol-tab-settings .hass=${this.hass} .snap=${this.snap}></sol-tab-settings>`;
      case "remotes":
        return html`<sol-tab-remotes .hass=${this.hass} .snap=${this.snap}></sol-tab-remotes>`;
      default:
        return html`<sol-tab-curves .hass=${this.hass} .snap=${this.snap}></sol-tab-curves>`;
    }
  }

  render() {
    return html`
      <div class="sub-bar" role="tablist">
        ${SUBTABS.map(
          (t) => html`
            <button
              role="tab"
              class="sub-pill ${this.sub === t.id ? "active" : ""}"
              aria-selected=${this.sub === t.id}
              @click=${() => (this.sub = t.id)}
            >
              <ha-icon icon=${t.icon}></ha-icon>
              ${t.label}
            </button>
          `
        )}
      </div>
      ${this.renderBody()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-tab-engine": SolTabEngine;
  }
}
