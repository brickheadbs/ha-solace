/**
 * Settings & Modes Tab — Bedroom Special Modes, Housewide Night Mode, and 8-path Transitions Matrix.
 */

import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Hass, Snapshot } from "./api";
import { setHouse, setRoom } from "./api";
import { formatDerimWithKelvin, kelvinToDerim } from "./derim";
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
      .sub {
        font-size: 11.5px;
        color: var(--sol-text-3);
        line-height: 1.55;
        margin-bottom: 6px;
      }
      .spacer {
        flex: 1;
      }
      .bed-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 12px;
      }
      .bed-card {
        background: var(--sol-control);
        border-radius: 8px;
        padding: 12px 13px;
      }
      .bed-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 7px;
      }
      .bed-title {
        font-size: 13px;
        font-weight: 500;
        color: var(--sol-text);
      }
      .badge {
        display: inline-block;
        padding: 2px 7px;
        border-radius: 4px;
        font: 500 10.5px Roboto, sans-serif;
        margin-bottom: 8px;
      }
      .badge-amber {
        background: rgba(255, 183, 77, 0.14);
        color: #ffcc80;
      }
      .badge-blue {
        background: rgba(79, 195, 247, 0.14);
        color: #81d4fa;
      }
      .toggle-btn {
        border: none;
        cursor: pointer;
        border-radius: 12px;
        padding: 4px 11px;
        font: 500 11.5px Roboto, sans-serif;
        transition: background 0.15s;
      }
      .toggle-on {
        background: #3b4a52;
        color: var(--sol-blue);
      }
      .toggle-off {
        background: var(--sol-card);
        color: var(--sol-text-3);
      }
      .toggle-sleep-on {
        background: #4a3f28;
        color: var(--sol-amber);
      }
      .field-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 7px 0;
      }
      .field-label {
        flex: 0 0 168px;
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 12.5px;
        color: var(--sol-text-2);
      }
      .field-readout {
        flex: 0 0 96px;
        text-align: right;
        font-size: 12.5px;
        font-variant-numeric: tabular-nums;
        color: var(--sol-text);
      }
      .num-input {
        box-sizing: border-box;
        background: var(--sol-card);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        padding: 5px 6px;
        text-align: center;
        color: var(--sol-text);
        font-size: 12.5px;
        outline: none;
      }
      .trans-grp {
        border-top: 1px solid rgba(255, 255, 255, 0.07);
        margin-top: 9px;
        padding-top: 8px;
      }
      .grp-lbl {
        font-size: 10.5px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        color: var(--sol-text-4);
        margin-bottom: 7px;
      }
      .trans-row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 7px;
      }
      .trans-lbl {
        font-size: 12.5px;
        color: var(--sol-text-2);
        min-width: 0;
        white-space: nowrap;
      }
      .trans-dots {
        flex: 1;
        border-bottom: 1px dotted rgba(255, 255, 255, 0.12);
        height: 1px;
      }
      .trans-path {
        font-size: 11px;
        color: var(--sol-text-4);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
    `,
  ];

  private findBedroom() {
    return this.snap?.rooms?.find(
      (r) => r.name.toLowerCase().includes("bed") || r.subentry_id.includes("bedroom")
    );
  }

  render() {
    const house = this.snap?.house ?? {};
    const bed = this.findBedroom();
    const bedSettings = bed?.settings ?? {};

    const sleepActive = !!this.snap?.world?.asleep;
    const riseActive = !!bedSettings.sunrise_enabled;
    const setActive = !!bedSettings.sunset_enabled;

    return html`
      <div class="grid">
        <!-- 1. Bedroom Special Modes -->
        <div class="card full-col">
          <div class="head">
            <ha-icon icon="mdi:bed-outline" style="color: var(--sol-blue);"></ha-icon>
            <div class="title">Bedroom special modes</div>
          </div>
          <div class="bed-grid">
            <!-- Mode 1: Sleep -->
            <div class="bed-card">
              <div class="bed-head">
                <ha-icon icon="mdi:weather-night" style="color: var(--sol-amber);"></ha-icon>
                <div class="bed-title">1 · Sleep mode</div>
                <div class="spacer"></div>
                <button
                  class="toggle-btn ${sleepActive ? "toggle-sleep-on" : "toggle-off"}"
                  @click="${() => {
                    // Toggles DND / sleep mode
                  }}"
                >
                  ${sleepActive ? "On" : "Off"}
                </button>
              </div>
              <div class="badge badge-amber">Forced off across all modes</div>
              <div style="font-size: 11.5px; color: var(--sol-text-3); line-height: 1.55; margin-bottom: 8px;">
                Forces bedroom lights to dark even during a 04:30 summer sunrise or daytime nap.
              </div>
              <div style="font-size: 11px; color: var(--sol-text-4); line-height: 1.5;">
                Trigger · Pixel 8a DND priority_only or manual sleep switch
              </div>
            </div>

            <!-- Mode 2: Virtual Sunrise -->
            <div class="bed-card">
              <div class="bed-head">
                <ha-icon icon="mdi:weather-sunset-up" style="color: var(--sol-amber);"></ha-icon>
                <div class="bed-title">2 · Virtual sunrise</div>
                <div class="spacer"></div>
                <button
                  class="toggle-btn ${riseActive ? "toggle-on" : "toggle-off"}"
                  @click="${() => {
                    if (bed) setRoom(this.hass, bed.subentry_id, { sunrise_enabled: !riseActive });
                  }}"
                >
                  ${riseActive ? "On" : "Off"}
                </button>
              </div>
              <div class="badge badge-blue">Daylight gated</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 9px 12px; margin-bottom: 8px;">
                <div>
                  <div style="font-size: 11px; color: var(--sol-text-3); margin-bottom: 4px;">Fade duration</div>
                  <input
                    type="number"
                    class="num-input"
                    style="width: 100%;"
                    .value="${String(house.alarm_lead_minutes ?? 30)}"
                    @change="${(e: Event) => {
                      const v = parseFloat((e.target as HTMLInputElement).value);
                      setHouse(this.hass, { alarm_lead_minutes: v });
                    }}"
                  />
                </div>
                <div>
                  <div style="font-size: 11px; color: var(--sol-text-3); margin-bottom: 4px;">Target level</div>
                  <input
                    type="number"
                    class="num-input"
                    style="width: 100%;"
                    .value="${String(house.sunrise_target_level ?? 180)}"
                    @change="${(e: Event) => {
                      const v = parseInt((e.target as HTMLInputElement).value, 10);
                      setHouse(this.hass, { sunrise_target_level: v });
                    }}"
                  />
                </div>
              </div>
              <div style="font-size: 11px; color: var(--sol-text-4); line-height: 1.5;">
                Skips fade if natural morning light is already bright.
              </div>
            </div>

            <!-- Mode 3: Virtual Sunset -->
            <div class="bed-card">
              <div class="bed-head">
                <ha-icon icon="mdi:weather-sunset-down" style="color: var(--sol-amber);"></ha-icon>
                <div class="bed-title">3 · Virtual sunset</div>
                <div class="spacer"></div>
                <button
                  class="toggle-btn ${setActive ? "toggle-on" : "toggle-off"}"
                  @click="${() => {
                    if (bed) setRoom(this.hass, bed.subentry_id, { sunset_enabled: !setActive });
                  }}"
                >
                  ${setActive ? "On" : "Off"}
                </button>
              </div>
              <div class="badge badge-blue">Daylight gated</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 9px 12px; margin-bottom: 8px;">
                <div>
                  <div style="font-size: 11px; color: var(--sol-text-3); margin-bottom: 4px;">Fade duration</div>
                  <input
                    type="number"
                    class="num-input"
                    style="width: 100%;"
                    .value="${String(house.bedtime_dwell_duration_minutes ?? 20)}"
                    @change="${(e: Event) => {
                      const v = parseFloat((e.target as HTMLInputElement).value);
                      setHouse(this.hass, { bedtime_dwell_duration_minutes: v });
                    }}"
                  />
                </div>
                <div>
                  <div style="font-size: 11px; color: var(--sol-text-3); margin-bottom: 4px;">Bedtime trigger</div>
                  <input
                    type="number"
                    class="num-input"
                    style="width: 100%;"
                    .value="${String(house.bedtime_dwell_hour ?? 22.5)}"
                    @change="${(e: Event) => {
                      const v = parseFloat((e.target as HTMLInputElement).value);
                      setHouse(this.hass, { bedtime_dwell_hour: v });
                    }}"
                  />
                </div>
              </div>
              <div style="font-size: 11px; color: var(--sol-text-4); line-height: 1.5;">
                Fades down toward dark before sleep time.
              </div>
            </div>
          </div>
        </div>

        <!-- 2. Housewide Night Mode -->
        <div class="card">
          <div class="head">
            <ha-icon icon="mdi:weather-night" style="color: var(--sol-blue);"></ha-icon>
            <div class="title">Housewide night mode</div>
          </div>
          <div class="sub">Overrides curves overnight with one fixed low warm level — Ls.</div>

          <div class="field-row">
            <div class="field-label">
              Night level
              <sol-help text="Fixed level used overnight instead of the curve. Lower it until it only just reads."></sol-help>
            </div>
            <input
              type="range"
              min="0"
              max="50"
              step="1"
              .value="${String(house.night_level ?? 3)}"
              @input="${(e: Event) => {
                const v = parseInt((e.target as HTMLInputElement).value, 10);
                setHouse(this.hass, { night_level: v });
              }}"
              style="flex: 1;"
            />
            <div class="field-readout">${house.night_level ?? 3} / 254</div>
          </div>

          <div class="field-row">
            <div class="field-label">
              Night kelvin (derim)
              <sol-help text="Colour held overnight. Measured in Derims / Kelvin. Lower derim is warmer."></sol-help>
            </div>
            <input
              type="range"
              min="2000"
              max="3000"
              step="50"
              .value="${String(house.night_kelvin ?? 2200)}"
              @input="${(e: Event) => {
                const v = parseInt((e.target as HTMLInputElement).value, 10);
                setHouse(this.hass, { night_kelvin: v });
              }}"
              style="flex: 1;"
            />
            <div class="field-readout">${formatDerimWithKelvin(kelvinToDerim(house.night_kelvin ?? 2200))}</div>
          </div>

          <div class="field-row">
            <div class="field-label">
              Dawn release lux
              <sol-help text="Outdoor lux at which night mode unlatches and normal daytime curves take back over."></sol-help>
            </div>
            <input
              type="range"
              min="1"
              max="60"
              step="1"
              .value="${String(house.night_release_lux ?? 10)}"
              @input="${(e: Event) => {
                const v = parseInt((e.target as HTMLInputElement).value, 10);
                setHouse(this.hass, { night_release_lux: v });
              }}"
              style="flex: 1;"
            />
            <div class="field-readout">${house.night_release_lux ?? 10} lx</div>
          </div>
        </div>

        <!-- 3. Transitions Matrix -->
        <div class="card">
          <div class="head">
            <ha-icon icon="mdi:speedometer" style="color: var(--sol-blue);"></ha-icon>
            <div class="title">Transitions Matrix</div>
            <div class="spacer"></div>
            <div style="font-size: 11px; color: var(--sol-text-4);">seconds</div>
          </div>

          <!-- Up Group -->
          <div class="trans-grp">
            <div class="grp-lbl">Up</div>
            <div class="trans-row">
              <div class="trans-lbl">Motion turn-on</div>
              <div class="trans-dots"></div>
              <div class="trans-path">∗ → L1</div>
              <input
                type="number"
                step="0.5"
                class="num-input"
                style="width: 62px;"
                .value="${String(house.transition_turn_on_l1_s ?? 2.0)}"
                @change="${(e: Event) => {
                  setHouse(this.hass, { transition_turn_on_l1_s: parseFloat((e.target as HTMLInputElement).value) });
                }}"
              />
            </div>
            <div class="trans-row">
              <div class="trans-lbl">Dusk ambience wake</div>
              <div class="trans-dots"></div>
              <div class="trans-path">Off → L3</div>
              <input
                type="number"
                step="0.5"
                class="num-input"
                style="width: 62px;"
                .value="${String(house.transition_wake_l3_s ?? 10.0)}"
                @change="${(e: Event) => {
                  setHouse(this.hass, { transition_wake_l3_s: parseFloat((e.target as HTMLInputElement).value) });
                }}"
              />
            </div>
          </div>

          <!-- Down Group -->
          <div class="trans-grp">
            <div class="grp-lbl">Down</div>
            <div class="trans-row">
              <div class="trans-lbl">Subzone diminish</div>
              <div class="trans-dots"></div>
              <div class="trans-path">L1 → L2</div>
              <input
                type="number"
                step="0.5"
                class="num-input"
                style="width: 62px;"
                .value="${String(house.transition_diminish_l2_s ?? 5.0)}"
                @change="${(e: Event) => {
                  setHouse(this.hass, { transition_diminish_l2_s: parseFloat((e.target as HTMLInputElement).value) });
                }}"
              />
            </div>
            <div class="trans-row">
              <div class="trans-lbl">Empty to ambience</div>
              <div class="trans-dots"></div>
              <div class="trans-path">∗ → L3</div>
              <input
                type="number"
                step="0.5"
                class="num-input"
                style="width: 62px;"
                .value="${String(house.transition_clear_to_l3_s ?? 5.0)}"
                @change="${(e: Event) => {
                  setHouse(this.hass, { transition_clear_to_l3_s: parseFloat((e.target as HTMLInputElement).value) });
                }}"
              />
            </div>
            <div class="trans-row">
              <div class="trans-lbl">Empty to dark</div>
              <div class="trans-dots"></div>
              <div class="trans-path">∗ → Off</div>
              <input
                type="number"
                step="0.5"
                class="num-input"
                style="width: 62px;"
                .value="${String(house.transition_clear_to_off_s ?? 4.0)}"
                @change="${(e: Event) => {
                  setHouse(this.hass, { transition_clear_to_off_s: parseFloat((e.target as HTMLInputElement).value) });
                }}"
              />
            </div>
          </div>

          <!-- Continuous & Special -->
          <div class="trans-grp">
            <div class="grp-lbl">Continuous &amp; special</div>
            <div class="trans-row">
              <div class="trans-lbl">Outdoor lux tracking (5m)</div>
              <div class="trans-dots"></div>
              <div class="trans-path">live</div>
              <input
                type="number"
                step="0.5"
                class="num-input"
                style="width: 62px;"
                .value="${String(house.transition_tracking_s ?? 15.0)}"
                @change="${(e: Event) => {
                  setHouse(this.hass, { transition_tracking_s: parseFloat((e.target as HTMLInputElement).value) });
                }}"
              />
            </div>
            <div class="trans-row">
              <div class="trans-lbl">Night mode switch</div>
              <div class="trans-dots"></div>
              <div class="trans-path">∗ → Ls</div>
              <input
                type="number"
                step="0.5"
                class="num-input"
                style="width: 62px;"
                .value="${String(house.transition_night_s ?? 5.0)}"
                @change="${(e: Event) => {
                  setHouse(this.hass, { transition_night_s: parseFloat((e.target as HTMLInputElement).value) });
                }}"
              />
            </div>
            <div class="trans-row">
              <div class="trans-lbl">Dashboard slider drag</div>
              <div class="trans-dots"></div>
              <div class="trans-path">manual</div>
              <input
                type="number"
                step="0.1"
                class="num-input"
                style="width: 62px;"
                .value="${String(house.transition_manual_drag_s ?? 0.5)}"
                @change="${(e: Event) => {
                  setHouse(this.hass, { transition_manual_drag_s: parseFloat((e.target as HTMLInputElement).value) });
                }}"
              />
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
