/**
 * Remotes Management tab for Solace panel.
 *
 * Configures physical Styrbar / Zigbee remote button mappings across Entry,
 * Kitchen, Bedroom, and Living Office.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Hass, RemoteRow, Snapshot } from "./api";
import { setRemotes } from "./api";
import { tokens } from "./tokens";
import "./ui";

const ACTION_OPTIONS = [
  { value: "toggle_auto_manual", label: "Toggle Auto / Manual" },
  { value: "turn_off", label: "Turn Off Room Lights" },
  { value: "nudge_bias_up", label: "Nudge Bias Up (+0.5 stops)" },
  { value: "nudge_bias_down", label: "Nudge Bias Down (-0.5 stops)" },
  { value: "toggle_manual", label: "Hold Manual Switch" },
  { value: "toggle_sleep", label: "Toggle Sleep / Night Mode" },
  { value: "none", label: "Disabled / No Action" },
];

@customElement("sol-tab-remotes")
export class TabRemotes extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;

  static styles = [
    tokens,
    css`
      :host {
        display: block;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
        gap: 16px;
      }
      .remote-card {
        padding: 16px;
      }
      .remote-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 14px;
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
        font-size: 12.5px;
        outline: none;
        cursor: pointer;
        max-width: 200px;
      }
      select:focus {
        border-color: var(--sol-cyan);
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
    remoteIndex: number,
    field: keyof RemoteRow,
    label: string,
    icon: string,
    currentValue?: string
  ) {
    const value = currentValue || "toggle_auto_manual";
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
          ${ACTION_OPTIONS.map(
            (opt) =>
              html`<option value=${opt.value} ?selected=${value === opt.value}>
                ${opt.label}
              </option>`
          )}
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
          return html`
            <div class="card remote-card">
              <div class="remote-header">
                <ha-icon icon="mdi:remote"></ha-icon>
                <span class="remote-title">${remote.name}</span>
                <span class="remote-room-tag">${remote.room_name || "Unassigned"}</span>
              </div>
              <div class="entity-sub">${remote.action_entity || "sensor.*_action"}</div>
              <div class="button-list">
                ${this.renderButtonSelect(
                  idx,
                  "button_up",
                  "Top / Arrow Up",
                  "mdi:arrow-up-bold",
                  remote.button_up || remote.button_on
                )}
                ${this.renderButtonSelect(
                  idx,
                  "button_down",
                  "Bottom / Arrow Down",
                  "mdi:arrow-down-bold",
                  remote.button_down || remote.button_off
                )}
                ${this.renderButtonSelect(
                  idx,
                  "button_left",
                  "Left Arrow",
                  "mdi:arrow-left-bold",
                  remote.button_left
                )}
                ${this.renderButtonSelect(
                  idx,
                  "button_right",
                  "Right Arrow",
                  "mdi:arrow-right-bold",
                  remote.button_right
                )}
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
