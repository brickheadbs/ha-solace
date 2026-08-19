/**
 * The Solace panel root.
 *
 * Home Assistant hands a custom panel four properties — `hass`, `narrow`, `route` and
 * `panel` — and expects a custom element registered under the name given to
 * `panel_custom.async_register_panel`.
 *
 * Everything below the app bar is driven by one WebSocket subscription. There is no save
 * button, no confirmation toast and no dirty state: values commit as they move, and the
 * snapshot that comes back is the truth. The panel keeps a short-lived local echo only
 * so a slider thumb tracks the finger rather than the round trip.
 *
 * ⚠️ The designer-notes drawer from the prototype is **deliberately not here.** It is a
 * design artefact documenting unresolved engine questions, and the handoff says not to
 * ship it.
 */

import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { customElement } from "./custom-element";
import type { Hass, Snapshot } from "./api";
import { subscribe } from "./api";
import { kelvinToDerim } from "./derim";
import "./tab-curves";
import "./tab-home";
import "./tab-lighting";
import "./tab-remotes";
import "./tab-settings";
import { tokens } from "./tokens";
import "./ui";

type Tab = "home" | "lighting" | "curves" | "settings" | "remotes";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "home", label: "Home" },
  { id: "lighting", label: "Lighting" },
  { id: "curves", label: "Master curves" },
  { id: "settings", label: "Settings & modes" },
  { id: "remotes", label: "Remotes" },
];

@customElement("solace-panel")
export class SolacePanel extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ type: Boolean }) narrow = false;

  @state() private tab: Tab = "home";
  @state() private snap: Snapshot | null = null;
  @state() private error: string | null = null;

  private unsub?: () => void;

  static styles = [
    tokens,
    css`
      :host {
        background: var(--sol-page);
        min-height: 100vh;
      }
      header {
        position: sticky;
        top: 0;
        z-index: 10;
        background: var(--sol-card);
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
      }
      .bar {
        height: 56px;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 0 18px;
        box-sizing: border-box;
      }
      .bar ha-icon.brand {
        --mdc-icon-size: 22px;
        color: var(--sol-text-3);
      }
      h1 {
        margin: 0;
        font-size: 19px;
        font-weight: 400;
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        font-size: 12px;
        color: var(--sol-text-3);
        background: var(--sol-control);
        border-radius: 12px;
        padding: 5px 11px;
        white-space: nowrap;
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--sol-green);
      }
      .dot.bad {
        background: var(--error-color, #ef5350);
      }
      nav {
        display: flex;
        gap: 0;
        padding: 0 18px 12px;
      }
      nav button {
        all: unset;
        cursor: pointer;
        font-size: 13.5px;
        font-weight: 500;
        letter-spacing: 0.6px;
        text-transform: uppercase;
        color: var(--sol-text-3);
        padding: 4px 14px 8px;
        border-bottom: 2px solid transparent;
      }
      nav button[aria-selected="true"] {
        color: var(--sol-cyan);
        border-bottom-color: var(--sol-cyan);
      }
      .status-banner {
        background: var(--sol-card-inner, rgba(0, 0, 0, 0.2));
        border-bottom: 1px solid var(--sol-border, rgba(255, 255, 255, 0.08));
        padding: 10px 18px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        font-size: 12.5px;
      }
      .status-group {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 14px;
      }
      .status-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--sol-text-2);
      }
      .status-item ha-icon {
        --mdc-icon-size: 16px;
        color: var(--sol-cyan);
      }
      .status-badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 8px;
        border-radius: 6px;
        font-size: 11.5px;
        font-weight: 500;
      }
      .badge-normal {
        background: rgba(76, 175, 80, 0.15);
        color: #81c784;
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
      .room-badges {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .room-chip {
        font-size: 11.5px;
        padding: 2px 7px;
        border-radius: 4px;
        background: var(--sol-control);
        color: var(--sol-text-3);
      }
      .room-chip.lit {
        color: var(--sol-text-1);
        border: 1px solid var(--sol-cyan);
      }
      main {
        max-width: 1180px;
        margin: 0 auto;
        padding: 18px 20px 48px;
      }
      .placeholder {
        max-width: 560px;
        margin: 64px auto;
        text-align: center;
        color: var(--sol-text-3);
        font-size: 13.5px;
        line-height: 1.7;
      }
      .placeholder ha-icon {
        --mdc-icon-size: 40px;
        color: var(--sol-text-4);
      }
      code {
        background: var(--sol-control);
        border-radius: 4px;
        padding: 1px 5px;
        font-size: 12px;
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    if (!document.getElementById("solace-adobe-fonts")) {
      const link = document.createElement("link");
      link.id = "solace-adobe-fonts";
      link.rel = "stylesheet";
      link.href = "https://use.typekit.net/yte7tax.css";
      document.head.appendChild(link);
    }
    this.connect();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsub?.();
    this.unsub = undefined;
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("hass") && this.hass && !this.unsub) this.connect();
  }

  private async connect() {
    if (!this.hass?.connection || this.unsub) return;
    try {
      this.unsub = await subscribe(this.hass, (snap) => {
        this.snap = snap;
        this.error = null;
      });
    } catch (err: unknown) {
      this.error =
        (err as { message?: string })?.message ??
        "Solace is not set up yet, or the integration failed to load.";
    }
  }

  private renderStatusHeader() {
    if (!this.snap) return nothing;
    const w = this.snap.world;
    let modeBadge = html`<span class="status-badge badge-normal">Normal</span>`;
    if (w.away) {
      modeBadge = html`<span class="status-badge badge-away"><ha-icon icon="mdi:airplane"></ha-icon> Away Mode</span>`;
    } else if (w.sunrise_progress !== null && w.sunrise_progress !== undefined) {
      modeBadge = html`<span class="status-badge badge-sunrise"><ha-icon icon="mdi:weather-sunset-up"></ha-icon> Sunrise Fade (${Math.round(w.sunrise_progress * 100)}%)</span>`;
    } else if (w.night_active) {
      modeBadge = html`<span class="status-badge badge-night"><ha-icon icon="mdi:weather-night"></ha-icon> Night Latched</span>`;
    } else if (w.bedtime_dwell_active) {
      modeBadge = html`<span class="status-badge badge-night"><ha-icon icon="mdi:bed"></ha-icon> Bedtime Wind-Down</span>`;
    }

    const masterTarget =
      w.master_target_brightness ??
      (w.demand !== null && w.demand !== undefined ? Math.round(w.demand * 254) : 254);
    const targetPct = Math.round((masterTarget / 254) * 100);
    const derimVal = Math.round(kelvinToDerim(w.kelvin ?? 4000));
    const luxStr = Math.round(w.lux).toLocaleString() + " lx";

    return html`
      <div class="status-banner">
        <div class="status-group">
          <span class="status-item">
            <span class="status-badge" style="background: rgba(33, 150, 243, 0.2); color: var(--sol-cyan); font-weight: 600; padding: 4px 10px; font-size: 12px;">
              <ha-icon icon="mdi:brightness-6" style="--mdc-icon-size: 15px; margin-right: 2px;"></ha-icon>
              Master Target <strong>${targetPct}%</strong>
            </span>
          </span>
          <span class="status-item">
            <ha-icon icon="mdi:white-balance-sunny"></ha-icon>
            <strong>${luxStr}</strong>
          </span>
          ${w.cloud_coverage !== null && w.cloud_coverage !== undefined
            ? html`<span class="status-item">
                <ha-icon icon="mdi:weather-cloudy"></ha-icon>
                ${Math.round(w.cloud_coverage)}% Clouds
              </span>`
            : nothing}
          <span class="status-item">
            <ha-icon icon="mdi:palette-outline"></ha-icon>
            <strong>${w.kelvin} K</strong> (${derimVal} Ɯ)
          </span>
          <span class="status-item">
            ${modeBadge}
          </span>
        </div>
        <div class="room-badges">
          ${this.snap.rooms.map((r) => {
            const lit = (r.level ?? 0) > 0;
            return html`<span class="room-chip ${lit ? "lit" : ""}">
              ${r.name}: ${r.manual.active ? "Manual" : lit ? `${r.level} lvl` : "Off"}
            </span>`;
          })}
        </div>
      </div>
    `;
  }

  private renderTab() {
    if (!this.snap) return nothing;
    switch (this.tab) {
      case "lighting":
        return html`<sol-tab-lighting .hass=${this.hass} .snap=${this.snap}></sol-tab-lighting>`;
      case "curves":
        return html`<sol-tab-curves .hass=${this.hass} .snap=${this.snap}></sol-tab-curves>`;
      case "settings":
        return html`<sol-tab-settings .hass=${this.hass} .snap=${this.snap}></sol-tab-settings>`;
      case "remotes":
        return html`<sol-tab-remotes .hass=${this.hass} .snap=${this.snap}></sol-tab-remotes>`;
      default:
        return html`<sol-tab-home .hass=${this.hass} .snap=${this.snap}></sol-tab-home>`;
    }
  }

  render() {
    return html`
      <header>
        <div class="bar">
          <ha-icon class="brand" icon="mdi:tune"></ha-icon>
          <h1>Lighting Engine</h1>
        </div>
        <nav role="tablist">
          ${TABS.map(
            (t) => html`<button
              role="tab"
              aria-selected=${this.tab === t.id}
              @click=${() => (this.tab = t.id)}
            >
              ${t.label}
            </button>`
          )}
        </nav>
        ${this.renderStatusHeader()}
      </header>
      <main>
        ${this.snap
          ? this.renderTab()
          : html`<div class="placeholder">
              <ha-icon icon=${this.error ? "mdi:alert-circle-outline" : "mdi:progress-clock"}></ha-icon>
              <p>
                ${this.error ??
                "Waiting for the engine…"}
              </p>
              ${this.error
                ? html`<p>
                    Add the integration under <code>Settings → Devices &amp; services</code>, then
                    add a room for each zone you want Solace to drive.
                  </p>`
                : nothing}
            </div>`}
      </main>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "solace-panel": SolacePanel;
  }
}
