/**
 * Remotes Management tab for Solace panel.
 *
 * Configures physical Styrbar / Zigbee remote button mappings across Entry,
 * Kitchen, Bedroom, and Living Office with 2-layer (Press & Hold) tabs.
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Hass, RemoteRow, Snapshot } from "./api";
import { setRemotes } from "./api";
import { tokens } from "./tokens";
import "./ui";

const ACTION_OPTIONS = [
  { value: "cycle_preset_levels", label: "Toggle Preset Loop (Auto → 50% → 80% → 100%)" },
  { value: "toggle_auto_manual", label: "Toggle Auto / Manual" },
  { value: "turn_off", label: "Turn Off Room Lights" },
  { value: "nudge_bias_up", label: "Nudge Bias Up (+0.5 stops)" },
  { value: "nudge_bias_down", label: "Nudge Bias Down (-0.5 stops)" },
  { value: "toggle_manual", label: "Hold Manual Switch" },
  { value: "toggle_sleep", label: "Toggle Sleep / Night Mode" },
  { value: "leaving_5_min", label: "Leaving in 5 Minutes (Countdown → Away)" },
  { value: "none", label: "Disabled / No Action" },
];

@customElement("sol-tab-remotes")
export class TabRemotes extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;

  // Active sub-tab (press vs hold) per remote id
  @state() private activeLayer: Record<string, "press" | "hold"> = {};

  static styles = [
    tokens,
    css`
      :host {
        display: block;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
        gap: 16px;
      }
      .remote-card {
        padding: 16px;
      }
      .remote-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 8px;
      }
      .remote-header ha-icon {
        --mdc-icon-size: 24px;
        color: var(--sol-cyan);
      }
      .remote-title {
        flex: 1;
        font-size: 16px;
        font-weight: 500;
        color: var(--sol-text-1);
      }
      .remote-room-tag {
        font-size: 11.5px;
        padding: 3px 8px;
        border-radius: 6px;
        background: var(--sol-control);
        color: var(--sol-text-3);
      }
      .entity-sub {
        font-size: 11.5px;
        color: var(--sol-text-4);
        margin-bottom: 12px;
        font-family: monospace;
      }
      .layer-nav {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
        border-bottom: 1px solid var(--sol-hair);
        padding-bottom: 8px;
      }
      .layer-nav button {
        all: unset;
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
        padding: 4px 10px;
        border-radius: 6px;
        color: var(--sol-text-3);
        background: var(--sol-control);
      }
      .layer-nav button.active {
        background: var(--sol-cyan-track);
        color: var(--sol-cyan);
      }
      .button-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .button-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 10px;
        background: var(--sol-card-inner);
        border-radius: 8px;
      }
      .btn-label {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: var(--sol-text-2);
      }
      .btn-label ha-icon {
        --mdc-icon-size: 18px;
        color: var(--sol-text-3);
      }
      select {
        background: var(--sol-control);
        color: var(--sol-text-1);
        border: 1px solid var(--sol-border, rgba(255, 255, 255, 0.1));
        border-radius: 6px;
        padding: 5px 8px;
        font-size: 12px;
        outline: none;
        cursor: pointer;
        max-width: 210px;
      }
      select:focus {
        border-color: var(--sol-cyan);
      }
      option:disabled {
        color: var(--sol-text-4);
      }
    `,
  ];

  private async updateRemote(index: number, field: keyof RemoteRow, value: string) {
    const remotes: RemoteRow[] = JSON.parse(
      JSON.stringify(this.snap.remotes || [])
    );
    if (!remotes[index]) return;
    (remotes[index] as any)[field] = value;
    try {
      await setRemotes(this.hass, remotes);
    } catch (e) {
      console.error("Failed to update remote settings", e);
    }
  }

  private renderButtonSelect(
    remote: RemoteRow,
    remoteIndex: number,
    field: keyof RemoteRow,
    label: string,
    icon: string,
    currentValue?: string
  ) {
    const value = currentValue || (field.startsWith("hold") ? "none" : "cycle_preset_levels");

    // Collect already assigned actions on this remote (excluding current field and "none")
    const allAssigned = Object.entries(remote)
      .filter(([k]) => k !== field && (k.startsWith("button_") || k.startsWith("hold_")))
      .map(([_, v]) => v)
      .filter((v) => v && v !== "none");

    return html`
      <div class="button-row">
        <span class="btn-label">
          <ha-icon icon=${icon}></ha-icon>
          ${label}
        </span>
        <select
          @change=${(e: Event) =>
            this.updateRemote(
              remoteIndex,
              field,
              (e.target as HTMLSelectElement).value
            )}
        >
          ${ACTION_OPTIONS.map((opt) => {
            const isAssigned = opt.value !== "none" && allAssigned.includes(opt.value) && opt.value !== value;
            return html`<option
              value=${opt.value}
              ?selected=${value === opt.value}
              ?disabled=${isAssigned}
            >
              ${opt.label}${isAssigned ? " (Already assigned)" : ""}
            </option>`;
          })}
        </select>
      </div>
    `;
  }

  render() {
    const remotes = this.snap.remotes || [];
    if (remotes.length === 0) {
      return html`
        <div class="card" style="padding: 24px; text-align: center; color: var(--sol-text-3);">
          No remotes configured. Add sensors to <code>options.remotes</code>.
        </div>
      `;
    }

    return html`
      <div class="grid">
        ${remotes.map((remote, idx) => {
          const layer = this.activeLayer[remote.remote_id] || "press";
          return html`
            <div class="card remote-card">
              <div class="remote-header">
                <ha-icon icon="mdi:remote"></ha-icon>
                <span class="remote-title">${remote.name}</span>
                <span class="remote-room-tag">${remote.room_name || "Unassigned"}</span>
              </div>
              <div class="entity-sub">${remote.action_entity || "sensor.*_action"}</div>

              <div class="layer-nav">
                <button
                  class=${layer === "press" ? "active" : ""}
                  @click=${() => {
                    this.activeLayer = { ...this.activeLayer, [remote.remote_id]: "press" };
                  }}
                >
                  <ha-icon icon="mdi:gesture-tap"></ha-icon> Single Press
                </button>
                <button
                  class=${layer === "hold" ? "active" : ""}
                  @click=${() => {
                    this.activeLayer = { ...this.activeLayer, [remote.remote_id]: "hold" };
                  }}
                >
                  <ha-icon icon="mdi:gesture-tap-hold"></ha-icon> Long Press / Hold
                </button>
              </div>

              <div class="button-list">
                ${layer === "press"
                  ? html`
                      ${this.renderButtonSelect(
                        remote,
                        idx,
                        "button_up",
                        "Top / Arrow Up",
                        "mdi:arrow-up-bold",
                        remote.button_up || remote.button_on
                      )}
                      ${this.renderButtonSelect(
                        remote,
                        idx,
                        "button_down",
                        "Bottom / Arrow Down",
                        "mdi:arrow-down-bold",
                        remote.button_down || remote.button_off
                      )}
                      ${this.renderButtonSelect(
                        remote,
                        idx,
                        "button_left",
                        "Left Arrow",
                        "mdi:arrow-left-bold",
                        remote.button_left
                      )}
                      ${this.renderButtonSelect(
                        remote,
                        idx,
                        "button_right",
                        "Right Arrow",
                        "mdi:arrow-right-bold",
                        remote.button_right
                      )}
                    `
                  : html`
                      ${this.renderButtonSelect(
                        remote,
                        idx,
                        "hold_up",
                        "Top Hold",
                        "mdi:arrow-up-bold-box-outline",
                        remote.hold_up
                      )}
                      ${this.renderButtonSelect(
                        remote,
                        idx,
                        "hold_down",
                        "Bottom Hold",
                        "mdi:arrow-down-bold-box-outline",
                        remote.hold_down
                      )}
                      ${this.renderButtonSelect(
                        remote,
                        idx,
                        "hold_left",
                        "Left Hold",
                        "mdi:arrow-left-bold-box-outline",
                        remote.hold_left
                      )}
                      ${this.renderButtonSelect(
                        remote,
                        idx,
                        "hold_right",
                        "Right Hold",
                        "mdi:arrow-right-bold-box-outline",
                        remote.hold_right
                      )}
                    `}
              </div>
            </div>
          `;
        })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-tab-remotes": TabRemotes;
  }
}
