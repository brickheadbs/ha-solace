/**
 * Special Modes Tab — Work, Gaming and Movie for the Bedroom office.
 *
 * One card per mode. Each office light is either a fixed level or "Follow Solace"
 * (stored as -1), colour is a fixed Kelvin or "Follow house" (stored as 0), and lights
 * that follow get the mode's bias in stops. Every value is an ordinary house setting
 * (`<mode>_mode_*`), so "Reset" just writes the schema defaults back — for Work those
 * defaults ARE the 2026-11 D65 calibration.
 *
 * Only one mode is live at a time (Movie > Gaming > Work); switching one on switches the
 * others off in the coordinator.
 */

import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { customElement } from "./custom-element";
import type { Hass, Schema, Snapshot } from "./api";
import { setHouse, toggleSpecialMode } from "./api";
import { tokens } from "./tokens";
import "./ui";

type ModeId = "work" | "gaming" | "movie";

interface ModeDef {
  id: ModeId;
  label: string;
  icon: string;
  blurb: string;
  resetLabel: string;
}

const MODES: ModeDef[] = [
  {
    id: "work",
    label: "Work",
    icon: "mdi:palette-swatch-variant",
    blurb:
      "Turns on by itself when Photoshop, Lightroom Classic or DaVinci Resolve opens. Pauses while the Mac displays sleep.",
    resetLabel: "Reset to calibrated D65",
  },
  {
    id: "gaming",
    label: "Gaming",
    icon: "mdi:controller",
    blurb: "Turns on by itself when Steam or CrossOver opens.",
    resetLabel: "Reset to defaults",
  },
  {
    id: "movie",
    label: "Movie",
    icon: "mdi:movie-open-outline",
    blurb: "Turns on by itself when the Jellyfin app opens.",
    resetLabel: "Reset to defaults",
  },
];

/** Office lights in display order: label + the setting suffix. */
const LIGHTS: Array<{ label: string; suffix: string; help: string }> = [
  { label: "Desk bias", suffix: "desk_level", help: "Left desk light. The right desk light runs 0.30 EV lower to compensate for the corner reflection." },
  { label: "Counter fill", suffix: "backlight_level", help: "Counter light." },
  { label: "Wardrobe fill", suffix: "corner_level", help: "Wardrobe light." },
  { label: "Glass lamp", suffix: "glass_level", help: "Glass lamp. 0 keeps it off." },
];

const FOLLOW = -1;

@customElement("sol-tab-modes")
export class SolTabModes extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;

  @state() private draft: Record<string, number> = {};
  @state() private confirmReset: ModeId | null = null;

  static styles = [
    tokens,
    css`
      :host {
        display: block;
        padding-bottom: 40px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
        gap: 14px;
        align-items: start;
      }
      .card {
        background: var(--sol-card);
        border-radius: var(--sol-r-card);
        padding: 15px 18px 16px;
        box-shadow: var(--sol-shadow);
        border: 1px solid transparent;
      }
      .card.live {
        border-color: rgba(100, 181, 246, 0.45);
      }
      .full {
        grid-column: 1 / -1;
      }
      .head {
        display: flex;
        align-items: center;
        gap: 9px;
        margin-bottom: 6px;
      }
      .head ha-icon {
        --mdc-icon-size: 20px;
        color: var(--sol-cyan);
      }
      .title {
        font-size: 15px;
        font-weight: 500;
        color: var(--sol-text);
      }
      .spacer {
        flex: 1;
      }
      .blurb {
        font-size: 12px;
        color: var(--sol-text-3);
        margin-bottom: 8px;
        line-height: 1.4;
      }
      .badge {
        padding: 2px 8px;
        border-radius: 5px;
        font-size: 11px;
        font-weight: 600;
        background: var(--sol-control);
        color: var(--sol-text-3);
      }
      .badge.on {
        background: rgba(129, 199, 132, 0.16);
        color: #81c784;
      }
      .badge.paused {
        background: rgba(255, 183, 77, 0.18);
        color: #ffb74d;
      }
      .badge.bad {
        background: rgba(229, 115, 115, 0.18);
        color: #e57373;
      }
      button {
        border: none;
        cursor: pointer;
        border-radius: 12px;
        padding: 4px 12px;
        font-family: inherit;
        font-size: 11.5px;
        font-weight: 600;
      }
      .toggle-on {
        background: #3b4a52;
        color: var(--sol-blue);
      }
      .toggle-off {
        background: var(--sol-control);
        color: var(--sol-text-3);
      }
      .reset {
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: var(--sol-text-2);
      }
      .reset.confirm {
        border-color: rgba(255, 183, 77, 0.6);
        color: #ffb74d;
      }
      .follow {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11.5px;
        color: var(--sol-text-3);
        white-space: nowrap;
        cursor: pointer;
      }
      .follow input {
        margin: 0;
      }
      .val {
        flex: 0 0 52px;
        text-align: right;
        font-variant-numeric: tabular-nums;
        font-size: 12.5px;
        color: var(--sol-text);
      }
      .signals {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .foot {
        display: flex;
        justify-content: flex-end;
        margin-top: 10px;
      }
      @media (max-width: 480px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
    `,
  ];

  private schema(key: string): Schema | undefined {
    return this.snap.house_schema.find((s) => s.key === key);
  }

  private value(key: string): number {
    return this.draft[key] ?? this.snap.house[key] ?? this.schema(key)?.default ?? 0;
  }

  private async push(key: string, value: number, final = true) {
    this.draft = { ...this.draft, [key]: value };
    await setHouse(this.hass, { [key]: value });
    if (final) {
      window.setTimeout(() => {
        const next = { ...this.draft };
        delete next[key];
        this.draft = next;
      }, 700);
    }
  }

  private async reset(mode: ModeId) {
    if (this.confirmReset !== mode) {
      this.confirmReset = mode;
      window.setTimeout(() => {
        if (this.confirmReset === mode) this.confirmReset = null;
      }, 4000);
      return;
    }
    this.confirmReset = null;
    const values: Record<string, number> = {};
    for (const s of this.snap.house_schema) {
      if (s.key.startsWith(`${mode}_mode_`)) values[s.key] = s.default;
    }
    this.draft = {};
    await setHouse(this.hass, values);
  }

  private lightRow(mode: ModeId, suffix: string, label: string, help: string) {
    const key = `${mode}_mode_${suffix}`;
    const s = this.schema(key);
    if (!s) return nothing;
    const v = this.value(key);
    const following = v <= FOLLOW;
    return html`<sol-row .label=${label} .help=${help}>
      <label class="follow">
        <input
          type="checkbox"
          .checked=${following}
          @change=${(e: Event) =>
            this.push(key, (e.target as HTMLInputElement).checked ? FOLLOW : Math.max(0, s.default))}
        />
        Follow Solace
      </label>
      ${following
        ? html`<span class="spacer"></span><span class="val">auto</span>`
        : html`<sol-slider
              tone="amber"
              .value=${v}
              .min=${0}
              .max=${254}
              .step=${1}
              .neutral=${Math.max(0, s.default)}
              @value-changed=${(e: CustomEvent) => this.push(key, e.detail.value, e.detail.final)}
            ></sol-slider>
            <span class="val">${Math.round(v)}</span>`}
    </sol-row>`;
  }

  private kelvinRow(mode: ModeId) {
    const key = `${mode}_mode_kelvin`;
    const s = this.schema(key);
    if (!s) return nothing;
    const v = this.value(key);
    const following = v <= 0;
    return html`<sol-row
      label="Colour temperature"
      help="Applies to lights set to a fixed level. Follow house uses the normal Solace colour curve."
    >
      <label class="follow">
        <input
          type="checkbox"
          .checked=${following}
          @change=${(e: Event) =>
            this.push(key, (e.target as HTMLInputElement).checked ? 0 : s.default > 0 ? s.default : 4000)}
        />
        Follow house
      </label>
      ${following
        ? html`<span class="spacer"></span><span class="val">auto</span>`
        : html`<sol-slider
              .value=${v}
              .min=${2000}
              .max=${6535}
              .step=${10}
              .neutral=${s.default > 0 ? s.default : 4000}
              @value-changed=${(e: CustomEvent) => this.push(key, e.detail.value, e.detail.final)}
            ></sol-slider>
            <span class="val">${Math.round(v)} K</span>`}
    </sol-row>`;
  }

  private sliderRow(key: string, label: string, help: string, unit: string) {
    const s = this.schema(key);
    if (!s) return nothing;
    const v = this.value(key);
    return html`<sol-row .label=${label} .help=${help}>
      <sol-slider
        .value=${v}
        .min=${s.min}
        .max=${s.max}
        .step=${s.step}
        .neutral=${s.default}
        @value-changed=${(e: CustomEvent) => this.push(key, e.detail.value, e.detail.final)}
      ></sol-slider>
      <span class="val">${unit === "stops" ? v.toFixed(2) : Math.round(v * 10) / 10} ${unit}</span>
    </sol-row>`;
  }

  private modeCard(m: ModeDef) {
    const w = this.snap.world;
    const on = Boolean(w.special_modes?.[m.id]);
    const live = w.special_mode === m.id;
    const paused = live && Boolean(w.mode_paused);
    const badge = !on
      ? html`<span class="badge">Off</span>`
      : paused
        ? html`<span class="badge paused">Paused: displays asleep</span>`
        : live
          ? html`<span class="badge on">Active</span>`
          : html`<span class="badge">Overridden</span>`;
    return html`<div class="card ${live ? "live" : ""}">
      <div class="head">
        <ha-icon .icon=${m.icon}></ha-icon>
        <div class="title">${m.label} mode</div>
        ${badge}
        <div class="spacer"></div>
        <button class=${on ? "toggle-on" : "toggle-off"} @click=${() => toggleSpecialMode(this.hass, m.id)}>
          ${on ? "Turn off" : "Turn on"}
        </button>
      </div>
      <div class="blurb">${m.blurb}</div>
      ${LIGHTS.map((l) => this.lightRow(m.id, l.suffix, l.label, l.help))}
      ${this.kelvinRow(m.id)}
      ${this.sliderRow(
        `${m.id}_mode_bias_stops`,
        "Bias for followed lights",
        "Brighter or dimmer than normal Solace, for lights set to Follow Solace.",
        "stops"
      )}
      ${this.sliderRow(
        `${m.id}_mode_debounce_minutes`,
        "Hold after leaving",
        "How long the mode keeps the lights after the bedroom empties. Skipped when you are seen in another room (unless Guest Mode is on).",
        "min"
      )}
      ${m.id === "work"
        ? this.sliderRow(
            "work_mode_app_close_delay_minutes",
            "Off after apps close",
            "Minutes after the last creative app closes before Work mode turns off. 0 = straight away.",
            "min"
          )
        : nothing}
      <div class="foot">
        <button class="reset ${this.confirmReset === m.id ? "confirm" : ""}" @click=${() => this.reset(m.id)}>
          ${this.confirmReset === m.id ? "Click again to reset" : m.resetLabel}
        </button>
      </div>
    </div>`;
  }

  render() {
    if (!this.snap) return nothing;
    const w = this.snap.world;
    const watcher = w.mac_watcher_alive;
    return html`<div class="grid">
      <div class="card full">
        <div class="head">
          <ha-icon icon="mdi:monitor-dashboard"></ha-icon>
          <div class="title">Mac signals</div>
        </div>
        <div class="signals">
          <span class="badge ${watcher ? "on" : "bad"}">Watcher ${watcher ? "running" : "not reporting"}</span>
          <span class="badge ${w.creative_app_open ? "on" : ""}">Creative app ${w.creative_app_open ? "open" : "closed"}</span>
          <span class="badge ${w.mode_paused ? "paused" : ""}">Displays ${w.mode_paused ? "asleep" : "awake"}</span>
        </div>
        ${this.sliderRow(
          "transition_mode_s",
          "Mode switch fade",
          "How long the office lights take to reach a mode's levels when you switch a mode on or off. Everyday tracking keeps the slow Automatic fade.",
          "s"
        )}
      </div>
      ${MODES.map((m) => this.modeCard(m))}
    </div>`;
  }
}
