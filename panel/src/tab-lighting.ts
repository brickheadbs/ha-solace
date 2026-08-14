/**
 * Lighting — the engine's own settings.
 *
 * Configures demand curve, ambience thresholds, 24-hour daylight response,
 * evening ramp, night mode, timing, and transitions.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Hass, Schema, Snapshot } from "./api";
import { setHouse, setRamp } from "./api";
import "./chart";
import type { Fact, Series, Tick } from "./chart";
import { clock, lightPct, num, parseClock, stopLabel } from "./fmt";
import { clockHourToElevation, eveningClockTime, luxForElevation } from "./solar";
import type { Place } from "./solar";
import { tokens } from "./tokens";
import "./ui";

const HELP: Record<string, string> = {
  ambience_start_lux:
    "Falling edge (dark threshold). At or below this outdoor lux level, ambience glow is permitted and minimum cutoff drops out. Does NOT decide whether normal lighting runs — demand and occupancy do that.",
  ambience_stop_lux:
    "Rising edge (bright threshold). At or above this level, ambience glow turns off. The gap between start and stop creates deliberate hysteresis so boundaries never flicker.",
  ambience_debounce_falling_s:
    "Extra delay before reading dark. Leave at 0 unless needed: mmWave sensors already enforce 15s in hardware.",
  ambience_debounce_rising_s:
    "Extra delay before reading bright again. Leave at 0 to avoid adding unnecessary lag.",
  lux_full:
    "Outdoor lux at or below which rooms want 100% lighting. The bottom of the demand curve.",
  lux_window:
    "How far above the full point demand fades to 0%. (lux_full + lux_window) is the outdoor level at which normal daytime lighting turns off completely.",
  min_cutoff:
    "Daylight cutoff. In daytime, demand below this turns lights off rather than producing an invisible faint glow. Ignored after dark (when low levels are intentional).",
  night_level:
    "Fixed low level (0-254) while night mode is latched. Predictable and glare-free when moving around half-asleep.",
  night_release_lux:
    "Night mode ends automatically when outdoor lux rises to this level. Getting out of bed does not end it, keeping late-night trips dim.",
  alarm_lead_minutes:
    "Night mode also releases this many minutes before your next scheduled alarm.",
  ambience_level:
    "Default resting glow level across the house instead of turning completely off once dark and awake. Set to 0 to disable house-wide.",
  ambience_ignores_occupancy:
    "On: the ambience glow stays on in empty rooms after dark. Off: ambience requires room occupancy.",
  rate_limit_step:
    "Maximum change allowed in one tick when tracking daylight. Prevents bulbs from noticeably chasing passing cloud wobbles.",
  dead_zone:
    "Smallest change required to write to bulbs. Suppresses minor noise to keep Zigbee mesh traffic low.",
  update_interval_min_s:
    "Recalculation interval during rapid outdoor lux swings / volatile weather (10s).",
  update_interval_home_s:
    "Recalculation interval when someone is home (60s). Keeps lighting smooth and responsive to room occupancy while avoiding mesh congestion.",
  update_interval_max_s:
    "Recalculation interval when the house is empty/unoccupied (600s / 10m). Minimizes mesh traffic and coordinator cycles when no one is there.",
  lux_volatility_lx:
    "Outdoor lux variation threshold across recent samples that triggers the fast update interval.",
  transition_on_s: "Fade duration (seconds) when turning on from off.",
  transition_off_s: "Fade duration (seconds) when turning off.",
  transition_mode_s: "Fade duration (seconds) for mode changes and normal daylight tracking.",
  transition_setting_s:
    "Fade duration (seconds) while dragging a slider on this panel. Kept short for instant responsiveness.",
  ramp_onset_minutes:
    "Minutes before dusk when the evening ramp begins shifting the demand curve.",
  evening_axis_hour:
    "Fixed reference clock hour for evening colour temperature and ramp transitions.",
  morning_release_hour:
    "Clock hour when the evening ramp releases and the standard daytime curve takes back over.",
  sunrise_fade_enabled:
    "Gradual wake-up fade in the bedroom leading up to your alarm.",
  sunrise_fade_minutes:
    "Duration of the virtual sunrise wake-up fade before alarm.",
  bedtime_dwell_enabled:
    "Auto wind-down dimming in the bedroom before sleep.",
  bedtime_dwell_hour:
    "Clock hour after which an occupied bedroom dims to the wind-down level.",
  bedtime_dwell_level:
    "Target light level (0-254) during bedtime wind-down.",
  lux_history_samples:
    "Number of historical lux samples kept to detect cloud volatility.",
  demand_floor_level:
    "Lowest non-zero command level during active demand.",
  gamma:
    "Display only. Converts a raw command level (0-254) into perceived human brightness (Stevens' power law curve) for UI readouts (e.g. 'level 51 = 2% light'). It is strictly out of the bulb command path. Set to 1.0 for linear power or 2.39 for calibrated human eye perception.",
};

@customElement("sol-tab-lighting")
export class SolTabLighting extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;
  @state() private draft: Record<string, number> = {};

  static styles = [
    tokens,
    css`
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(440px, 1fr));
        gap: 14px;
      }
      @media (max-width: 520px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
      .full {
        grid-column: 1 / -1;
      }
      .sub {
        margin-top: 14px;
        padding-top: 12px;
        border-top: 1px solid var(--sol-hair);
      }
      .ramp {
        display: grid;
        grid-template-columns: 1fr 1fr auto;
        gap: 10px;
        align-items: center;
      }
      .ramp .eyebrow {
        padding-bottom: 2px;
      }
      input[type="time"] {
        font: inherit;
        font-size: 12.5px;
        color: var(--sol-text);
        background: var(--sol-control);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: var(--sol-r-control);
        padding: 6px 8px;
        width: 100%;
        box-sizing: border-box;
      }
      button.icon {
        all: unset;
        cursor: pointer;
        color: var(--sol-text-4);
        display: inline-flex;
        border-radius: var(--sol-r-control);
      }
      button.icon:hover {
        color: var(--sol-amber);
      }
      button.add {
        all: unset;
        cursor: pointer;
        margin-top: 10px;
        font-size: 12px;
        color: var(--sol-cyan);
        display: inline-flex;
        align-items: center;
        gap: 5px;
        border-radius: var(--sol-r-control);
      }
      .adv-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 8px 24px;
      }
      .toggle {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12.5px;
        color: var(--sol-text-2);
        cursor: pointer;
      }
      .warn {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        margin-top: 10px;
        padding: 9px 11px;
        background: var(--sol-amber-surface);
        border-radius: var(--sol-r-block);
        font-size: 11.5px;
        line-height: 1.5;
        color: var(--sol-amber-light);
      }
      code {
        background: var(--sol-control);
        border-radius: 4px;
        padding: 0 4px;
        font-size: 11px;
      }
      .warn ha-icon {
        --mdc-icon-size: 16px;
        flex: 0 0 auto;
        color: var(--sol-amber);
      }
    `,
  ];

  /* ---------------------------------------------------------------- helpers */

  private schema(key: string): Schema | undefined {
    this.placed.add(key);
    return this.snap.house_schema.find((s) => s.key === key);
  }

  private placed = new Set<string>();

  private value(key: string): number {
    return this.draft[key] ?? (this.snap.house as Record<string, number>)[key] ?? 0;
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

  /** A settings row driven entirely by the schema — one row here, one knob everywhere. */
  private row(key: string, format?: (v: number) => string) {
    const s = this.schema(key);
    if (!s) return nothing;
    const v = this.value(key);
    return html`<sol-row .label=${s.name} .help=${HELP[key] ?? ""}>
      <sol-slider
        noReset
        .value=${v}
        .min=${s.min}
        .max=${s.max}
        .step=${s.step}
        .neutral=${s.default}
        @value-changed=${(e: CustomEvent) => this.push(key, e.detail.value, e.detail.final)}
      ></sol-slider>
      <span slot="value"
        >${format ? format(v) : `${num(v, s.step < 1 ? 2 : 0)}${s.unit ? ` ${s.unit}` : ""}`}</span
      >
    </sol-row>`;
  }

  private numberRow(key: string) {
    const s = this.schema(key);
    if (!s) return nothing;
    return html`<sol-row .label=${s.name} .help=${HELP[key] ?? ""}>
      <span></span>
      <sol-number
        slot="value"
        .value=${this.value(key)}
        .min=${s.min}
        .max=${s.max}
        .step=${s.step}
        .width=${64}
        suffix=${s.unit ?? ""}
        @value-changed=${(e: CustomEvent) => this.push(key, e.detail.value)}
      ></sol-number>
    </sol-row>`;
  }

  /* ---------------------------------------------------------------- demand card */

  private demandChart() {
    const lo = Math.max(this.value("lux_full"), 0.1);
    const hi = lo + Math.max(this.value("lux_window"), 1);
    const gateStart = this.value("ambience_start_lux");

    const points: Array<[number, number]> = [];
    for (let i = 0; i <= 160; i++) {
      const l = Math.exp(Math.log(0.1) + (i / 160) * (Math.log(hi * 1.2) - Math.log(0.1)));
      const d = l <= lo ? 1 : l >= hi ? 0 : 1 - Math.log(l / lo) / Math.log(hi / lo);
      points.push([Math.log10(l), d]);
    }

    const decades: Tick[] = [];
    for (let e = -1; e <= Math.ceil(Math.log10(hi * 1.2)); e++) {
      decades.push({ value: e, label: e < 0 ? "0.1" : num(Math.pow(10, e)) });
    }

    return html`<sol-chart
      .series=${[
        { points, colour: "var(--sol-series-start)", width: 2.6 } as Series,
      ]}
      .refLines=${[
        {
          x: Math.log10(Math.max(gateStart, 0.1)),
          label: `dark ${num(gateStart)} lx`,
          colour: "rgba(240,98,146,.55)",
          textColour: "var(--sol-series-full)",
        },
      ]}
      .xTicks=${decades}
      .yTicks=${[0, 0.25, 0.5, 0.75, 1].map((v) => ({ value: v, label: `${v * 100} %` }))}
      .xDomain=${[-1, Math.ceil(Math.log10(hi * 1.2))]}
      .yDomain=${[0, 1]}
      .shade=${[-1, Math.log10(Math.max(gateStart, 0.1))] as [number, number]}
      .shadeLabel=${"dark — cutoff drops out, glow allowed"}
      xTitle="outdoor lux"
      .facts=${[
        { label: "Full at", value: `${num(lo, 1)} lx` },
        { label: "Out at", value: `${num(hi)} lx` },
        { label: "Counts as dark", value: `${num(gateStart)} lx` },
        { label: "Bright again", value: `${num(this.value("ambience_stop_lux"))} lx` },
        { label: "Now", value: num(this.snap.world.lux, 1) + " lx" },
      ] as Fact[]}
    ></sol-chart>`;
  }

  /* ---------------------------------------------------------------- 24-hour day response chart */

  private dayResponseChart() {
    const w = this.snap.world;
    const place: Place = {
      lat: w.latitude,
      lon: w.longitude,
      timeZone: w.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      year: w.year || new Date().getFullYear(),
    };
    const doy = w.day_of_year || 1;
    const lo = Math.max(this.value("lux_full"), 0.1);
    const hi = lo + Math.max(this.value("lux_window"), 1);
    const gateStart = this.value("ambience_start_lux");
    const cutoff = this.value("min_cutoff");
    const ambienceLevel = this.value("ambience_level");
    const gamma = this.snap.house.gamma ?? 2.39;

    const daylightPoints: Array<[number, number]> = [];
    const demandPoints: Array<[number, number]> = [];
    const outputPoints: Array<[number, number]> = [];

    // Sample across 24 hours of today
    for (let m = 0; m <= 24 * 60; m += 10) {
      const h = m / 60;
      const elev = clockHourToElevation(doy, h, place);
      const estLux = luxForElevation(elev);

      // Daylight fraction relative to high-noon maximum for visual curve
      const daylightFraction = Math.max(0, Math.min(1, elev > 0 ? elev / 60 : 0));
      daylightPoints.push([h, daylightFraction]);

      // Demand calculation (0..1)
      const d = estLux <= lo ? 1.0 : estLux >= hi ? 0.0 : 1.0 - Math.log(estLux / lo) / Math.log(hi / lo);
      demandPoints.push([h, d]);

      // Simulated lighting output (perceived % light)
      let rawLevel = Math.round(d * 254);
      const isDark = estLux <= gateStart;
      if (rawLevel < cutoff && !isDark) {
        rawLevel = 0;
      }
      if (rawLevel === 0 && isDark && ambienceLevel > 0) {
        rawLevel = ambienceLevel;
      }
      const perceived = lightPct(rawLevel, gamma) / 100;
      outputPoints.push([h, perceived]);
    }

    const sunset = eveningClockTime(doy, -0.833, place);
    const dusk = eveningClockTime(doy, -6.0, place);
    const onsetMins = this.value("ramp_onset_minutes") || 90;
    const rampStart = dusk !== null ? (dusk - onsetMins / 60 + 24) % 24 : null;

    const xTicks: Tick[] = [0, 4, 8, 12, 16, 20, 24].map((h) => ({
      value: h,
      label: clock(h % 24),
    }));

    const refLines = [];
    if (sunset !== null) {
      refLines.push({
        x: sunset,
        label: `Sunset ${clock(sunset)}`,
        colour: "var(--sol-series-sunset)",
        textColour: "var(--sol-series-sunset)",
      });
    }
    if (dusk !== null) {
      refLines.push({
        x: dusk,
        label: `Civil Dusk ${clock(dusk)}`,
        colour: "var(--sol-series-dusk)",
        textColour: "var(--sol-series-dusk)",
      });
    }
    if (rampStart !== null) {
      refLines.push({
        x: rampStart,
        label: `Ramp Onset ${clock(rampStart)}`,
        colour: "var(--sol-series-start)",
        textColour: "var(--sol-series-start)",
      });
    }

    const series: Series[] = [
      { points: daylightPoints, colour: "rgba(255, 235, 59, 0.4)", width: 1.5, dashed: true },
      { points: demandPoints, colour: "var(--sol-series-full)", width: 1.8 },
      { points: outputPoints, colour: "var(--sol-series-start)", width: 2.6 },
    ];

    const curLux = w.lux;
    const curDemand =
      curLux <= lo ? 1.0 : curLux >= hi ? 0.0 : 1.0 - Math.log(curLux / lo) / Math.log(hi / lo);

    return html`<sol-chart
      .series=${series}
      .refLines=${refLines}
      .xTicks=${xTicks}
      .yTicks=${[0, 0.25, 0.5, 0.75, 1].map((v) => ({ value: v, label: `${v * 100} %` }))}
      .xDomain=${[0, 24]}
      .yDomain=${[0, 1]}
      .marker=${{ x: w.clock_hour, y: curDemand }}
      xTitle="time of day"
      .facts=${[
        { label: "Now", value: clock(w.clock_hour) },
        { label: "Current Demand", value: `${Math.round(curDemand * 100)} %` },
        { label: "Sunset", value: sunset !== null ? clock(sunset) : "—" },
        { label: "Civil Dusk", value: dusk !== null ? clock(dusk) : "—" },
        { label: "Ramp Onset", value: rampStart !== null ? clock(rampStart) : "—" },
      ] as Fact[]}
    ></sol-chart>`;
  }

  /* ---------------------------------------------------------------- ramp */

  private renderRamp() {
    const list = this.snap.ramp.slice();
    return html`
      <div class="ramp" style="margin-bottom:6px">
        <span class="eyebrow">Time</span>
        <span class="eyebrow">Stops bias</span>
        <span></span>
      </div>
      ${list.map(
        (point, i) => html`
          <div class="ramp" style="margin-bottom:8px">
            <input
              type="time"
              .value=${clock(point.hour)}
              @change=${(e: Event) =>
                this.updateRampPoint(i, {
                  ...point,
                  hour: parseClock((e.target as HTMLInputElement).value),
                })}
            />
            <sol-slider
              .value=${point.stops}
              .min=${-2}
              .max=${2}
              .step=${0.1}
              @value-changed=${(e: CustomEvent) =>
                this.updateRampPoint(i, { ...point, stops: e.detail.value }, e.detail.final)}
            ></sol-slider>
            <button
              class="icon"
              title="Delete this point"
              ?disabled=${list.length <= 1}
              @click=${() => this.deleteRampPoint(i)}
            >
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>
        `
      )}
      <button class="add" @click=${() => this.addRampPoint()}>
        <ha-icon icon="mdi:plus"></ha-icon>
        Add ramp point
      </button>
    `;
  }

  private async updateRampPoint(
    i: number,
    point: { hour: number; stops: number },
    final = true
  ) {
    const next = this.snap.ramp.slice();
    next[i] = point;
    if (final) await setRamp(this.hass, next);
  }

  private async deleteRampPoint(i: number) {
    const next = this.snap.ramp.slice();
    next.splice(i, 1);
    await setRamp(this.hass, next);
  }

  private async addRampPoint() {
    const next = this.snap.ramp.slice();
    const last = next[next.length - 1];
    const newHour = last ? (last.hour + 1) % 24 : 21.0;
    next.push({ hour: newHour, stops: last ? last.stops - 0.5 : -1.0 });
    await setRamp(this.hass, next);
  }

  private rampChart() {
    const points: Array<[number, number]> = [];
    const ramp = this.snap.ramp.slice().sort((a, b) => a.hour - b.hour);
    if (ramp.length === 0) return nothing;

    for (let m = 0; m <= 24 * 60; m += 15) {
      const h = m / 60;
      let s = ramp[0].stops;
      for (const p of ramp) {
        if (h >= p.hour) s = p.stops;
      }
      points.push([h, s]);
    }

    const xTicks: Tick[] = [0, 4, 8, 12, 16, 20, 24].map((h) => ({
      value: h,
      label: clock(h % 24),
    }));

    return html`
      <sol-chart
        .series=${[
          { points, colour: "var(--sol-series-start)", width: 2.2 },
        ]}
        .xTicks=${xTicks}
        .yTicks=${[-2, -1, 0, 1, 2].map((v) => ({ value: v, label: stopLabel(v) }))}
        .xDomain=${[0, 24]}
        .yDomain=${[-2, 2]}
        xTitle="time of day"
      ></sol-chart>
      <div class="caption" style="margin-top:8px">
        Evening ramp profile across 24 hours. The evening ramp shifts room bias gradually across
        the configured phases until the morning release hour.
      </div>
    `;
  }

  /* ---------------------------------------------------------------- advanced card */

  private renderAdvanced() {
    const leftover = this.snap.house_schema.filter((s) => !this.placed.has(s.key));
    if (!leftover.length) return nothing;
    return html`<div class="card full">
      <div class="card-head">
        <ha-icon icon="mdi:wrench-outline"></ha-icon>
        <h2>Advanced</h2>
      </div>
      <div class="caption" style="margin-bottom:8px">
        Measured constants and plumbing. They have sensible defaults and you should not
        need them — but nothing in this engine is hardcoded, so they are here rather than
        buried in the source.
      </div>
      <div class="adv-grid">
        ${leftover.map((s) => this.numberRow(s.key))}
      </div>
    </div>`;
  }

  /* ---------------------------------------------------------------- render */

  render() {
    this.placed = new Set();
    const gateStart = this.value("ambience_start_lux");
    const gateStop = this.value("ambience_stop_lux");
    const lo = this.value("lux_full");
    const hi = lo + this.value("lux_window");
    const debounced =
      this.value("ambience_debounce_falling_s") > 0 || this.value("ambience_debounce_rising_s") > 0;

    return html`<div class="grid">
      <div class="card">
        <div class="card-head">
          <ha-icon icon="mdi:chart-bell-curve-cumulative"></ha-icon>
          <h2>Demand curve</h2>
        </div>
        ${this.row("lux_full")} ${this.row("lux_window")} ${this.row("min_cutoff")}
        <div class="caption">
          Lights out at ${num(hi)} lx — full point plus window.
        </div>
        <div class="sub">${this.demandChart()}</div>
      </div>

      <div class="card">
        <div class="card-head">
          <ha-icon icon="mdi:theme-light-dark"></ha-icon>
          <h2>Ambience — the evening glow</h2>
        </div>
        <div class="caption" style="margin-bottom:6px">
          <b>These thresholds do not decide whether normal lighting runs.</b> That is the demand
          curve above, plus occupancy. These two numbers say when it is dark enough for the resting
          glow — and below them the minimum cutoff drops out so lights can dim to low night levels.
        </div>
        ${this.row("ambience_start_lux")} ${this.row("ambience_stop_lux")}
        <div class="caption">
          Hysteresis gap: ${num(Math.max(0, gateStop - gateStart))} lx — prevents threshold flickering.
        </div>
        <div class="sub">
          ${this.row("ambience_level")}
          <sol-row
            .label=${"Ambience in empty rooms"}
            .help=${HELP.ambience_ignores_occupancy}
          >
            <label class="toggle">
              <input
                type="checkbox"
                .checked=${this.value("ambience_ignores_occupancy") >= 1}
                @change=${(e: Event) =>
                  this.push(
                    "ambience_ignores_occupancy",
                    (e.target as HTMLInputElement).checked ? 1 : 0
                  )}
              />
              <span
                >${this.value("ambience_ignores_occupancy") >= 1
                  ? "glow stays in empty rooms"
                  : "needs occupancy"}</span
              >
            </label>
          </sol-row>
        </div>
        <div class="sub">
          <div class="eyebrow" style="margin-bottom:4px">Debounce (seconds)</div>
          <div class="caption">
            Leave these at 0 unless needed. The mmWave sensors already enforce hardware delay.
          </div>
          ${this.row("ambience_debounce_falling_s")} ${this.row("ambience_debounce_rising_s")}
          ${debounced
            ? html`<div class="warn">
                <ha-icon icon="mdi:alert-outline"></ha-icon>
                <span>A debounce is set. Every second here stacks on top of hardware delays.</span>
              </div>`
            : nothing}
        </div>
      </div>

      <div class="card full">
        <div class="card-head">
          <ha-icon icon="mdi:weather-sunset"></ha-icon>
          <h2>24-hour daylight &amp; adaptive response</h2>
        </div>
        ${this.dayResponseChart()}
        <div class="caption" style="margin-top:10px">
          Simulates today's solar daylight cycle (yellow dashed), the resulting lighting demand (blue),
          and the projected Solace output level (solid line) across the 24 hours of today for your latitude.
        </div>
      </div>

      <div class="card full">
        <div class="card-head">
          <ha-icon icon="mdi:ray-start-arrow"></ha-icon>
          <h2>Evening ramp</h2>
        </div>
        <div class="caption" style="margin-bottom:10px">
          An ordered list of points, not two fixed phases — add as many as you want.
        </div>
        ${this.renderRamp()}
        <div class="sub">
          ${this.row("ramp_onset_minutes")}
          ${this.row("evening_axis_hour", (v) => clock(v))}
          ${this.row("morning_release_hour", (v) => clock(v))}
        </div>
        <div class="sub">${this.rampChart()}</div>
      </div>

      <div class="card">
        <div class="card-head">
          <ha-icon icon="mdi:weather-night"></ha-icon>
          <h2>Night &amp; bedtime mode</h2>
        </div>
        <div class="caption" style="margin-bottom:6px">
          Night mode latches when you fall asleep and lets go when sunlight reaches release lux or before alarm.
        </div>
        ${this.row("night_level")} ${this.row("night_release_lux")} ${this.row("alarm_lead_minutes")}
        <div class="sub">
          <div class="eyebrow" style="margin-bottom:4px">Bedtime Wind-Down</div>
          ${this.numberRow("bedtime_dwell_hour")} ${this.numberRow("bedtime_dwell_level")}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <ha-icon icon="mdi:speedometer"></ha-icon>
          <h2>Timing &amp; transitions</h2>
        </div>
        ${this.numberRow("update_interval_min_s")} ${this.numberRow("update_interval_home_s")}
        ${this.numberRow("update_interval_max_s")} ${this.numberRow("lux_volatility_lx")}
        ${this.numberRow("dead_zone")} ${this.numberRow("rate_limit_step")}
        <div class="sub">
          <div class="eyebrow" style="margin-bottom:4px">Transition speeds (seconds)</div>
          ${this.numberRow("transition_on_s")} ${this.numberRow("transition_off_s")}
          ${this.numberRow("transition_mode_s")} ${this.numberRow("transition_setting_s")}
        </div>
        <div class="sub">${this.row("gamma")}</div>
      </div>

      ${this.renderAdvanced()}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-tab-lighting": SolTabLighting;
  }
}
