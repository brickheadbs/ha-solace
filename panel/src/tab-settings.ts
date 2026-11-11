/**
 * Modes & Gate Sub-Tab (under Engine) — Work Mode, Guest Mode, Ambience Gate,
 * Daytime Cutoffs / Astronomical Fallback Clocks (HH:MM), and 8-path Transitions Matrix.
 */

import { LitElement, css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { customElement } from "./custom-element";
import type { Hass, Snapshot } from "./api";
import { setHouse, toggleGuestMode, toggleWorkMode } from "./api";
import { clock, parseClock } from "./fmt";
import { tokens } from "./tokens";
import "./ui";

@customElement("sol-tab-settings")
export class SolTabSettings extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;

  static styles = [
    tokens,
    css`
      :host {
        display: block;
        padding-bottom: 40px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(460px, 1fr));
        gap: 14px;
        align-items: start;
      }
      .full-col {
        grid-column: 1 / -1;
      }
      .card {
        background: var(--sol-card);
        border-radius: var(--sol-r-card);
        padding: 15px 18px 16px;
        box-shadow: var(--sol-shadow);
      }
      .head {
        display: flex;
        align-items: center;
        gap: 9px;
        margin-bottom: 12px;
      }
      .title {
        font-size: 15px;
        font-weight: 500;
        color: var(--sol-text);
      }
      .spacer {
        flex: 1;
      }
      .modes-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
        gap: 16px;
      }
      .bed-card {
        background: var(--sol-control);
        border-radius: 10px;
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
      }
      .bed-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .bed-title {
        font-size: 14px;
        font-weight: 500;
        color: var(--sol-text);
      }
      .triggers-bar {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        margin: 8px 0 12px;
        padding: 9px 12px;
        background: rgba(0, 0, 0, 0.25);
        border-radius: 8px;
      }
      .trigger-item {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 5px 10px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 6px;
        font-size: 12px;
        color: var(--sol-text-3);
      }
      .trigger-item.active {
        background: rgba(255, 183, 77, 0.16);
        border-color: rgba(255, 183, 77, 0.35);
        color: #ffb74d;
      }
      .trigger-item ha-icon {
        --mdc-icon-size: 16px;
      }
      .manual-sleep-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border-radius: 6px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: var(--sol-card);
        color: var(--sol-text-2);
        font-family: inherit;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        margin-left: auto;
      }
      .manual-sleep-btn.active-work {
        background: rgba(33, 150, 243, 0.22);
        border-color: #64b5f6;
        color: #64b5f6;
      }
      .sleep-inputs-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 12px 18px;
        margin-top: auto;
        padding-top: 10px;
        border-top: 1px solid rgba(255, 255, 255, 0.07);
      }
      .input-with-unit {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .unit-label {
        font-size: 11.5px;
        color: var(--sol-text-3);
        white-space: nowrap;
      }
      .badge {
        display: inline-block;
        padding: 3px 8px;
        border-radius: 5px;
        font-size: 11px;
        font-weight: 500;
      }
      .badge-amber {
        background: rgba(255, 183, 77, 0.18);
        color: #ffb74d;
      }
      .badge-blue {
        background: rgba(33, 150, 243, 0.2);
        color: #64b5f6;
      }
      .badge-dim {
        background: rgba(255, 255, 255, 0.06);
        color: var(--sol-text-3);
      }
      .num-input,
      .time-input {
        box-sizing: border-box;
        background: var(--sol-card);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        padding: 5px 8px;
        font-family: inherit;
        font-size: 12.5px;
        color: var(--sol-text);
        outline: none;
      }
      .num-input {
        text-align: right;
      }
      .time-input {
        color: var(--sol-cyan);
        font-weight: 600;
      }
      .trans-grp {
        background: var(--sol-control);
        border-radius: 8px;
        padding: 12px 14px;
      }
      .grp-lbl {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        font-weight: 700;
        color: var(--sol-text-3);
        margin-bottom: 7px;
      }
      .trans-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 7px;
      }
      .trans-lbl {
        font-size: 12.5px;
        color: var(--sol-text-2);
        white-space: nowrap;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .trans-dots {
        flex: 1;
        border-bottom: 1px dotted rgba(255, 255, 255, 0.12);
        height: 1px;
      }
      .trans-path {
        font-size: 10.5px;
        color: var(--sol-text-4);
        background: rgba(255, 255, 255, 0.04);
        padding: 1px 6px;
        border-radius: 4px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
    `,
  ];

  render() {
    const house = this.snap?.house ?? {};
    const world = this.snap?.world;
    const workActive =
      this.hass.states["input_boolean.work_mode"]?.state === "on" || !!world?.work_mode;
    const guestActive =
      this.hass.states["input_boolean.living_guest_mode"]?.state === "on" || !!world?.guest_mode;
    const gateOpen = !!this.snap?.rooms?.some((r) => r.ambience_open);
    const gateInverted =
      (house.ambience_start_lux ?? 50) > (house.ambience_stop_lux ?? 80);

    return html`
      <div class="grid">
        <!-- 1. Special Room Modes -->
        <div class="card full-col">
          <div class="head">
            <ha-icon icon="mdi:tune" style="color: var(--sol-blue);"></ha-icon>
            <div class="title">Special Room Modes (Work &amp; Guest)</div>
          </div>
          <div class="modes-row">
            <!-- Work Mode -->
            <div class="bed-card">
              <div class="bed-head">
                <ha-icon icon="mdi:desk-lamp" style="color: var(--sol-blue);"></ha-icon>
                <div class="bed-title">Work mode (Living Office)</div>
                <div class="spacer"></div>
                <div class="badge ${workActive ? "badge-blue" : "badge-dim"}">
                  ${workActive ? "Working (Active)" : "Standby"}
                </div>
              </div>

              <div class="triggers-bar">
                <div class="trigger-item ${workActive ? "active" : ""}">
                  <ha-icon icon="mdi:gesture-tap-hold"></ha-icon>
                  <span>Sonoff Button: <strong>Hold to toggle</strong></span>
                </div>
                <button
                  class="manual-sleep-btn ${workActive ? "active-work" : ""}"
                  @click=${() => toggleWorkMode(this.hass)}
                >
                  <ha-icon icon="mdi:desk-lamp"></ha-icon>
                  <span>Work Mode: <strong>${workActive ? "ON" : "OFF"}</strong></span>
                </button>
              </div>

              <div class="sleep-inputs-grid">
                <div>
                  <div style="font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">Desk lamp</div>
                  <div class="input-with-unit">
                    <input
                      type="number"
                      class="num-input"
                      style="flex: 1;"
                      min="0"
                      max="254"
                      .value=${String(house.work_mode_desk_level ?? 254)}
                      @change=${(e: Event) =>
                        setHouse(this.hass, { work_mode_desk_level: parseFloat((e.target as HTMLInputElement).value) })}
                    />
                    <span class="unit-label">/254</span>
                  </div>
                </div>

                <div>
                  <div style="font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">Backlight</div>
                  <div class="input-with-unit">
                    <input
                      type="number"
                      class="num-input"
                      style="flex: 1;"
                      min="0"
                      max="254"
                      .value=${String(house.work_mode_backlight_level ?? 200)}
                      @change=${(e: Event) =>
                        setHouse(this.hass, { work_mode_backlight_level: parseFloat((e.target as HTMLInputElement).value) })}
                    />
                    <span class="unit-label">/254</span>
                  </div>
                </div>

                <div>
                  <div style="font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">Corner</div>
                  <div class="input-with-unit">
                    <input
                      type="number"
                      class="num-input"
                      style="flex: 1;"
                      min="0"
                      max="254"
                      .value=${String(house.work_mode_corner_level ?? 180)}
                      @change=${(e: Event) =>
                        setHouse(this.hass, { work_mode_corner_level: parseFloat((e.target as HTMLInputElement).value) })}
                    />
                    <span class="unit-label">/254</span>
                  </div>
                </div>

                <div>
                  <div style="font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">Clear debounce</div>
                  <div class="input-with-unit">
                    <input
                      type="number"
                      class="num-input"
                      style="flex: 1;"
                      min="0.5"
                      max="60"
                      step="0.5"
                      .value=${String(house.work_mode_debounce_minutes ?? 5)}
                      @change=${(e: Event) =>
                        setHouse(this.hass, { work_mode_debounce_minutes: parseFloat((e.target as HTMLInputElement).value) })}
                    />
                    <span class="unit-label">min</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- Guest Mode -->
            <div class="bed-card">
              <div class="bed-head">
                <ha-icon icon="mdi:account-star" style="color: var(--sol-cyan);"></ha-icon>
                <div class="bed-title">Guest mode (Living Office)</div>
                <div class="spacer"></div>
                <div class="badge ${guestActive ? "badge-blue" : "badge-dim"}">
                  ${guestActive ? "Guest Staying" : "Standby"}
                </div>
              </div>

              <div class="triggers-bar">
                <div class="trigger-item ${guestActive ? "active" : ""}">
                  <ha-icon icon="mdi:remote"></ha-icon>
                  <span>Styrbar: <strong>Office Control</strong></span>
                </div>
                <button
                  class="manual-sleep-btn ${guestActive ? "active-work" : ""}"
                  @click=${() => toggleGuestMode(this.hass)}
                >
                  <ha-icon icon="mdi:account-star"></ha-icon>
                  <span>Guest Mode: <strong>${guestActive ? "ON" : "OFF"}</strong></span>
                </button>
              </div>

              <div style="font-size: 12px; color: var(--sol-text-3); line-height: 1.55; margin-top: 4px;">
                Suppresses overnight motion turn-on in Living Office while Sleep Mode is active so a
                sleeping guest is never woken by rolling over. Guest controls room lights directly via
                the Styrbar remote.
              </div>
            </div>
          </div>
        </div>

        <!-- 2. Ambience Gate & Daytime Cutoffs -->
        <div class="card full-col">
          <div class="head">
            <ha-icon icon="mdi:theme-light-dark" style="color: var(--sol-blue);"></ha-icon>
            <div class="title">Ambience Gate, Cutoffs &amp; Fallback Clocks</div>
            <div class="spacer"></div>
            <div class="badge ${gateOpen ? "badge-amber" : "badge-dim"}">
              ${gateOpen ? "Open · ambience armed" : "Closed · daylight"}
            </div>
          </div>

          <div class="sleep-inputs-grid" style="border-top: none; padding-top: 0;">
            <div>
              <div style="font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">
                Gate start lux (opens)
              </div>
              <div class="input-with-unit">
                <input
                  type="number"
                  class="num-input"
                  style="flex: 1;"
                  min="0"
                  max="2000"
                  .value=${String(house.ambience_start_lux ?? 50)}
                  @change=${(e: Event) => {
                    const v = parseFloat((e.target as HTMLInputElement).value);
                    if (!Number.isNaN(v)) setHouse(this.hass, { ambience_start_lux: v });
                  }}
                />
                <span class="unit-label">lx</span>
              </div>
            </div>

            <div>
              <div style="font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">
                Gate stop lux (closes)
              </div>
              <div class="input-with-unit">
                <input
                  type="number"
                  class="num-input"
                  style="flex: 1;"
                  min="0"
                  max="2000"
                  .value=${String(house.ambience_stop_lux ?? 80)}
                  @change=${(e: Event) => {
                    const v = parseFloat((e.target as HTMLInputElement).value);
                    if (!Number.isNaN(v)) setHouse(this.hass, { ambience_stop_lux: v });
                  }}
                />
                <span class="unit-label">lx</span>
              </div>
            </div>

            <div>
              <div style="font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">
                Daytime low cutoff
              </div>
              <div class="input-with-unit">
                <input
                  type="number"
                  class="num-input"
                  style="flex: 1;"
                  min="0"
                  max="120"
                  .value=${String(house.min_cutoff ?? 48)}
                  @change=${(e: Event) => {
                    const v = parseFloat((e.target as HTMLInputElement).value);
                    if (!Number.isNaN(v)) setHouse(this.hass, { min_cutoff: v });
                  }}
                />
                <span class="unit-label">/254</span>
              </div>
            </div>

            <div>
              <div style="font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">
                Write dead-zone &amp; Manual hold
              </div>
              <div class="input-with-unit">
                <input
                  type="number"
                  class="num-input"
                  style="width: 58px;"
                  min="0"
                  max="30"
                  .value=${String(house.dead_zone ?? 8)}
                  @change=${(e: Event) => {
                    const v = parseFloat((e.target as HTMLInputElement).value);
                    if (!Number.isNaN(v)) setHouse(this.hass, { dead_zone: v });
                  }}
                />
                <span class="unit-label">lvl</span>
                <input
                  type="number"
                  class="num-input"
                  style="width: 62px;"
                  min="5"
                  max="480"
                  .value=${String(house.manual_hold_minutes ?? 60)}
                  @change=${(e: Event) => {
                    const v = parseFloat((e.target as HTMLInputElement).value);
                    if (!Number.isNaN(v)) setHouse(this.hass, { manual_hold_minutes: v });
                  }}
                />
                <span class="unit-label">min</span>
              </div>
            </div>

            <div>
              <div style="font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">
                Evening ramp axis (HH:MM)
              </div>
              <div class="input-with-unit">
                <input
                  type="time"
                  class="time-input"
                  style="flex: 1;"
                  .value=${clock(house.evening_axis_hour ?? 20.0)}
                  @change=${(e: Event) => {
                    const raw = (e.target as HTMLInputElement).value;
                    if (raw) setHouse(this.hass, { evening_axis_hour: parseClock(raw) });
                  }}
                />
              </div>
            </div>

            <div>
              <div style="font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">
                Civil dusk fallback (HH:MM)
              </div>
              <div class="input-with-unit">
                <input
                  type="time"
                  class="time-input"
                  style="flex: 1;"
                  .value=${clock(house.dusk_fallback_hour ?? 20.0)}
                  @change=${(e: Event) => {
                    const raw = (e.target as HTMLInputElement).value;
                    if (raw) setHouse(this.hass, { dusk_fallback_hour: parseClock(raw) });
                  }}
                />
              </div>
            </div>
          </div>

          ${gateInverted
            ? html`<div style="margin-top: 10px; font-size: 11.5px; color: #ffb74d;">
                Start lux is above stop lux — hysteresis band is inverted.
              </div>`
            : nothing}
        </div>

        <!-- 3. Transitions Matrix -->
        <div class="card full-col">
          <div class="head">
            <ha-icon icon="mdi:speedometer" style="color: var(--sol-blue);"></ha-icon>
            <div class="title">Transitions Matrix</div>
            <div class="spacer"></div>
            <div style="font-size: 11px; color: var(--sol-text-4);">seconds</div>
          </div>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;">
            <div class="trans-grp">
              <div class="grp-lbl">Up</div>
              <div class="trans-row">
                <div class="trans-lbl">Occupancy</div>
                <div class="trans-dots"></div>
                <div class="trans-path">Clear -&gt; L1</div>
                <input
                  type="number"
                  step="0.5"
                  class="num-input"
                  style="width: 62px;"
                  .value=${String(house.transition_up_occupancy_s ?? 2.0)}
                  @change=${(e: Event) =>
                    setHouse(this.hass, { transition_up_occupancy_s: parseFloat((e.target as HTMLInputElement).value) })}
                />
              </div>
              <div class="trans-row">
                <div class="trans-lbl">Occupied Turn-On</div>
                <div class="trans-dots"></div>
                <div class="trans-path">Occupied L0 -&gt; L1</div>
                <input
                  type="number"
                  step="0.5"
                  class="num-input"
                  style="width: 62px;"
                  .value=${String(house.transition_up_occupied_on_s ?? 300.0)}
                  @change=${(e: Event) =>
                    setHouse(this.hass, { transition_up_occupied_on_s: parseFloat((e.target as HTMLInputElement).value) })}
                />
              </div>
              <div class="trans-row">
                <div class="trans-lbl">Ambience Wake</div>
                <div class="trans-dots"></div>
                <div class="trans-path">Clear -&gt; L3</div>
                <input
                  type="number"
                  step="0.5"
                  class="num-input"
                  style="width: 62px;"
                  .value=${String(house.transition_up_ambience_s ?? 10.0)}
                  @change=${(e: Event) =>
                    setHouse(this.hass, { transition_up_ambience_s: parseFloat((e.target as HTMLInputElement).value) })}
                />
              </div>
            </div>

            <div class="trans-grp">
              <div class="grp-lbl">Down</div>
              <div class="trans-row">
                <div class="trans-lbl">Diminish</div>
                <div class="trans-dots"></div>
                <div class="trans-path">L1 -&gt; L2</div>
                <input
                  type="number"
                  step="0.5"
                  class="num-input"
                  style="width: 62px;"
                  .value=${String(house.transition_down_diminish_s ?? 5.0)}
                  @change=${(e: Event) =>
                    setHouse(this.hass, { transition_down_diminish_s: parseFloat((e.target as HTMLInputElement).value) })}
                />
              </div>
              <div class="trans-row">
                <div class="trans-lbl">Ambience Settle</div>
                <div class="trans-dots"></div>
                <div class="trans-path">L2 -&gt; L3</div>
                <input
                  type="number"
                  step="0.5"
                  class="num-input"
                  style="width: 62px;"
                  .value=${String(house.transition_down_ambience_s ?? 5.0)}
                  @change=${(e: Event) =>
                    setHouse(this.hass, { transition_down_ambience_s: parseFloat((e.target as HTMLInputElement).value) })}
                />
              </div>
              <div class="trans-row">
                <div class="trans-lbl">Environmental / Off</div>
                <div class="trans-dots"></div>
                <div class="trans-path">L* -&gt; L0</div>
                <input
                  type="number"
                  step="0.5"
                  class="num-input"
                  style="width: 62px;"
                  .value=${String(house.transition_down_off_s ?? 4.0)}
                  @change=${(e: Event) =>
                    setHouse(this.hass, { transition_down_off_s: parseFloat((e.target as HTMLInputElement).value) })}
                />
              </div>
            </div>

            <div class="trans-grp">
              <div class="grp-lbl">Continuous &amp; Special</div>
              <div class="trans-row">
                <div class="trans-lbl">Continuous Tracking</div>
                <div class="trans-dots"></div>
                <div class="trans-path">Update L1</div>
                <input
                  type="number"
                  step="0.5"
                  class="num-input"
                  style="width: 62px;"
                  .value=${String(house.transition_automatic_s ?? 15.0)}
                  @change=${(e: Event) =>
                    setHouse(this.hass, { transition_automatic_s: parseFloat((e.target as HTMLInputElement).value) })}
                />
              </div>
              <div class="trans-row">
                <div class="trans-lbl">Manual Drag</div>
                <div class="trans-dots"></div>
                <div class="trans-path">UI Drag</div>
                <input
                  type="number"
                  step="0.05"
                  class="num-input"
                  style="width: 62px;"
                  .value=${String(house.transition_manual_s ?? 0.5)}
                  @change=${(e: Event) =>
                    setHouse(this.hass, { transition_manual_s: parseFloat((e.target as HTMLInputElement).value) })}
                />
              </div>
              <div class="trans-row">
                <div class="trans-lbl">Special Mode</div>
                <div class="trans-dots"></div>
                <div class="trans-path">Sunrise / Sunset</div>
                <div style="font-size: 11px; color: var(--sol-blue); font-weight: 500; padding: 4px 8px; background: rgba(59, 130, 246, 0.1); border-radius: 4px;">
                  Predictive
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-tab-settings": SolTabSettings;
  }
}
