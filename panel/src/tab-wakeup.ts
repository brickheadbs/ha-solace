/**
 * Wake-Up Tab — Dedicated page for Target Wake-Up Time (top of sunrise curve),
 * Wake-Up Music Preset Selection (Cast), Virtual Sunrise Spline Curve, and Sleep / Dawn Release.
 */

import { LitElement, css, html, nothing, svg } from "lit";
import { property, state } from "lit/decorators.js";
import { customElement } from "./custom-element";
import type { Hass, MusicPlaylist, Snapshot } from "./api";
import {
  musicConfig,
  musicPlay,
  musicStop,
  setHouse,
  setRoom,
  setSunriseCurve,
} from "./api";
import { clock, parseClock } from "./fmt";
import { MonotoneSpline } from "./spline";
import { tokens } from "./tokens";
import "./ui";

interface NodeDef {
  x: number; // 0..100 (%)
  y: number; // 0..254 (level)
}

const DEF_SUNRISE: NodeDef[] = [
  { x: 0, y: 0 },
  { x: 30, y: 15 },
  { x: 70, y: 90 },
  { x: 100, y: 180 },
];

const QUICK_WAKE_TIMES = ["06:30", "07:00", "07:30", "08:00", "08:30", "09:00"];

const X0 = 48;
const X1 = 762;
const Y0 = 14;
const Y1 = 206;
const VW = 780;
const VH = 230;

function subtractMinutes(hhmm: string, mins: number): string {
  const parts = hhmm.split(":");
  if (parts.length < 2) return "—";
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return "—";
  const total = ((h * 60 + m - Math.round(mins)) % 1440 + 1440) % 1440;
  const outH = String(Math.floor(total / 60)).padStart(2, "0");
  const outM = String(total % 60).padStart(2, "0");
  return `${outH}:${outM}`;
}

function progressToTimeStr(wakeHHMM: string, fadeMins: number, pct: number): string {
  const remainingMins = fadeMins * (1.0 - Math.max(0, Math.min(100, pct)) / 100.0);
  return subtractMinutes(wakeHHMM, remainingMins);
}

@customElement("sol-tab-wakeup")
export class SolTabWakeup extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;

  @state() private localSunrise: NodeDef[] | null = null;
  @state() private selSunriseIdx: number | null = null;
  @state() private hoverSunrise: { x: number; y: number } | null = null;

  private _drag: { idx: number } | null = null;
  private _debounceTimer?: number;

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
      .two-col {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
        gap: 14px;
      }
      .sub-card {
        background: var(--sol-control);
        border-radius: 10px;
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .sub-head {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .sub-title {
        font-size: 14px;
        font-weight: 500;
        color: var(--sol-text);
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 9px;
        border-radius: 5px;
        font-size: 11px;
        font-weight: 500;
      }
      .badge-amber {
        background: rgba(255, 183, 77, 0.18);
        color: #ffb74d;
      }
      .badge-cyan {
        background: rgba(86, 182, 194, 0.18);
        color: var(--sol-cyan);
      }
      .badge-green {
        background: rgba(129, 199, 132, 0.18);
        color: #81c784;
      }
      .badge-dim {
        background: rgba(255, 255, 255, 0.06);
        color: var(--sol-text-3);
      }
      .wake-time-row {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        padding: 10px 12px;
        background: rgba(0, 0, 0, 0.25);
        border-radius: 8px;
      }
      .time-input {
        background: var(--sol-card);
        border: 1px solid rgba(255, 183, 77, 0.4);
        border-radius: 7px;
        padding: 6px 10px;
        font-family: inherit;
        font-size: 18px;
        font-weight: 600;
        color: #ffb74d;
        outline: none;
      }
      .time-input:focus {
        border-color: var(--sol-cyan);
      }
      .preset-pills {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .pill-btn {
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: var(--sol-card);
        color: var(--sol-text-2);
        border-radius: 6px;
        padding: 5px 10px;
        font-family: inherit;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .pill-btn:hover {
        background: var(--sol-card-high);
        color: var(--sol-text);
      }
      .pill-btn.active {
        background: rgba(255, 183, 77, 0.22);
        border-color: #ffb74d;
        color: #ffb74d;
      }
      .timeline-summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
        padding: 9px 12px;
        background: rgba(255, 183, 77, 0.08);
        border: 1px solid rgba(255, 183, 77, 0.22);
        border-radius: 8px;
        font-size: 12px;
        color: var(--sol-text-2);
      }
      .timeline-summary strong {
        color: #ffb74d;
      }
      .triggers-bar {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
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
      .manual-sleep-btn.active {
        background: rgba(255, 183, 77, 0.22);
        border-color: #ffb74d;
        color: #ffb74d;
      }
      .inputs-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        gap: 12px;
        padding-top: 8px;
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
      .num-input,
      .select-input {
        box-sizing: border-box;
        background: var(--sol-card);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        padding: 6px 9px;
        font-family: inherit;
        font-size: 12.5px;
        color: var(--sol-text);
        outline: none;
      }
      .num-input {
        text-align: right;
      }
      .select-input {
        width: 100%;
      }
      .toggle-btn {
        border: none;
        cursor: pointer;
        border-radius: 12px;
        padding: 4px 12px;
        font-family: inherit;
        font-size: 11.5px;
        font-weight: 500;
      }
      .toggle-on {
        background: #3b4a52;
        color: var(--sol-blue);
      }
      .toggle-off {
        background: var(--sol-card);
        color: var(--sol-text-3);
      }
      .presets-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
        gap: 12px;
        margin-top: 12px;
      }
      .preset-card {
        background: var(--sol-control);
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: 10px;
        padding: 12px 14px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 7px;
        transition: all 0.15s ease;
      }
      .preset-card:hover {
        border-color: rgba(255, 183, 77, 0.4);
        background: rgba(255, 255, 255, 0.05);
      }
      .preset-card.selected {
        border-color: #ffb74d;
        background: rgba(255, 183, 77, 0.1);
      }
      .preset-top {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .preset-name {
        font-size: 13.5px;
        font-weight: 600;
        color: var(--sol-text);
        flex: 1;
      }
      .preset-desc {
        font-size: 11.5px;
        color: var(--sol-text-3);
        line-height: 1.45;
      }
      .preset-next {
        font-size: 11.5px;
        color: var(--sol-text-2);
        background: rgba(0, 0, 0, 0.25);
        padding: 6px 9px;
        border-radius: 6px;
        margin-top: auto;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .preset-next strong {
        color: #ffb74d;
      }
      .curve-ctrl-bar {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        margin: 6px 0 10px;
        padding: 8px 12px;
        background: rgba(0, 0, 0, 0.2);
        border-radius: 8px;
      }
      .curve-metric {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--sol-text-2);
      }
      .btn-reset {
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: var(--sol-card);
        color: var(--sol-text-3);
        border-radius: 6px;
        padding: 4px 10px;
        font-family: inherit;
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
      }
      .svg-wrap {
        position: relative;
        width: 100%;
        background: var(--sol-card);
        border-radius: 8px;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.05);
        user-select: none;
      }
      svg {
        display: block;
        width: 100%;
        height: auto;
      }
      .node-editor {
        display: flex;
        align-items: center;
        gap: 8px;
        background: rgba(0, 0, 0, 0.3);
        border-radius: 8px;
        padding: 5px 10px;
        margin-top: 8px;
      }
      .node-editor input {
        width: 60px;
        box-sizing: border-box;
        background: var(--sol-card);
        border: 1px solid rgba(255, 183, 77, 0.35);
        border-radius: 5px;
        padding: 3px 5px;
        text-align: center;
        font-size: 11.5px;
        color: var(--sol-text);
      }
      .btn-node-del {
        border: 1px solid rgba(239, 83, 80, 0.3);
        background: rgba(239, 83, 80, 0.1);
        color: #ef5350;
        border-radius: 5px;
        padding: 3px 8px;
        font-size: 11px;
        cursor: pointer;
        margin-left: auto;
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("mousemove", this._onWindowMouseMove);
    window.addEventListener("mouseup", this._onWindowMouseUp);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("mousemove", this._onWindowMouseMove);
    window.removeEventListener("mouseup", this._onWindowMouseUp);
  }

  private findBedroom() {
    return this.snap?.rooms?.find(
      (r) => r.name.toLowerCase().includes("bed") || r.subentry_id.includes("bedroom")
    );
  }

  private getSunriseNodes(): NodeDef[] {
    if (this.localSunrise) return this.localSunrise;
    if (this.snap?.sunrise_curve?.length) {
      return this.snap.sunrise_curve.map((p) => ({ x: p.progress, y: p.level }));
    }
    return DEF_SUNRISE;
  }

  private toSvgX(pct: number): number {
    return X0 + (Math.max(0, Math.min(100, pct)) / 100.0) * (X1 - X0);
  }

  private fromSvgX(px: number): number {
    return Math.max(0, Math.min(100, ((px - X0) / (X1 - X0)) * 100.0));
  }

  private toSvgY(lvl: number): number {
    return Y1 - (Math.max(0, Math.min(254, lvl)) / 254.0) * (Y1 - Y0);
  }

  private fromSvgY(py: number): number {
    return Math.max(0, Math.min(254, Math.round(((Y1 - py) / (Y1 - Y0)) * 254.0)));
  }

  private buildPath(nodes: NodeDef[]): string {
    if (!nodes.length) return "";
    const spline = new MonotoneSpline(nodes);
    const steps = 100;
    let d = "";
    for (let i = 0; i <= steps; i++) {
      const pct = (i / steps) * 100.0;
      const lvl = Math.max(0, Math.min(254, spline.evaluate(pct)));
      const px = this.toSvgX(pct);
      const py = this.toSvgY(lvl);
      d += i === 0 ? `M ${px.toFixed(1)} ${py.toFixed(1)}` : ` L ${px.toFixed(1)} ${py.toFixed(1)}`;
    }
    return d;
  }

  private buildArea(nodes: NodeDef[]): string {
    const linePath = this.buildPath(nodes);
    if (!linePath) return "";
    return `${linePath} L ${X1} ${Y1} L ${X0} ${Y1} Z`;
  }

  private _onWindowMouseMove = (e: MouseEvent) => {
    if (!this._drag) return;
    const svgEl = this.shadowRoot?.getElementById("svg-sunrise");
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (VW / rect.width);
    const py = (e.clientY - rect.top) * (VH / rect.height);
    const newX = Math.round(this.fromSvgX(px) * 10) / 10;
    const newY = this.fromSvgY(py);
    const nodes = [...this.getSunriseNodes()];
    const idx = this._drag.idx;
    const boundedX = idx === 0 ? 0 : idx === nodes.length - 1 ? 100 : Math.max(1, Math.min(99, newX));
    nodes[idx] = { x: boundedX, y: newY };
    this.localSunrise = nodes;
    this.debounceSaveSunrise();
  };

  private _onWindowMouseUp = () => {
    this._drag = null;
  };

  private handleSvgClick(e: MouseEvent) {
    const svgEl = this.shadowRoot?.getElementById("svg-sunrise");
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (VW / rect.width);
    const py = (e.clientY - rect.top) * (VH / rect.height);
    if (px < X0 || px > X1 || py < Y0 || py > Y1) return;
    const clickX = Math.round(this.fromSvgX(px));
    const clickY = this.fromSvgY(py);
    const nodes = [...this.getSunriseNodes()];
    const nearIdx = nodes.findIndex(
      (n) => Math.hypot(this.toSvgX(n.x) - px, this.toSvgY(n.y) - py) < 14
    );
    if (nearIdx !== -1) {
      this.selSunriseIdx = nearIdx;
      return;
    }
    nodes.push({ x: clickX, y: clickY });
    nodes.sort((a, b) => a.x - b.x);
    this.localSunrise = nodes;
    this.selSunriseIdx = nodes.findIndex((n) => n.x === clickX);
    this.debounceSaveSunrise();
  }

  private debounceSaveSunrise() {
    window.clearTimeout(this._debounceTimer);
    this._debounceTimer = window.setTimeout(() => {
      if (this.localSunrise) {
        setSunriseCurve(
          this.hass,
          this.localSunrise.map((n) => ({ progress: n.x, level: n.y }))
        );
      }
    }, 250);
  }

  private resetSunrise() {
    this.localSunrise = DEF_SUNRISE;
    this.selSunriseIdx = null;
    setSunriseCurve(
      this.hass,
      DEF_SUNRISE.map((n) => ({ progress: n.x, level: n.y }))
    );
  }

  private deleteSunriseNode(idx: number) {
    const nodes = this.getSunriseNodes().filter((_, i) => i !== idx);
    if (nodes.length < 2) return;
    this.localSunrise = nodes;
    this.selSunriseIdx = null;
    this.debounceSaveSunrise();
  }

  render() {
    const house = this.snap?.house ?? {};
    const world = this.snap?.world;
    const music = this.snap?.music;
    const bed = this.findBedroom();
    const bedSettings = bed?.settings ?? {};

    const sleepActive = !!world?.asleep;
    const riseActive = !!bedSettings.sunrise_enabled;

    const fadeMins = house.sunrise_fade_minutes ?? 30;
    const wakeTime = music?.wake_target_time ?? "08:00";
    const wakeTimeEnabled = music?.wake_time_enabled ?? true;
    const fadeStartStr = subtractMinutes(wakeTime, fadeMins);

    const wakeMusicEnabled = music?.wake_enabled ?? true;
    const wakePlaylistId = music?.wake_playlist_id ?? "morning_gentle";
    const wakeSpeaker = music?.wake_speaker_entity ?? "media_player.all_speakers";
    const wakeVol = music?.wake_volume_pct ?? 35;
    const playlists: MusicPlaylist[] = music?.playlists ?? [];
    const speakers = music?.speakers ?? [];

    const currentDemandLevel = Math.round(((world?.demand ?? 1.0) as number) * 254);
    const demandSvgY = this.toSvgY(currentDemandLevel);
    const sunriseNodes = this.getSunriseNodes();
    const riseProgress = world?.sunrise_progress ?? null;
    const peakLevel = sunriseNodes.length ? sunriseNodes[sunriseNodes.length - 1].y : 180;

    return html`
      <div class="grid">
        <!-- 1. Target Wake-Up Schedule & Sleep / Dawn Status -->
        <div class="card full-col">
          <div class="head">
            <ha-icon icon="mdi:alarm" style="color: #ffb74d;"></ha-icon>
            <div class="title">Target Wake-Up Schedule &amp; Sleep Status</div>
            <sol-help
              text="Target Wake-Up Time defines the exact moment when bedroom lights reach 100% of the Virtual Sunrise curve AND your selected Wake-Up Music preset begins playing on Cast speakers. The fade begins automatically (Target Time − Fade Duration)."
            ></sol-help>
          </div>

          <div class="two-col">
            <!-- Left: Target Wake-Up Time -->
            <div class="sub-card">
              <div class="sub-head">
                <ha-icon icon="mdi:weather-sunset-up" style="color: #ffb74d;"></ha-icon>
                <div class="sub-title">Target Wake-Up Time (Peak of Curve)</div>
                <div class="spacer"></div>
                <button
                  class="toggle-btn ${wakeTimeEnabled ? "toggle-on" : "toggle-off"}"
                  @click="${() =>
                    musicConfig(this.hass, { wake_time_enabled: !wakeTimeEnabled })}"
                >
                  ${wakeTimeEnabled ? "Target Time Active" : "Phone Alarm Only"}
                </button>
              </div>

              <div class="wake-time-row">
                <input
                  type="time"
                  class="time-input"
                  .value="${wakeTime}"
                  @change="${(e: Event) => {
                    const val = (e.target as HTMLInputElement).value;
                    if (val) musicConfig(this.hass, { wake_target_time: val, wake_time_enabled: true });
                  }}"
                />
                <div class="preset-pills">
                  ${QUICK_WAKE_TIMES.map(
                    (t) => html`
                      <button
                        class="pill-btn ${wakeTime === t && wakeTimeEnabled ? "active" : ""}"
                        @click="${() =>
                          musicConfig(this.hass, { wake_target_time: t, wake_time_enabled: true })}"
                      >
                        ${t}
                      </button>
                    `
                  )}
                </div>
              </div>

              <div class="timeline-summary">
                <span>
                  1. Sunrise Fade Starts: <strong>${fadeStartStr}</strong> (${fadeMins}m before)
                </span>
                <span>→</span>
                <span>
                  2. Top of Curve (${peakLevel}/254) + Music: <strong>${wakeTime}</strong>
                </span>
              </div>
            </div>

            <!-- Right: Dawn Unlatch Schedule -->
            <div class="sub-card">
              <div class="sub-head">
                <ha-icon icon="mdi:weather-sunny" style="color: var(--sol-amber);"></ha-icon>
                <div class="sub-title">Dawn Night-Latch Release</div>
                <div class="spacer"></div>
                <div class="badge ${sleepActive || world?.night_active ? "badge-amber" : "badge-dim"}">
                  ${sleepActive ? "Asleep" : world?.night_active ? "Night Latched" : "Daylight / Awake"}
                </div>
              </div>

              <div class="inputs-row" style="border-top: none; padding-top: 4px;">
                <div>
                  <div style="display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">
                    Earliest release time (HH:MM)
                    <sol-help text="Earliest morning clock time when colour glide and dawn lux release are allowed to clear Night Latch."></sol-help>
                  </div>
                  <div class="input-with-unit">
                    <input
                      type="time"
                      class="time-input"
                      style="font-size: 14px; padding: 5px 9px; flex: 1;"
                      .value="${clock(house.morning_release_hour ?? 6.5)}"
                      @change="${(e: Event) => {
                        const val = (e.target as HTMLInputElement).value;
                        if (val) setHouse(this.hass, { morning_release_hour: parseClock(val) });
                      }}"
                    />
                  </div>
                </div>

                <div>
                  <div style="display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">
                    Dawn release lux (unlatch)
                    <sol-help text="Outdoor illuminance in lux at which Night Mode automatically unlatches at dawn."></sol-help>
                  </div>
                  <div class="input-with-unit">
                    <input
                      type="number"
                      class="num-input"
                      style="flex: 1;"
                      .value="${String(house.night_release_lux ?? 10)}"
                      @change="${(e: Event) => {
                        const v = parseFloat((e.target as HTMLInputElement).value);
                        if (!Number.isNaN(v)) setHouse(this.hass, { night_release_lux: v });
                      }}"
                    />
                    <span class="unit-label">lx</span>
                  </div>
                </div>
              </div>

              <div style="font-size: 11.5px; color: var(--sol-text-3);">
                Pre-sleep controls (U200 Lock, Sleep Switch, Virtual Sunset) live on the <strong>Wind-down</strong> tab.
              </div>
            </div>
          </div>
        </div>

        <!-- 2. Wake-Up Music & Curated Preset Selector -->
        <div class="card full-col">
          <div class="head">
            <ha-icon icon="mdi:music-circle-outline" style="color: var(--sol-cyan);"></ha-icon>
            <div class="title">Wake-Up Music Preset &amp; Cast Target</div>
            <sol-help
              text="When the Virtual Sunrise curve reaches 100% at Target Wake-Up Time, Solace casts the selected playlist preset to your chosen speakers. Each playlist remembers where it left off and starts at 0:00 of the queued song."
            ></sol-help>
            <div class="spacer"></div>
            <button
              class="pill-btn"
              style="border-color: rgba(86, 182, 194, 0.4); color: var(--sol-cyan);"
              @click="${() =>
                musicPlay(this.hass, {
                  playlist_id: wakePlaylistId,
                  speaker_entity: wakeSpeaker,
                  volume_pct: wakeVol,
                })}"
            >
              Test Wake-Up Music
            </button>
            ${music?.state !== "stopped"
              ? html`
                  <button
                    class="pill-btn"
                    style="border-color: rgba(239, 83, 80, 0.4); color: #ef5350;"
                    @click="${() => musicStop(this.hass)}"
                  >
                    Stop Audio
                  </button>
                `
              : nothing}
            <button
              class="toggle-btn ${wakeMusicEnabled ? "toggle-on" : "toggle-off"}"
              @click="${() => musicConfig(this.hass, { wake_enabled: !wakeMusicEnabled })}"
            >
              ${wakeMusicEnabled ? "Wake Music: ON" : "Wake Music: OFF"}
            </button>
          </div>

          <div class="inputs-row" style="border-top: none; padding-top: 0; margin-bottom: 12px;">
            <div>
              <div style="font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">
                Wake-Up Cast Speaker Group
              </div>
              <select
                class="select-input"
                .value="${wakeSpeaker}"
                @change="${(e: Event) => {
                  const v = (e.target as HTMLSelectElement).value;
                  musicConfig(this.hass, { wake_speaker_entity: v });
                }}"
              >
                ${speakers.map(
                  (sp) => html`
                    <option value="${sp.entity_id}" ?selected=${sp.entity_id === wakeSpeaker}>
                      ${sp.name} ${sp.available ? "" : "(Offline)"}
                    </option>
                  `
                )}
              </select>
            </div>

            <div>
              <div style="font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">
                Wake-Up Volume: <strong style="color: var(--sol-cyan);">${wakeVol}%</strong>
              </div>
              <div class="input-with-unit">
                <input
                  type="range"
                  min="5"
                  max="100"
                  step="5"
                  style="flex: 1; accent-color: var(--sol-cyan);"
                  .value="${String(wakeVol)}"
                  @change="${(e: Event) => {
                    const v = parseInt((e.target as HTMLInputElement).value, 10);
                    musicConfig(this.hass, { wake_volume_pct: v });
                  }}"
                />
                <input
                  type="number"
                  class="num-input"
                  style="width: 58px;"
                  min="5"
                  max="100"
                  .value="${String(wakeVol)}"
                  @change="${(e: Event) => {
                    const v = parseInt((e.target as HTMLInputElement).value, 10);
                    musicConfig(this.hass, { wake_volume_pct: v });
                  }}"
                />
                <span class="unit-label">%</span>
              </div>
            </div>
          </div>

          <div class="presets-grid">
            ${playlists.map((pl) => {
              const isSelected = pl.id === wakePlaylistId;
              const nextTrack = pl.current_track;
              return html`
                <div
                  class="preset-card ${isSelected ? "selected" : ""}"
                  @click="${() => musicConfig(this.hass, { wake_playlist_id: pl.id })}"
                >
                  <div class="preset-top">
                    <ha-icon
                      icon="${pl.icon || "mdi:playlist-music"}"
                      style="color: ${isSelected ? "#ffb74d" : "var(--sol-cyan)"}; --mdc-icon-size: 19px;"
                    ></ha-icon>
                    <div class="preset-name">${pl.name}</div>
                    <span class="badge ${isSelected ? "badge-amber" : "badge-dim"}">
                      ${isSelected ? "Selected Preset" : `${pl.track_count} tracks`}
                    </span>
                  </div>
                  <div class="preset-desc">${pl.description}</div>
                  <div class="preset-next">
                    Up Next (#${nextTrack.index + 1}/${pl.track_count}):
                    <strong>${nextTrack.title}</strong> — ${nextTrack.artist}
                  </div>
                </div>
              `;
            })}
          </div>
        </div>

        <!-- 3. Virtual Sunrise Spline Curve -->
        <div class="card full-col">
          <div class="head">
            <ha-icon icon="mdi:chart-bell-curve-cumulative" style="color: #ffb74d;"></ha-icon>
            <div class="title">Virtual Sunrise Lighting Curve</div>
            <sol-help
              text="Gradual artificial dawn simulated in the bedroom leading up to your Target Wake-Up Time. 100% on the X-axis corresponds to your Target Wake-Up Time (${wakeTime}). Output is dynamically clamped by Master Demand so electric lights never exceed natural daylight."
            ></sol-help>
            <div class="spacer"></div>
            <button class="btn-reset" @click="${() => this.resetSunrise()}">Reset Curve</button>
            <button
              class="toggle-btn ${riseActive ? "toggle-on" : "toggle-off"}"
              style="margin-left: 6px;"
              @click="${() => {
                if (bed) setRoom(this.hass, bed.subentry_id, { sunrise_enabled: !riseActive });
              }}"
            >
              ${riseActive ? "Sunrise Lights: ON" : "Sunrise Lights: OFF"}
            </button>
          </div>

          <div class="curve-ctrl-bar">
            <div class="curve-metric">
              <span>Fade duration before ${wakeTime}:</span>
              <div class="input-with-unit">
                <input
                  type="number"
                  class="num-input"
                  style="width: 60px;"
                  min="5"
                  max="120"
                  .value="${String(fadeMins)}"
                  @change="${(e: Event) => {
                    const v = parseFloat((e.target as HTMLInputElement).value);
                    setHouse(this.hass, { sunrise_fade_minutes: v });
                  }}"
                />
                <span class="unit-label">min (starts ${fadeStartStr})</span>
              </div>
            </div>
            <div class="curve-metric" style="margin-left: auto;">
              <span>Peak at ${wakeTime}:</span>
              <strong style="color: #ffb74d;">${peakLevel} lvl / 254</strong>
            </div>
            <div class="curve-metric">
              <span>Demand Ceiling:</span>
              <strong style="color: var(--sol-cyan);">${currentDemandLevel} lvl / 254</strong>
            </div>
            ${this.hoverSunrise
              ? html`
                  <div class="curve-metric">
                    <span>Time: <strong>${progressToTimeStr(wakeTime, fadeMins, this.hoverSunrise.x)}</strong></span>
                    <span>Level: <strong>${this.hoverSunrise.y} lvl</strong></span>
                  </div>
                `
              : nothing}
          </div>

          <div class="svg-wrap">
            <svg
              id="svg-sunrise"
              viewBox="0 0 ${VW} ${VH}"
              @click="${(e: MouseEvent) => this.handleSvgClick(e)}"
              @mousemove="${(e: MouseEvent) => {
                const target = e.currentTarget as SVGSVGElement | null;
                if (!target) return;
                const rect = target.getBoundingClientRect();
                const px = (e.clientX - rect.left) * (VW / rect.width);
                const py = (e.clientY - rect.top) * (VH / rect.height);
                if (px >= X0 && px <= X1 && py >= Y0 && py <= Y1) {
                  this.hoverSunrise = {
                    x: Math.round(this.fromSvgX(px)),
                    y: this.fromSvgY(py),
                  };
                } else {
                  this.hoverSunrise = null;
                }
              }}"
              @mouseleave="${() => (this.hoverSunrise = null)}"
            >
              <defs>
                <linearGradient id="grad-sunrise-wake" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#ffb74d" stop-opacity="0.32" />
                  <stop offset="100%" stop-color="#ffb74d" stop-opacity="0.02" />
                </linearGradient>
              </defs>

              ${(() => {
                const steps = fadeMins % 6 === 0 ? 6 : fadeMins % 5 === 0 ? 5 : 4;
                return Array.from({ length: steps + 1 }, (_, i) => (i / steps) * 100).map((pct) => {
                  const x = this.toSvgX(pct);
                  const label = progressToTimeStr(wakeTime, fadeMins, pct);
                  return svg`
                    <line x1="${x}" y1="${Y0}" x2="${x}" y2="${Y1}" stroke="rgba(255,255,255,0.06)" stroke-width="1" />
                    <text x="${x}" y="${VH - 6}" fill="var(--sol-text-4)" font-size="10.5" text-anchor="middle">${label}</text>
                  `;
                });
              })()}
              ${[0, 64, 128, 192, 254].map((lvl) => {
                const y = this.toSvgY(lvl);
                return svg`
                  <line x1="${X0}" y1="${y}" x2="${X1}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1" />
                  <text x="${X0 - 8}" y="${y + 3}" fill="var(--sol-text-4)" font-size="9.5" text-anchor="end">${lvl}</text>
                `;
              })}

              <line
                x1="${X0}"
                y1="${demandSvgY}"
                x2="${X1}"
                y2="${demandSvgY}"
                stroke="var(--sol-cyan)"
                stroke-width="1.5"
                stroke-dasharray="4,4"
                opacity="0.75"
              />
              <text x="${X1 - 4}" y="${demandSvgY - 5}" fill="var(--sol-cyan)" font-size="9" text-anchor="end">Demand Cap</text>

              <path d="${this.buildArea(sunriseNodes)}" fill="url(#grad-sunrise-wake)" />
              <path d="${this.buildPath(sunriseNodes)}" fill="none" stroke="#ffb74d" stroke-width="2.5" />

              ${riseProgress !== null
                ? svg`
                    <line
                      x1="${this.toSvgX(riseProgress * 100)}"
                      y1="${Y0}"
                      x2="${this.toSvgX(riseProgress * 100)}"
                      y2="${Y1}"
                      stroke="#ffffff"
                      stroke-width="2"
                    />
                  `
                : nothing}

              ${sunriseNodes.map((n, i) => {
                const cx = this.toSvgX(n.x);
                const cy = this.toSvgY(n.y);
                const isSelected = this.selSunriseIdx === i;
                return svg`
                  <circle
                    cx="${cx}"
                    cy="${cy}"
                    r="${isSelected ? 7 : 5.5}"
                    fill="${isSelected ? "#ffffff" : "#ffb74d"}"
                    stroke="#1a1c1e"
                    stroke-width="2"
                    style="cursor: grab;"
                    @mousedown="${(e: MouseEvent) => {
                      e.stopPropagation();
                      this._drag = { idx: i };
                      this.selSunriseIdx = i;
                    }}"
                  />
                `;
              })}
            </svg>
          </div>

          ${this.selSunriseIdx !== null && sunriseNodes[this.selSunriseIdx]
            ? html`
                <div class="node-editor">
                  <span style="font-size: 11.5px; color: var(--sol-text-3);">Node ${this.selSunriseIdx + 1}</span>
                  <span style="font-size: 11.5px; color: #ffb74d; font-weight: 600; margin-left: 8px;">
                    ${progressToTimeStr(wakeTime, fadeMins, sunriseNodes[this.selSunriseIdx].x)}
                  </span>
                  <span style="font-size: 11.5px; color: var(--sol-text-2); margin-left: 10px;">Position (%)</span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    ?disabled="${this.selSunriseIdx === 0 || this.selSunriseIdx === sunriseNodes.length - 1}"
                    .value="${String(sunriseNodes[this.selSunriseIdx].x)}"
                    @change="${(e: Event) => {
                      const v = Math.max(0, Math.min(100, parseFloat((e.target as HTMLInputElement).value)));
                      const nodes = [...sunriseNodes];
                      nodes[this.selSunriseIdx!] = { ...nodes[this.selSunriseIdx!], x: v };
                      nodes.sort((a, b) => a.x - b.x);
                      this.localSunrise = nodes;
                      this.debounceSaveSunrise();
                    }}"
                  />
                  <span style="font-size: 11.5px; color: var(--sol-text-2); margin-left: 6px;">Level (0-254 lvl)</span>
                  <input
                    type="number"
                    min="0"
                    max="254"
                    .value="${String(sunriseNodes[this.selSunriseIdx].y)}"
                    @change="${(e: Event) => {
                      const v = Math.max(0, Math.min(254, parseInt((e.target as HTMLInputElement).value, 10)));
                      const nodes = [...sunriseNodes];
                      nodes[this.selSunriseIdx!] = { ...nodes[this.selSunriseIdx!], y: v };
                      this.localSunrise = nodes;
                      this.debounceSaveSunrise();
                    }}"
                  />
                  ${this.selSunriseIdx > 0 && this.selSunriseIdx < sunriseNodes.length - 1
                    ? html`
                        <button class="btn-node-del" @click="${() => this.deleteSunriseNode(this.selSunriseIdx!)}">
                          Delete node
                        </button>
                      `
                    : nothing}
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-tab-wakeup": SolTabWakeup;
  }
}
