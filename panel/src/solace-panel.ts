/**
 * The Solace panel root.
 *
 * Tabs:
 *   Home | Lighting | Wake-up | Wind-down | Music | Engine | Help
 * Plus a header "Reorder" lock/unlock button on Home and Lighting.
 */

import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { customElement } from "./custom-element";
import type { Hass, Snapshot } from "./api";
import { subscribe } from "./api";
import { kelvinToDerim } from "./derim";
import "./tab-engine";
import "./tab-heating";
import "./tab-help";
import "./tab-home";
import "./tab-lighting";
import "./tab-modes";
import "./tab-music";
import "./tab-wakeup";
import "./tab-winddown";
import { tokens } from "./tokens";
import "./ui";

type Tab = "home" | "lighting" | "modes" | "wakeup" | "winddown" | "music" | "heating" | "engine" | "help";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "home", label: "Home" },
  { id: "lighting", label: "Lighting" },
  { id: "modes", label: "Modes" },
  { id: "wakeup", label: "Wake-up" },
  { id: "winddown", label: "Wind-down" },
  { id: "music", label: "Music" },
  { id: "heating", label: "Heating" },
  { id: "engine", label: "Engine" },
  { id: "help", label: "Help" },
];

@customElement("solace-panel")
export class SolacePanel extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ type: Boolean }) narrow = false;

  @state() private tab: Tab = "home";
  @state() private reorderMode = false;
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
      .reorder-toggle {
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: var(--sol-control);
        color: var(--sol-text-2);
        border-radius: 10px;
        padding: 5px 11px;
        font-family: inherit;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .reorder-toggle ha-icon {
        --mdc-icon-size: 15px;
      }
      .reorder-toggle.active {
        border-color: var(--sol-cyan);
        background: rgba(86, 182, 194, 0.18);
        color: var(--sol-cyan);
      }
      nav {
        display: flex;
        gap: 0;
        padding: 0 18px 12px;
        overflow-x: auto;
      }
      nav button {
        all: unset;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0.6px;
        text-transform: uppercase;
        color: var(--sol-text-3);
        padding: 4px 14px 8px;
        border-bottom: 2px solid transparent;
        white-space: nowrap;
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
            <strong>${w.kelvin} K</strong> (${derimVal} M)
          </span>
          <span class="status-item">${modeBadge}</span>
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

  private renderRateBadge() {
    const rateZone = this.hass?.states?.["sensor.electricity_rate_zone"]?.state ?? "";
    if (!rateZone || rateZone === "unknown" || rateZone === "unavailable") {
      return nothing;
    }
    const isPeak = rateZone.startsWith("Peak");
    const isNight = rateZone.startsWith("Night");
    const bg = isPeak
      ? "rgba(239, 83, 80, 0.14)"
      : isNight
        ? "rgba(102, 187, 106, 0.14)"
        : "var(--sol-control)";
    const fg = isPeak ? "#ef9a9a" : isNight ? "#a5d6a7" : "var(--sol-text-2)";
    const border = isPeak
      ? "1px solid rgba(239, 83, 80, 0.32)"
      : isNight
        ? "1px solid rgba(102, 187, 106, 0.32)"
        : "1px solid rgba(255, 255, 255, 0.08)";
    const iconColor = isPeak ? "#ef5350" : isNight ? "#81c784" : "var(--sol-text-3)";

    return html`
      <span
        class="pill"
        style="background: ${bg}; color: ${fg}; border: ${border}; font-weight: 500;"
        title="Electricity Tariff Rate Zone"
      >
        <ha-icon icon="mdi:lightning-bolt" style="--mdc-icon-size: 15px; color: ${iconColor};"></ha-icon>
        ${rateZone}
      </span>
    `;
  }

  private renderTab() {
    if (!this.snap) return nothing;
    switch (this.tab) {
      case "lighting":
        return html`<sol-tab-lighting
          .hass=${this.hass}
          .snap=${this.snap}
          .reorderMode=${this.reorderMode}
        ></sol-tab-lighting>`;
      case "modes":
        return html`<sol-tab-modes .hass=${this.hass} .snap=${this.snap}></sol-tab-modes>`;
      case "wakeup":
        return html`<sol-tab-wakeup .hass=${this.hass} .snap=${this.snap}></sol-tab-wakeup>`;
      case "winddown":
        return html`<sol-tab-winddown .hass=${this.hass} .snap=${this.snap}></sol-tab-winddown>`;
      case "music":
        return html`<sol-tab-music .hass=${this.hass} .snap=${this.snap}></sol-tab-music>`;
      case "heating":
        return html`<sol-tab-heating .hass=${this.hass}></sol-tab-heating>`;
      case "engine":
        return html`<sol-tab-engine .hass=${this.hass} .snap=${this.snap}></sol-tab-engine>`;
      case "help":
        return html`<sol-tab-help .hass=${this.hass} .snap=${this.snap}></sol-tab-help>`;
      default:
        return html`<sol-tab-home
          .hass=${this.hass}
          .snap=${this.snap}
          .reorderMode=${this.reorderMode}
        ></sol-tab-home>`;
    }
  }

  render() {
    const canReorder = this.tab === "home" || this.tab === "lighting";
    return html`
      <header>
        <div class="bar">
          <ha-icon class="brand" icon="mdi:tune"></ha-icon>
          <h1>Solace</h1>
          ${canReorder
            ? html`
                <button
                  class="reorder-toggle ${this.reorderMode ? "active" : ""}"
                  @click=${() => (this.reorderMode = !this.reorderMode)}
                  title="Drag or use arrows to reorder cards"
                >
                  <ha-icon icon=${this.reorderMode ? "mdi:check" : "mdi:drag"}></ha-icon>
                  ${this.reorderMode ? "Done ordering" : "Reorder cards"}
                </button>
              `
            : nothing}
          ${this.renderRateBadge()}
        </div>
        <nav role="tablist">
          ${TABS.map(
            (t) => html`<button
              role="tab"
              aria-selected=${this.tab === t.id}
              @click=${() => {
                this.tab = t.id;
                if (t.id !== "home" && t.id !== "lighting") this.reorderMode = false;
              }}
            >
              ${t.label}
            </button>`
          )}
        </nav>
        ${this.tab !== "home" && this.tab !== "help" ? this.renderStatusHeader() : nothing}
      </header>
      <main>
        ${this.snap
          ? this.renderTab()
          : html`<div class="placeholder">
              <ha-icon icon=${this.error ? "mdi:alert-circle-outline" : "mdi:progress-clock"}></ha-icon>
              <p>${this.error ?? "Waiting for the engine..."}</p>
              ${this.error
                ? html`<p>
                    Add the integration under <code>Settings -&gt; Devices &amp; services</code>, then
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
