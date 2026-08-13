/**
 * Lighting — the engine's own settings.
 *
 * Two things here are not in the handoff and are here because the brief demands them:
 *
 * 1. **The evening ramp is an editable ordered list**, not four time boxes. The brief:
 *    *"Build it as an ordered list of ramp points from the start — retrofitting a third
 *    phase later is worse than supporting N now."* Two points are the starting config,
 *    not the schema, so the panel has to be able to add and remove them.
 * 2. **The demand card marks where the ambience threshold sits on the demand curve.**
 *    It no longer *overrides* demand — that was the 2026-08-13 bug, where the 50/80 pair
 *    was ANDed into normal lighting and silently zeroed an occupied room at 247 lx. The
 *    marker stays because the relationship is still worth seeing: below it the minimum
 *    cutoff drops out and the glow may appear.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Hass, Schema, Snapshot } from "./api";
import { setHouse, setRamp } from "./api";
import "./chart";
import type { Fact, Series, Tick } from "./chart";
import { clock, lightPct, num, parseClock, stopLabel } from "./fmt";
import { eveningClockTime, eveningTimeForLux } from "./solar";
import type { Place } from "./solar";
import { tokens } from "./tokens";
import "./ui";

const HELP: Record<string, string> = {
  ambience_start_lux:
    "Falling edge. At or below this outdoor level it counts as dark: the ambience glow may appear, and the minimum cutoff drops out. It does NOT decide whether normal lighting runs — demand and occupancy do that.",
  ambience_stop_lux:
    "Rising edge. At or above this it counts as bright again and the glow goes. The gap between the two thresholds is deliberate hysteresis so the boundary does not flicker.",
  ambience_debounce_falling_s:
    "Extra delay before it reads dark. Leave at 0 unless you have a reason: the mmWave sensors already impose a 15 s minimum in hardware and zigbee2mqtt adds more on top.",
  ambience_debounce_rising_s:
    "Extra delay before it reads bright again. Same warning — stacking three minutes on top of the hardware delay is three minutes of lag and then a mystery.",
  lux_full:
    "The outdoor level at or below which the room wants full light. The bottom of the demand curve.",
  lux_window:
    "How far above the full point demand fades to nothing. Full point plus window IS the outdoor level at which normal lighting goes out — nothing else overrides it. Below that, an occupied room lights in proportion to how dark it is.",
  min_cutoff:
    "Below this the light goes off rather than sitting at a useless glow competing with daylight. Ignored once it is dark — after dark a level of 1 is the point, not a waste — so this only bites in daylight.",
  night_level:
    "A fixed level while night mode is latched — not a scaling. Fixed so it is predictable when you are half asleep.",
  night_release_lux:
    "Night mode ends when it gets this light outside. Getting out of bed does not end it; that is deliberate, so a 3 am trip does not relight the house at full demand.",
  alarm_lead_minutes: "Night mode also ends this long before your next alarm, whichever comes first.",
  ambience_level:
    "What a light shows INSTEAD OF BEING OFF, once it is dark outside and you are awake. It replaces off — it never dims a light that is already doing its job. 0 turns the feature off everywhere.",
  ambience_ignores_occupancy:
    "On: the ambience glow stays in a room nobody is in. Off: it needs occupancy like everything else.",
  rate_limit_step:
    "The most the level may move in one tick while tracking daylight. It stops the bulb visibly chasing every wobble in the lux reading. It never applies to switching on or off — those are commands, and the transition handles their smoothness.",
  dead_zone: "A change smaller than this writes nothing at all, so the mesh is not spammed.",
  update_interval_min_s: "How often to recalculate while the outdoor light is moving fast.",
  update_interval_home_s: "How often to recalculate when things are stable but someone is home.",
  update_interval_max_s: "How often to recalculate when things are stable and the house is empty.",
  lux_volatility_lx:
    "How much the outdoor reading has to swing across recent samples before the engine counts the world as moving and speeds up.",
  transition_on_s: "Fade length when a light goes from off to on.",
  transition_off_s: "Fade length when a light goes out.",
  transition_mode_s: "Fade length when the mode changes, and for ordinary daylight tracking.",
  transition_setting_s:
    "Fade length while you are dragging a slider on this page. Keep it short — a long glide here makes the whole panel feel broken.",
  morning_release_hour:
    "When the evening ramp lets go and the day curve takes back over. Without it the ramp would hold its last value all the next day.",
  gamma:
    "Display only. Converts a command level into the light your eye actually perceives, so the panel can say 'level 102 (18 % light)'. It is deliberately out of the command path.",
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
        grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
        gap: 0 24px;
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

  /** Keys rendered by a named card. Anything not here falls into Advanced. */
  private placed = new Set<string>();

  private schema(key: string): Schema | undefined {
    this.placed.add(key);
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

    // Sample in log-lux — the curve is logarithmic and linear sampling wastes every
    // point above a few hundred lux.
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

  /* ---------------------------------------------------------------- year chart */

  private yearChart() {
    const w = this.snap.world;
    const place: Place = {
      lat: w.latitude,
      lon: w.longitude,
      timeZone: w.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      year: w.year || new Date().getFullYear(),
    };
    const lat = w.latitude;
    const gateStart = this.value("ambience_start_lux");
    const luxFull = Math.max(this.value("lux_full"), 0.1);
    const ambienceOn = this.value("ambience_level") > 0 ? gateStart : null;

    const starts: Array<[number, number]> = [];
    const fulls: Array<[number, number]> = [];
    const sunsets: Array<[number, number]> = [];
    const dusks: Array<[number, number]> = [];
    const ambience: Array<[number, number]> = [];

    for (let doy = 1; doy <= 365; doy += 5) {
      const start = eveningTimeForLux(doy, gateStart, place);
      const full = eveningTimeForLux(doy, luxFull, place);
      const sunset = eveningClockTime(doy, -0.833, place);
      const dusk = eveningClockTime(doy, -6, place);
      starts.push([doy, start ?? NaN]);
      fulls.push([doy, full ?? NaN]);
      sunsets.push([doy, sunset ?? NaN]);
      dusks.push([doy, dusk ?? NaN]);
      if (ambienceOn !== null) {
        ambience.push([doy, eveningTimeForLux(doy, ambienceOn, place) ?? NaN]);
      }
    }

    const all = [...starts, ...fulls, ...sunsets, ...dusks, ...ambience]
      .map(([, y]) => y)
      .filter((y) => isFinite(y));
    const lo = Math.floor(Math.min(...all, 16));
    const hi = Math.ceil(Math.max(...all, 23));
    const yTicks: Tick[] = [];
    for (let h = lo; h <= hi; h++) yTicks.push({ value: h, label: clock(h) });

    const monthStarts = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366];
    const xTicks: Tick[] = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec"
      .split(" ")
      .map((label, i) => ({
        value: (monthStarts[i] + monthStarts[i + 1]) / 2,
        label,
      }));

    const today = w.day_of_year;
    const todayStart = eveningTimeForLux(today, gateStart, place);
    const todayFull = eveningTimeForLux(today, luxFull, place);
    const todayAmb = ambienceOn === null ? null : eveningTimeForLux(today, ambienceOn, place);
    const descent =
      todayStart !== null && todayFull !== null ? Math.round((todayFull - todayStart) * 60) : null;

    const series: Series[] = [
      { points: sunsets, colour: "var(--sol-series-sunset)", width: 1.6 },
      { points: dusks, colour: "var(--sol-series-dusk)", width: 1.6 },
      { points: fulls, colour: "var(--sol-series-full)", width: 1.6 },
      { points: starts, colour: "var(--sol-series-start)", width: 2.6 },
    ];
    if (ambience.length) {
      series.unshift({ points: ambience, colour: "var(--sol-series-ambience)", width: 1.6, dashed: true });
    }

    return html`<sol-chart
      .series=${series}
      .refLines=${[
        {
          x: today,
          label: "today",
          colour: "rgba(255,255,255,.25)",
          textColour: "var(--sol-text-3)",
        },
      ]}
      .xTicks=${xTicks}
      .yTicks=${yTicks}
      .xDomain=${[1, 365]}
      .yDomain=${[lo, hi]}
      .marker=${todayStart !== null ? { x: today, y: todayStart } : null}
      .facts=${[
        { label: "Lighting starts", value: clock(todayStart) },
        { label: "Ambience on", value: todayAmb === null ? "off" : clock(todayAmb) },
        { label: "Lights full", value: clock(todayFull) },
        { label: "On threshold", value: `${num(gateStart)} lx` },
        { label: "Full at", value: `${num(luxFull, 1)} lx` },
        { label: "Descent to full", value: descent === null ? "—" : `${descent} min` },
        { label: "Latitude", value: `${num(lat, 2)}°` },
      ] as Fact[]}
    ></sol-chart>`;
  }

  /**
   * The ramp, drawn the way the engine computes it — including the eased onset and the
   * consequence in real levels, not just stops.
   *
   * This is the chart that earns its place: the ramp is an N-point list of abstract
   * "stops" and nothing else on the page shows what that actually does to the house
   * across an evening.
   */
  private rampChart() {
    const points = [...this.snap.ramp].sort(
      (a, b) => ((a.hour - 18 + 24) % 24) - ((b.hour - 18 + 24) % 24)
    );
    if (!points.length) return nothing;
    const axis = (h: number) => (h - 18 + 24) % 24;
    const release = axis(this.value("morning_release_hour"));
    const onset = Math.max(this.value("ramp_onset_minutes"), 0) / 60;
    const gamma = this.snap.house.gamma ?? 2.39;

    const at = (a: number): number => {
      if (a >= release) return 0;
      const first = axis(points[0].hour);
      if (a < first - onset) return 0;
      if (a < first) return onset <= 0 ? 0 : ((a - (first - onset)) / onset) * points[0].stops;
      const last = axis(points[points.length - 1].hour);
      if (a >= last) return points[points.length - 1].stops;
      for (let i = 0; i < points.length - 1; i++) {
        const lo = axis(points[i].hour);
        const hi = axis(points[i + 1].hour);
        if (lo <= a && a <= hi) {
          const span = hi - lo;
          if (span <= 0) return points[i + 1].stops;
          return points[i].stops + ((a - lo) / span) * (points[i + 1].stops - points[i].stops);
        }
      }
      return 0;
    };

    // A reference level so the y-axis means something: what a fully-dark room settles at.
    const base = Math.max(1, ...this.snap.rooms.map((r) => r.level ?? 0), 161);
    const curve: Array<[number, number]> = [];
    for (let i = 0; i <= 288; i++) {
      const a = (i / 288) * release;
      curve.push([a, base * Math.pow(2, at(a))]);
    }

    const ticks: Tick[] = [];
    for (let a = 0; a <= release; a += 2) ticks.push({ value: a, label: clock((a + 18) % 24) });
    const maxY = Math.max(base, ...curve.map(([, y]) => y));

    return html`<sol-chart
      .series=${[{ points: curve, colour: "var(--sol-series-start)", width: 2.6 } as Series]}
      .refLines=${points.map((p) => ({
        x: axis(p.hour),
        label: `${clock(p.hour)} ${stopLabel(p.stops)}`,
        colour: "rgba(255,183,77,.45)",
        textColour: "var(--sol-amber)",
      }))}
      .xTicks=${ticks}
      .yTicks=${[0, 0.25, 0.5, 0.75, 1].map((f) => ({
        value: f * maxY,
        label: String(Math.round(f * maxY)),
      }))}
      .xDomain=${[0, release]}
      .yDomain=${[0, maxY]}
      xTitle="evening → morning release"
      .facts=${[
        { label: "Points", value: String(points.length) },
        { label: "Onset", value: `${num(this.value("ramp_onset_minutes"))} min` },
        ...points.map((p, i) => ({
          label: `Point ${i + 1}`,
          value: `${clock(p.hour)} · ${stopLabel(p.stops)}`,
        })),
        {
          label: "At the last point",
          value: `level ${Math.round(base * Math.pow(2, points[points.length - 1].stops))} of ${base}`,
        },
        { label: "Reference room", value: `${base} (${lightPct(base, gamma)} % light)` },
      ] as Fact[]}
    ></sol-chart>`;
  }

  /* ---------------------------------------------------------------- ramp */

  private renderRamp() {
    const ramp = this.snap.ramp;
    const write = (next: Array<{ hour: number; stops: number }>) => setRamp(this.hass, next);
    return html`
      <div class="ramp">
        <span class="eyebrow">Time</span>
        <span class="eyebrow">Bias</span>
        <span></span>
        ${ramp.map(
          (p, i) => html`
            <input
              type="time"
              .value=${clock(p.hour)}
              @change=${(e: Event) => {
                const next = ramp.map((q, j) =>
                  j === i ? { ...q, hour: parseClock((e.target as HTMLInputElement).value) } : q
                );
                write(next);
              }}
            />
            <sol-slider
              .value=${p.stops}
              .min=${-4}
              .max=${1}
              .step=${0.25}
              @value-changed=${(e: CustomEvent) => {
                if (!e.detail.final) return;
                write(ramp.map((q, j) => (j === i ? { ...q, stops: e.detail.value } : q)));
              }}
            ></sol-slider>
            <button
              class="icon"
              title="Remove this point"
              @click=${() => write(ramp.filter((_, j) => j !== i))}
            >
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
            <span class="caption" style="grid-column:1/-1;margin-top:-6px">
              ${clock(p.hour)} → ${stopLabel(p.stops)}
            </span>
          `
        )}
      </div>
      <button
        class="add"
        @click=${() =>
          write([
            ...ramp,
            {
              hour: ramp.length ? (ramp[ramp.length - 1].hour + 1) % 24 : 20,
              stops: ramp.length ? ramp[ramp.length - 1].stops - 0.5 : -0.5,
            },
          ])}
      >
        <ha-icon icon="mdi:plus"></ha-icon> Add a ramp point
      </button>
      <div class="caption" style="margin-top:8px">
        The ramp glides continuously between points, so it needs no transition of its own. It holds
        the last point until the morning release.
      </div>
    `;
  }

  /**
   * Everything no named card claimed.
   *
   * This exists so a setting cannot be added to `const.py` and then be silently
   * unreachable here — which is exactly the "a value that cannot be changed from the
   * panel is a bug" failure, just relocated to the frontend. New rows appear
   * automatically, in a card that says plainly they are not everyday controls.
   */
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
    // Recomputed each render: the named cards below repopulate it via `schema()`.
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
        ${gateStart < hi
          ? html`<div class="warn">
              <ha-icon icon="mdi:alert-outline"></ha-icon>
              <span>
                The gate shuts at ${num(gateStart)} lx but demand does not reach zero until
                ${num(hi)} lx, so the shaded part of the curve can never be seen. Neither number is
                wrong — they answer different questions — but they have to be tuned as a pair.
              </span>
            </div>`
          : nothing}
      </div>

      <div class="card">
        <div class="card-head">
          <ha-icon icon="mdi:theme-light-dark"></ha-icon>
          <h2>Ambience — the evening glow</h2>
        </div>
        <div class="caption" style="margin-bottom:6px">
          <b>These thresholds do not decide whether normal lighting runs.</b> That is the demand
          curve above, plus occupancy. These two numbers only say when it is dark enough for the
          resting glow — and they do one other thing: below them the minimum cutoff drops out, so
          lights can reach 1 after dark instead of stopping at
          ${num(this.value("min_cutoff"))}.
        </div>
        ${this.row("ambience_start_lux")} ${this.row("ambience_stop_lux")}
        <div class="caption">
          Hysteresis gap: ${num(Math.max(0, gateStop - gateStart))} lx — the boundary does not
          flicker.
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
            Leave these at 0 unless you have a measured reason. The mmWave sensors already impose a
            15 s minimum in hardware, and zigbee2mqtt adds more on top of that.
          </div>
          ${this.row("ambience_debounce_falling_s")} ${this.row("ambience_debounce_rising_s")}
          ${debounced
            ? html`<div class="warn">
                <ha-icon icon="mdi:alert-outline"></ha-icon>
                <span>A debounce is set. Every second here stacks on top of the hardware delay.</span>
              </div>`
            : nothing}
        </div>
      </div>

      <div class="card full">
        <div class="card-head">
          <ha-icon icon="mdi:calendar-month"></ha-icon>
          <h2>When lighting starts, across the year</h2>
        </div>
        ${this.yearChart()}
        <div class="caption" style="margin-top:10px">
          Estimated from solar geometry for a clear sky, so it answers "what will happen in March"
          — a question <code>sun.sun</code> cannot. It lands within a few minutes of the real sun
          near midsummer and about ten in deep winter. The engine itself never uses this: it reads
          civil dusk from <code>sun.sun</code>.
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
          ${this.row("morning_release_hour", (v) => clock(v))}
        </div>
        <div class="sub">${this.rampChart()}</div>
      </div>

      <div class="card">
        <div class="card-head">
          <ha-icon icon="mdi:weather-night"></ha-icon>
          <h2>Night mode</h2>
        </div>
        <div class="caption" style="margin-bottom:6px">
          Night latches when you fall asleep and lets go on the world's terms, not your posture —
          getting up at 3 am does not end it.
        </div>
        ${this.row("night_level")} ${this.row("night_release_lux")} ${this.row("alarm_lead_minutes")}
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
