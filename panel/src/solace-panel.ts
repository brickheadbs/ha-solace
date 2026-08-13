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
import { customElement, property, state } from "lit/decorators.js";
import type { Hass, Snapshot } from "./api";
import { subscribe } from "./api";
import "./tab-colour";
import "./tab-home";
import "./tab-lighting";
import { tokens } from "./tokens";
import "./ui";

type Tab = "home" | "lighting" | "colour";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "home", label: "Home" },
  { id: "lighting", label: "Lighting" },
  { id: "colour", label: "Colour" },
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
    this.connect();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsub?.();
    this.unsub = undefined;
  }

  updated(changed: Map<string, unknown>) {
    // `hass` is replaced on every state change in HA, but the *connection* is stable —
    // so this only reconnects if the subscription was never established (a panel opened
    // before the integration finished loading).
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

  private renderTab() {
    if (!this.snap) return nothing;
    switch (this.tab) {
      case "lighting":
        return html`<sol-tab-lighting .hass=${this.hass} .snap=${this.snap}></sol-tab-lighting>`;
      case "colour":
        return html`<sol-tab-colour .hass=${this.hass} .snap=${this.snap}></sol-tab-colour>`;
      default:
        return html`<sol-tab-home .hass=${this.hass} .snap=${this.snap}></sol-tab-home>`;
    }
  }

  render() {
    const healthy = this.snap?.world.healthy ?? false;
    return html`
      <header>
        <div class="bar">
          <ha-icon class="brand" icon="mdi:tune"></ha-icon>
          <h1>Lighting Engine</h1>
          ${this.snap
            ? html`<span class="pill">
                <span class="dot ${healthy ? "" : "bad"}"></span>
                ${healthy ? "Engine running" : "Engine stalled"}
              </span>`
            : nothing}
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
