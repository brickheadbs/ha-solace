/**
 * Colour — the house-wide Kelvin curve.
 *
 * ⚠️ The curve drawn here is the *same* model as `colour.py`, and it interpolates in
 * **mireds**, not Kelvin. Drawing a straight Kelvin line would look plausible and be
 * visibly wrong in the middle of the glide, which is exactly where the eye is watching.
 *
 * Colour is one house-wide value anchored to civil dusk. What each bulb *achieves* can
 * differ — five in this house stop at 4000 K — and a clamp produces no error and no log
 * line, so the only way it stops being invisible is if the panel says so.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Hass, Schema, Snapshot } from "./api";
import { setHouse } from "./api";
import "./chart";
import type { Fact, Series, Tick } from "./chart";
import { clock, num } from "./fmt";
import { tokens } from "./tokens";
import "./ui";

const HELP: Record<string, string> = {
  day_kelvin: "The colour held through the day, until civil dusk starts the glide down.",
  night_kelvin: "The colour held after the glide, until the morning release.",
  colour_glide_minutes:
    "How long the glide from day to night colour takes, starting at civil dusk. The glide is interpolated in mireds, which is what makes it look even.",
  colour_trim_kelvin:
    "A live trim added to whatever the curve says, at any time of day. Use it to nudge the whole house warmer or cooler without touching the curve.",
  colour_step_mired:
    "How big each colour step is. Colour is stepped rather than faded because the bulbs do not glide colour the way they glide brightness.",
  colour_step_transition_s: "The fade applied to each individual colour step.",
};

const toMired = (k: number) => 1_000_000 / Math.max(k, 1);
const toKelvin = (m: number) => 1_000_000 / Math.max(m, 1);

@customElement("sol-tab-colour")
export class SolTabColour extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;
  @state() private view: "day" | "hour" = "day";
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
      .head-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
      }
      .trim-caption {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11.5px;
        color: var(--sol-text-4);
        margin-top: 2px;
      }
      .trim-caption b {
        color: var(--sol-text);
        font-weight: 500;
        font-variant-numeric: tabular-nums;
      }
      .advisory {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        margin-top: 14px;
        padding: 9px 11px;
        background: var(--sol-amber-surface);
        border-radius: var(--sol-r-block);
        font-size: 11.5px;
        line-height: 1.5;
        color: var(--sol-amber-light);
      }
      .advisory ha-icon {
        --mdc-icon-size: 16px;
        flex: 0 0 auto;
        color: var(--sol-amber);
      }
      .advisory ul {
        margin: 4px 0 0;
        padding-left: 16px;
      }
      /* The Kelvin gradient is a real reference, not decoration — it is what the numbers
         on the slider mean. */
      .ranges {
        display: flex;
        flex-direction: column;
      }
      .range-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 104px 76px;
        gap: 8px;
        align-items: center;
        padding: 6px 0;
        border-top: 1px solid rgba(255, 255, 255, 0.05);
        font-size: 12px;
      }
      .range-row .n {
        color: var(--sol-text-2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .range-row .r {
        color: var(--sol-text-4);
        text-align: right;
      }
      .range-row .a {
        text-align: right;
        color: var(--sol-text);
      }
      /* Amber = a hardware clamp. That is the whole reason amber is reserved. */
      .range-row.capped .a {
        color: var(--sol-amber);
      }
      .kelvin-track {
        height: 4px;
        border-radius: 2px;
        margin: 2px 0 8px;
        background: linear-gradient(
          90deg,
          #ff9a3c,
          #ffc689,
          #ffe4c4,
          #fff6ec,
          #f2f4ff,
          #cfe0ff
        );
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

  private row(key: string, format?: (v: number) => string) {
    const s = this.schema(key);
    if (!s) return nothing;
    const v = this.value(key);
    return html`<sol-row .label=${s.name} .help=${HELP[key] ?? ""}>
      <sol-slider
        .value=${v}
        .min=${s.min}
        .max=${s.max}
        .step=${s.step}
        .neutral=${s.default}
        .noReset=${s.default !== 0}
        @value-changed=${(e: CustomEvent) => this.push(key, e.detail.value, e.detail.final)}
      ></sol-slider>
      <span slot="value"
        >${format ? format(v) : `${num(v)}${s.unit ? ` ${s.unit}` : ""}`}</span
      >
    </sol-row>`;
  }

  /**
   * The curve, mirroring `target_kelvin()` exactly:
   * night until the morning release, day held until civil dusk, mired-linear glide down,
   * hold. Trim is added afterwards and the result clamped.
   */
  private kelvinAt(hour: number): number {
    const dusk = this.snap.world.dusk_hour;
    const release = this.value("morning_release_hour");
    const day = this.value("day_kelvin");
    const night = this.value("night_kelvin");
    const glideH = Math.max(this.value("colour_glide_minutes"), 0) / 60;

    const elapsed = (hour - dusk + 24) % 24;
    const releaseAt = (release - dusk + 24) % 24;

    // ⚠️ Mirrors `colour.py::target_kelvin` EXACTLY, including the morning glide. A
    // chart that draws a different curve from the one the engine runs is worse than no
    // chart: it is a confident lie about what the house is about to do.
    const morningH = Math.max(this.value("morning_glide_minutes"), 0) / 60;
    let k: number;
    if (elapsed >= releaseAt) {
      const intoMorning = elapsed - releaseAt;
      if (morningH <= 0 || intoMorning >= morningH) k = day;
      else k = toKelvin(toMired(night) + (intoMorning / morningH) * (toMired(day) - toMired(night)));
    } else if (glideH <= 0 || elapsed >= glideH) k = night;
    else k = toKelvin(toMired(day) + (elapsed / glideH) * (toMired(night) - toMired(day)));

    return Math.max(2000, Math.min(7000, k + this.value("colour_trim_kelvin")));
  }

  private chart() {
    const w = this.snap.world;
    const dusk = w.dusk_hour;
    const points: Array<[number, number]> = [];

    let xDomain: [number, number];
    let xTicks: Tick[];
    if (this.view === "day") {
      for (let i = 0; i <= 288; i++) {
        const h = (i / 288) * 24;
        points.push([h, this.kelvinAt(h)]);
      }
      xDomain = [0, 24];
      xTicks = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => ({ value: h, label: clock(h) }));
    } else {
      // Minutes relative to civil dusk — the window where the whole glide happens.
      for (let m = -60; m <= 240; m += 2) {
        points.push([m, this.kelvinAt((dusk + m / 60 + 24) % 24)]);
      }
      xDomain = [-60, 240];
      xTicks = [-60, 0, 60, 120, 180, 240].map((m) => ({
        value: m,
        label: `${m > 0 ? "+" : ""}${m}`,
      }));
    }

    const toX = (hour: number | null): number => {
      if (hour === null) return NaN;
      if (this.view === "day") return hour;
      return (((hour - dusk + 36) % 24) - 12) * 60;
    };

    const refLines = [
      { hour: w.sunrise_hour, label: "sunrise", c: "rgba(255,183,77,.5)", t: "var(--sol-amber)" },
      { hour: w.sunset_hour, label: "sunset", c: "rgba(255,183,77,.5)", t: "var(--sol-amber)" },
      { hour: dusk, label: "civil dusk", c: "rgba(149,117,205,.75)", t: "#b39ddb" },
      {
        hour: this.value("morning_release_hour"),
        label: "release",
        c: "rgba(79,195,247,.45)",
        t: "var(--sol-cyan)",
      },
    ]
      .map((r) => ({ x: toX(r.hour), label: r.label, colour: r.c, textColour: r.t }))
      .filter((r) => isFinite(r.x) && r.x >= xDomain[0] && r.x <= xDomain[1]);

    const nightK = this.value("night_kelvin") + this.value("colour_trim_kelvin");
    const dayNight = `${num(this.value("day_kelvin"))} → ${num(this.value("night_kelvin"))} K`;

    return html`<sol-chart
      .series=${[{ points, colour: "#ffe4c4", width: 2.5, gradient: "kgrad" } as Series]}
      .refLines=${refLines}
      .xTicks=${xTicks}
      .yTicks=${[2000, 3000, 4000, 5000, 6000, 7000].map((k) => ({
        value: k,
        label: `${k / 1000}k`,
      }))}
      .xDomain=${xDomain}
      .yDomain=${[2000, 7000]}
      .marker=${{ x: toX(w.clock_hour), y: this.kelvinAt(w.clock_hour) }}
      xTitle=${this.view === "day" ? "time of day" : "minutes from civil dusk"}
      .facts=${[
        { label: "Now", value: `${clock(w.clock_hour)} · ${num(this.kelvinAt(w.clock_hour))} K` },
        { label: "Sunset", value: clock(w.sunset_hour) },
        { label: "Civil dusk", value: clock(dusk) },
        { label: "Day → night", value: dayNight },
        { label: "Glide", value: `${num(this.value("colour_glide_minutes"))} min` },
        {
          label: "Trim",
          value: `${this.value("colour_trim_kelvin") > 0 ? "+" : ""}${num(
            this.value("colour_trim_kelvin")
          )} K`,
        },
        { label: "Night holds at", value: `${num(Math.max(2000, nightK))} K` },
      ] as Fact[]}
    ></sol-chart>`;
  }

  /** Bulbs whose ceiling is below the day target — the clamp, made visible. */
  private clampedLights() {
    const day = this.value("day_kelvin") + this.value("colour_trim_kelvin");
    const out: Array<{ name: string; max: number }> = [];
    for (const room of this.snap.rooms) {
      for (const light of room.lights) {
        if (light.max_kelvin < day) out.push({ name: light.name, max: light.max_kelvin });
      }
    }
    return out;
  }

  render() {
    const trim = this.value("colour_trim_kelvin");
    const day = this.value("day_kelvin") + trim;
    const clamped = this.clampedLights();
    return html`<div class="grid">
      <div class="card">
        <div class="card-head">
          <ha-icon icon="mdi:palette"></ha-icon>
          <h2>Colour</h2>
        </div>
        <div class="kelvin-track"></div>
        ${this.row("day_kelvin", (v) => `${num(v)} K`)}
        ${this.row("night_kelvin", (v) => `${num(v)} K`)}
        ${this.row("colour_glide_minutes", (v) => `${num(v)} min`)}
        ${this.row("colour_trim_kelvin", (v) => `${v > 0 ? "+" : ""}${num(v)} K`)}
        <div class="trim-caption">
          <span>${trim < 0 ? "warmer" : " "}</span>
          <span>right now: <b>${num(this.kelvinAt(this.snap.world.clock_hour))} K</b></span>
          <span>${trim > 0 ? "cooler" : " "}</span>
        </div>
        <div class="sub">
          ${this.row("colour_step_mired", (v) => `${num(v)} mired`)}
          ${this.row("colour_step_transition_s", (v) => `${num(v, 1)} s`)}
          <div class="caption">
            Colour moves in steps, not one long fade — the bulbs do not glide colour the way they
            glide brightness. Step size and glide length together set how often a step is sent.
          </div>
        </div>
        ${clamped.length
          ? html`<div class="advisory">
              <ha-icon icon="mdi:alert-outline"></ha-icon>
              <div>
                ${clamped.length} bulb${clamped.length === 1 ? " is" : "s are"} held below the day
                target by their own hardware. They accept the command and report success, so this
                is the only place it shows:
                <ul>
                  ${clamped.map((c) => html`<li>${c.name} — capped at ${num(c.max)} K</li>`)}
                </ul>
              </div>
            </div>`
          : nothing}
      </div>

      <div class="card">
        <div class="card-head">
          <ha-icon icon="mdi:thermometer-lines"></ha-icon>
          <h2>What each bulb can actually do</h2>
        </div>
        <div class="caption" style="margin-bottom:8px">
          One Kelvin goes to the whole house; each bulb pins it into its own range and reports
          success either way. Broadcasting to mixed families is safe, but the families then
          visually diverge — which is the part worth seeing.
        </div>
        <div class="ranges">
          ${this.snap.rooms.flatMap((room) =>
            room.lights.map(
              (l) => html`<div class="range-row ${l.kelvin < day ? "capped" : ""}">
                <span class="n" title=${l.name}>${l.name}</span>
                <span class="r tab-num">${num(l.min_kelvin)}–${num(l.max_kelvin)} K</span>
                <span class="a tab-num">${num(l.kelvin)} K${l.kelvin_clamped ? " ⚑" : ""}</span>
              </div>`
            )
          )}
        </div>
      </div>

      <div class="card full">
        <div class="head-row">
          <div class="card-head" style="margin:0">
            <ha-icon icon="mdi:chart-line"></ha-icon>
            <h2>Colour temperature</h2>
          </div>
          <sol-segmented
            .options=${[
              { value: "day", label: "Day" },
              { value: "hour", label: "Hour" },
            ]}
            .value=${this.view}
            @segment-changed=${(e: CustomEvent) => (this.view = e.detail.value)}
          ></sol-segmented>
        </div>
        ${this.chart()}
      </div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-tab-colour": SolTabColour;
  }
}
