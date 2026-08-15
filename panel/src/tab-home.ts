/**
 * Home — what the engine is doing right now, and the controls you reach for daily.
 *
 * The organising rule is the handoff's: **never render a stop number alone.** Every bias
 * control carries "→ level N (x % light)" beside it, computed by the engine that will
 * actually drive the bulb. Displays that are always visible show the *room* result;
 * per-light values live behind the disclosure.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Hass, LightRow, RoomRow, Snapshot, ZoneRow } from "./api";
import { roomAction, setHouse, setLight, setRoom, setZones } from "./api";
import { ago, consequence, countdown, lightPct, num, stopLabel } from "./fmt";
import { tokens } from "./tokens";
import "./ui";

const HELP = {
  houseBias:
    "Shifts every room at once, in stops. One stop is a doubling of light. Rooms keep their own offsets, so this moves the whole house without flattening the differences between rooms.",
  roomBias:
    "This room's offset from the house, in stops. Added to the house bias, never multiplied by it.",
  zoneBias:
    "A layer between the room and its individual lights. Use it when part of a room wants a different level from the rest.",
  ambience:
    "A resting glow floor for this room while you are awake and it is dark outside. Replaces off — never lowers a light that is already active. 0 means this room follows the house-wide setting.",
  diminish:
    "Kitchen behaviour. When the near sensor reads clear the lights reduce by this much and stay there — they never switch off from diminish alone. 0 means no effect.",
  perLight:
    "Per-light offsets, in stops, added on top of the house, room and zone biases. Min is a cutoff: demand below it turns the light off entirely. Max is a clamp: the light never exceeds it.",
  min: "A cutoff, not a floor. If the computed level falls below this, the light goes off rather than sitting at a useless glow.",
  max: "A hard clamp applied last, after everything else. The light never exceeds it — this is what makes a glare cap a rule rather than a suggestion.",
  manual:
    "Manual hands this room to you and stops Solace writing to it. A touch on a physical switch does the same for a while; this switch holds until you turn it off.",
  zone:
    "A part of this area with its own bias — the office end of a living room, the sink end of a kitchen. Same four walls, so it shares the area's presence and its dials; the zone bias is an offset on top.",
  zoneDiminish:
    "When this zone's own sensor reads clear, its lights reduce by this much and stay there. They never switch off from diminish alone. 0 means no effect.",
  nightOff:
    "When you are asleep this room goes fully dark instead of dropping to the night level. Once you are up it rejoins the house at the night level, so the room you are standing in is never the dark one.",
};

@customElement("sol-tab-home")
export class SolTabHome extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;
  @state() private open = new Set<string>();
  /** Local echo so a dragged slider tracks the thumb rather than the round trip. */
  @state() private draft: Record<string, number> = {};
  private timer?: number;
  private _debounceTimers: Map<string, number> = new Map();

  connectedCallback() {
    super.connectedCallback();
    this.timer = window.setInterval(() => this.requestUpdate(), 1000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timer) clearInterval(this.timer);
    for (const t of this._debounceTimers.values()) {
      clearTimeout(t);
    }
    this._debounceTimers.clear();
  }

  static styles = [
    tokens,
    css`
      .strip {
        background: var(--sol-card);
        border-radius: var(--sol-r-card);
        padding: 10px 14px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        font-size: 12.5px;
        color: var(--sol-text-3);
        box-shadow: var(--sol-shadow);
      }
      .strip > div {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 0 14px;
        border-left: 1px solid rgba(255, 255, 255, 0.1);
      }
      .strip > div:first-child {
        border-left: none;
        padding-left: 0;
      }
      .strip ha-icon {
        --mdc-icon-size: 17px;
      }
      .strip b {
        color: var(--sol-text);
        font-weight: 500;
        font-variant-numeric: tabular-nums;
      }

      .house {
        background: var(--sol-card);
        border-radius: var(--sol-r-card);
        padding: 12px 16px;
        margin-top: 14px;
        display: flex;
        align-items: center;
        gap: 12px;
        box-shadow: var(--sol-shadow);
      }
      .house .name {
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: 13.5px;
        font-weight: 500;
        flex: 0 0 auto;
      }
      .house ha-icon {
        --mdc-icon-size: 19px;
        color: var(--sol-cyan);
      }
      .readout {
        font-size: 13px;
        font-variant-numeric: tabular-nums;
        flex: 0 0 82px;
        text-align: right;
      }
      .cons {
        font-size: 11.5px;
        color: var(--sol-text-4);
        flex: 0 0 auto;
        white-space: nowrap;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(430px, 1fr));
        gap: 14px;
        align-items: start;
        margin-top: 14px;
      }
      @media (max-width: 500px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }

      .room {
        background: var(--sol-card);
        border-radius: var(--sol-r-card);
        padding: 14px 16px 12px;
        box-shadow: var(--sol-shadow);
      }
      .room-head {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .room-head .room-icon {
        --mdc-icon-size: 26px;
        color: var(--sol-faint);
        transition: color 0.15s ease;
      }
      .room-head .room-icon.lit {
        color: var(--sol-amber);
      }
      .room-head .motion-icon {
        --mdc-icon-size: 14px;
        color: var(--sol-faint);
        margin-left: -4px;
        margin-right: 4px;
        transition: color 0.15s ease;
      }
      .room-head .motion-icon.motion-active {
        color: var(--sol-amber, #ffb74d);
      }
      .room-head .title {
        flex: 1;
        min-width: 0;
      }
      .room-head h3 {
        margin: 0;
        font-size: 16px;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .room-head .sub {
        font-size: 11.5px;
        color: var(--sol-text-4);
      }

      .status {
        display: flex;
        gap: 24px;
        background: var(--sol-block);
        border-radius: var(--sol-r-block);
        padding: 9px 14px;
        margin-top: 11px;
      }
      .status div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .status .v {
        font-size: 13px;
        font-variant-numeric: tabular-nums;
      }

      .manual-block {
        background: var(--sol-amber-surface);
        border-radius: var(--sol-r-block);
        padding: 10px 12px;
        margin-top: 11px;
      }
      .manual-block .top {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12.5px;
        color: var(--sol-amber-light);
      }
      .manual-block ha-icon {
        --mdc-icon-size: 16px;
      }
      button.ghost {
        all: unset;
        cursor: pointer;
        font-size: 11.5px;
        padding: 4px 10px;
        border-radius: var(--sol-r-control);
        border: 1px solid rgba(255, 183, 77, 0.4);
        color: var(--sol-amber);
        white-space: nowrap;
        margin-left: auto;
      }
      .manual-block .note {
        font-size: 11px;
        color: var(--sol-text-4);
        margin-top: 6px;
      }

      .bias-row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 11px;
        font-size: 12.5px;
        color: var(--sol-text-2);
      }
      .bias-row .lab {
        flex: 0 0 92px;
        display: flex;
        align-items: center;
        gap: 5px;
      }

      .tape-measure {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
        position: relative;
      }
      .tape-ticks {
        display: flex;
        justify-content: space-between;
        font-size: 9.5px;
        color: var(--sol-text-4);
        padding: 2px 2px 0;
        font-variant-numeric: tabular-nums;
      }

      .disclose {
        all: unset;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 12px;
        font-size: 12px;
        color: var(--sol-text-3);
        border-radius: var(--sol-r-control);
      }
      .disclose ha-icon {
        --mdc-icon-size: 16px;
        transition: transform 0.15s ease;
      }
      .disclose ha-icon.open {
        transform: rotate(90deg);
      }

      .lights {
        margin-top: 8px;
      }
      .zone-head {
        display: flex;
        align-items: center;
        gap: 8px;
        background: var(--sol-block);
        border-radius: var(--sol-r-control);
        padding: 5px 9px;
        margin-top: 8px;
      }
      .zone-head sol-slider {
        max-width: 120px;
      }
      .zone-head .zv {
        font-size: 11px;
        color: var(--sol-text-4);
        min-width: 46px;
        text-align: right;
      }
      .zone-head.warnrow {
        background: var(--sol-amber-surface);
      }
      .lrow {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 152px 60px 60px;
        gap: 8px;
        align-items: center;
        padding: 8px 0;
        border-top: 1px solid rgba(255, 255, 255, 0.05);
      }
      .lrow .lname {
        min-width: 0;
      }
      .lrow .lname .n {
        font-size: 12.5px;
        color: var(--sol-text-2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .lrow .lname .s {
        font-size: 11px;
        color: var(--sol-text-4);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .lrow .lname .s .hw {
        color: var(--sol-amber);
      }
      .adj {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .adj .sv {
        font-size: 11.5px;
        font-variant-numeric: tabular-nums;
        color: var(--sol-text-4);
        flex: 0 0 38px;
        text-align: right;
      }
      .adj .sv.moved {
        color: var(--sol-text);
      }
      .lhead {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 152px 60px 60px;
        gap: 8px;
        align-items: center;
        padding-bottom: 4px;
      }
      .lhead .eyebrow {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .footer {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 10px;
        padding-top: 9px;
        border-top: 1px solid rgba(255, 255, 255, 0.05);
        font-size: 12.5px;
        color: var(--sol-text-2);
      }
      .footer .lab {
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .grow {
        flex: 1;
      }
      .pill {
        font-size: 10.5px;
        letter-spacing: 0.4px;
        text-transform: uppercase;
        padding: 2px 8px;
        border-radius: 10px;
        background: var(--sol-control);
        color: var(--sol-text-3);
      }
      .pill.on {
        background: var(--sol-cyan-tint);
        color: var(--sol-cyan);
      }
      .pill.off {
        color: var(--sol-faint);
      }
    `,
  ];

  /* ---------------------------------------------------------------- writes */

  private key(...parts: string[]) {
    return parts.join("|");
  }

  private local(key: string, fallback: number): number {
    return this.draft[key] ?? fallback;
  }

  private async pushHouse(key: string, value: number, final: boolean) {
    const draftKey = this.key("h", key);
    this.draft = { ...this.draft, [draftKey]: value };

    const existing = this._debounceTimers.get(draftKey);
    if (existing) clearTimeout(existing);

    if (final) {
      this._debounceTimers.delete(draftKey);
      await setHouse(this.hass, { [key]: value });
      this.clearDraft(draftKey);
    } else {
      const timer = window.setTimeout(async () => {
        this._debounceTimers.delete(draftKey);
        await setHouse(this.hass, { [key]: value });
      }, 1000);
      this._debounceTimers.set(draftKey, timer);
    }
  }

  private async pushRoom(id: string, key: string, value: number | boolean, final = true) {
    const draftKey = this.key(id, key);
    if (typeof value === "number") this.draft = { ...this.draft, [draftKey]: value };

    const existing = this._debounceTimers.get(draftKey);
    if (existing) clearTimeout(existing);

    if (final || typeof value === "boolean") {
      this._debounceTimers.delete(draftKey);
      await setRoom(this.hass, id, { [key]: value });
      if (typeof value === "number") this.clearDraft(draftKey);
    } else {
      const timer = window.setTimeout(async () => {
        this._debounceTimers.delete(draftKey);
        await setRoom(this.hass, id, { [key]: value });
      }, 1000);
      this._debounceTimers.set(draftKey, timer);
    }
  }

  private async pushLight(id: string, entity: string, key: string, value: number | null) {
    await setLight(this.hass, id, entity, { [key]: value });
  }

  /** Drop the local echo once the snapshot has caught up, so the server stays the truth. */
  private clearDraft(key: string) {
    window.setTimeout(() => {
      const next = { ...this.draft };
      delete next[key];
      this.draft = next;
    }, 700);
  }

  /* ---------------------------------------------------------------- render */

  private roomIcon(name: string): string {
    const n = name.toLowerCase();
    if (n.includes("bed")) return "mdi:bed";
    if (n.includes("kitchen") || n.includes("diner")) return "mdi:countertop";
    if (n.includes("entry") || n.includes("hall")) return "mdi:door-open";
    if (n.includes("office")) return "mdi:desk";
    return "mdi:sofa";
  }

  private renderStrip() {
    const w = this.snap.world;
    return html`<div class="strip" style="justify-content: flex-end; padding: 6px 14px; background: transparent; box-shadow: none; margin-bottom: -4px;">
      <div style="border-left: none; padding: 0;"><span>Updated</span><b>${ago(w.updated_at)}</b></div>
    </div>`;
  }

  private renderHouseBias() {
    const gamma = this.snap.house.gamma ?? 2.39;
    const key = this.key("h", "bias_stops");
    const value = this.local(key, this.snap.house.bias_stops ?? 0);
    const ref = Math.max(0, ...this.snap.rooms.map((r) => r.level ?? 0));

    const presets = [
      { label: "Cozy", v: -1.5 },
      { label: "Relaxed", v: -0.75 },
      { label: "Normal", v: 0 },
      { label: "Energized", v: 1.0 },
      { label: "High focus", v: 1.5 },
    ];

    return html`<div class="house" style="flex-direction: column; align-items: stretch; gap: 10px;">
      <div style="display: flex; align-items: center; gap: 11px; flex-wrap: wrap;">
        <div class="name">
          <ha-icon icon="mdi:camera-metering-spot" style="color: var(--sol-blue);"></ha-icon>
          <span>Master mood &amp; energy trim</span>
          <sol-help text="One dial for the whole house in photographic stops — doubles or halves the baseline level settled on by the curves."></sol-help>
        </div>
        <div style="flex: 1;"></div>
        <div style="display: flex; background: var(--sol-control); border-radius: 14px; padding: 2px; gap: 2px;">
          ${presets.map(
            (p) => html`
              <button
                style="border: none; cursor: pointer; border-radius: 12px; padding: 4px 10px; font: 500 11.5px Roboto, sans-serif; background: ${value === p.v ? "#3b4a52" : "transparent"}; color: ${value === p.v ? "var(--sol-blue)" : "var(--sol-text-3)"};"
                @click=${() => this.pushHouse("bias_stops", p.v, true)}
              >
                ${p.label}
              </button>
            `
          )}
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <sol-slider
          .value=${value}
          .min=${-2}
          .max=${2}
          .step=${0.1}
          @value-changed=${(e: CustomEvent) =>
            this.pushHouse("bias_stops", e.detail.value, e.detail.final)}
        ></sol-slider>
        <div class="readout tab-num">${stopLabel(value)}</div>
        <div class="cons">${ref ? consequence(ref, gamma) : "→ all rooms dark"}</div>
        ${value !== 0
          ? html`<button
              style="background: none; border: none; padding: 2px; cursor: pointer; color: var(--sol-text-3);"
              title="Reset to 0 stops"
              @click=${() => this.pushHouse("bias_stops", 0, true)}
            >
              <ha-icon icon="mdi:restore" style="--mdc-icon-size: 16px;"></ha-icon>
            </button>`
          : nothing}
      </div>
    </div>`;
  }

  private renderLight(room: RoomRow, light: LightRow) {
    const gamma = this.snap.house.gamma ?? 2.39;
    const key = this.key(room.subentry_id, light.entity_id, "bias");
    const adj = this.local(key, light.bias_stops);
    const clampedNote = light.kelvin_clamped
      ? `held at ${num(light.max_kelvin)} K by its bulb`
      : "";
    return html`<div class="lrow">
      <div class="lname">
        <div class="n" title=${light.name}>${light.name}</div>
        <div class="s">
          ${light.group_size > 1 ? html`<span>group of ${light.group_size} · </span>` : nothing}
          ${clampedNote ? html`<span class="hw">${clampedNote} · </span>` : nothing}
          <span class="tab-num"
            >level ${light.level ?? "—"}${light.level !== null
              ? ` (${lightPct(light.level, gamma)} %)`
              : ""}</span
          >
        </div>
      </div>
      <div class="adj">
        <sol-slider
          small
          .value=${adj}
          .min=${-2}
          .max=${2}
          .step=${0.1}
          @value-changed=${(e: CustomEvent) => {
            this.draft = { ...this.draft, [key]: e.detail.value };
            this.pushLight(room.subentry_id, light.entity_id, "bias_stops", e.detail.value);
            if (e.detail.final) this.clearDraft(key);
          }}
        ></sol-slider>
        <span class="sv ${adj !== 0 ? "moved" : ""}">${stopLabel(adj).replace(" stops", "").replace(" stop", "")}</span>
      </div>
      <sol-number
        clearable
        .value=${light.clamp_min}
        .min=${0}
        .max=${254}
        .width=${54}
        @value-changed=${(e: CustomEvent) =>
          this.pushLight(room.subentry_id, light.entity_id, "clamp_min", e.detail.value)}
      ></sol-number>
      <sol-number
        clearable
        .value=${light.clamp_max}
        .min=${1}
        .max=${254}
        .width=${54}
        @value-changed=${(e: CustomEvent) =>
          this.pushLight(room.subentry_id, light.entity_id, "clamp_max", e.detail.value)}
      ></sol-number>
    </div>`;
  }

  /**
   * Per-light rows, grouped under their zone.
   */
  private renderGrouped(room: RoomRow) {
    if (!room.zones.length) return room.lights.map((l) => this.renderLight(room, l));
    const unassigned = room.lights.filter((l) => !l.zone_id);
    return html`
      ${room.zones.map((zone) => {
        const lights = room.lights.filter((l) => l.zone_id === zone.zone_id);
        if (!lights.length) return nothing;
        return html`
          <div class="zone-head">
            <span class="eyebrow">${zone.name}</span>
            ${zone.clear === null
              ? nothing
              : html`<span class="pill ${zone.clear ? "off" : "on"}"
                  >${zone.clear ? "clear" : "occupied"}</span
                >`}
            <span class="grow"></span>
            <sol-slider
              small
              .value=${zone.bias_stops}
              .min=${-2}
              .max=${2}
              .step=${0.1}
              @value-changed=${(e: CustomEvent) =>
                this.pushZone(room, zone, { bias_stops: e.detail.value })}
            ></sol-slider>
            <span class="zv tab-num">${stopLabel(zone.bias_stops)}</span>
            ${zone.presence.length
              ? html`<sol-number
                  .value=${zone.diminish_pct}
                  .min=${0}
                  .max=${100}
                  .width=${48}
                  suffix="% when clear"
                  @value-changed=${(e: CustomEvent) =>
                    this.pushZone(room, zone, { diminish_pct: e.detail.value })}
                ></sol-number>`
              : nothing}
          </div>
          ${lights.map((l) => this.renderLight(room, l))}
        `;
      })}
      ${unassigned.length
        ? html`<div class="zone-head warnrow">
              <span class="eyebrow">Not in a zone</span>
              <sol-help
                flip
                .text=${"These lights take the area's own zone bias. Assign them to a zone if you want them to follow one."}
              ></sol-help>
            </div>
            ${unassigned.map((l) => this.renderLight(room, l))}`
        : nothing}
    `;
  }

  private async pushZone(
    room: RoomRow,
    zone: ZoneRow,
    patch: Partial<ZoneRow>
  ) {
    const next = room.zones.map((z) => (z.zone_id === zone.zone_id ? { ...z, ...patch } : z));
    await setZones(this.hass, room.subentry_id, next);
  }

  private renderRoom(room: RoomRow) {
    const gamma = this.snap.house.gamma ?? 2.39;
    const lit = (room.level ?? 0) > 0;
    const open = this.open.has(room.subentry_id);
    const manual = room.manual.active;

    const biasKey = this.key(room.subentry_id, "bias_stops");
    const bias = this.local(biasKey, Number(room.settings.bias_stops ?? 0));
    const zoneKey = this.key(room.subentry_id, "zone_bias_stops");
    const zone = this.local(zoneKey, Number(room.settings.zone_bias_stops ?? 0));

    const ambKey = this.key(room.subentry_id, "ambience_level");
    const ambVal = this.local(ambKey, Number(room.settings.ambience_level ?? 0));

    return html`<div class="room">
      <div class="room-head">
        <ha-icon class="room-icon ${lit ? "lit" : ""}" icon=${this.roomIcon(room.name)}></ha-icon>
        <div class="title">
          <div style="display:flex;align-items:center;gap:6px">
            <h3>${room.name}</h3>
            <ha-icon
              style="margin-left: 6px;"
              class="motion-icon ${room.occupied ? "motion-active" : ""}"
              icon="mdi:motion-sensor"
              title="${room.occupied ? "Occupied" : "Clear"}"
            ></ha-icon>
          </div>
        </div>
        <sol-segmented
          .options=${[
            { value: "auto", label: "Auto" },
            { value: "manual", label: "Manual", tone: "amber" as const },
          ]}
          .value=${manual ? "manual" : "auto"}
          @segment-changed=${(e: CustomEvent) =>
            roomAction(this.hass, room.subentry_id, e.detail.value === "manual" ? "manual" : "auto")}
        ></sol-segmented>
      </div>

      ${manual
        ? html`<div class="manual-block">
            <div class="top">
              <ha-icon icon="mdi:clock-outline"></ha-icon>
              <span
                >${room.manual.switch
                  ? "Held until you switch back"
                  : `Auto resumes in ${countdown(room.manual.remaining_s)}`}</span
              >
              <button class="ghost" @click=${() => roomAction(this.hass, room.subentry_id, "auto")}>
                Resume now
              </button>
            </div>
            <div class="bias-row">
              <sol-slider
                tone="amber"
                noReset
                .value=${Math.max(...room.lights.map((l) => l.current_level), 0)}
                .min=${0}
                .max=${254}
                .step=${1}
                @value-changed=${(e: CustomEvent) =>
                  roomAction(this.hass, room.subentry_id, "level", Math.round(e.detail.value))}
              ></sol-slider>
              <div class="readout tab-num">
                ${Math.max(...room.lights.map((l) => l.current_level), 0)} ·
                ${lightPct(Math.max(...room.lights.map((l) => l.current_level), 0), gamma)} %
              </div>
            </div>
            <div class="note">A physical switch left on holds this room indefinitely.</div>
          </div>`
        : html`<div class="status">
            <div>
              <span class="eyebrow">Demand</span>
              <span class="v tab-num"
                >${room.demand === null ? "—" : `${Math.round(room.demand * 100)} %`}</span
              >
            </div>
            <div>
              <span class="eyebrow">Output</span>
              <span class="v tab-num"
                >${room.level === null ? "—" : `${lightPct(room.level, gamma)} %`}</span
              >
            </div>
            <div>
              <span class="eyebrow">Mode</span>
              <span class="v">${room.mode ?? "—"}</span>
            </div>
          </div>`}

      <div class="bias-row">
        <span class="lab">Room bias <sol-help .text=${HELP.roomBias}></sol-help></span>
        <sol-slider
          .value=${bias}
          .min=${-2}
          .max=${2}
          .step=${0.1}
          @value-changed=${(e: CustomEvent) =>
            this.pushRoom(room.subentry_id, "bias_stops", e.detail.value, e.detail.final)}
        ></sol-slider>
        <span class="readout tab-num">${stopLabel(bias)}</span>
        <span class="cons">${consequence(room.level, gamma)}</span>
      </div>

      <!-- Tape-measure Ambience Slider -->
      <div class="bias-row">
        <span class="lab">Ambience <sol-help .text=${HELP.ambience}></sol-help></span>
        <div class="tape-measure">
          <sol-slider
            tone="cyan"
            noReset
            .value=${ambVal}
            .min=${0}
            .max=${254}
            .step=${1}
            @value-changed=${(e: CustomEvent) =>
              this.pushRoom(room.subentry_id, "ambience_level", e.detail.value, e.detail.final)}
          ></sol-slider>
          <div class="tape-ticks">
            <span>0%</span>
            <span>10%</span>
            <span>25%</span>
            <span>50%</span>
            <span>75%</span>
            <span>100%</span>
          </div>
        </div>
        <span class="readout tab-num">
          ${ambVal === 0 ? "Follows house" : `L${ambVal} (${lightPct(ambVal, gamma)} %)`}
        </span>
      </div>

      ${room.zones && room.zones.length > 1
        ? html`<div class="bias-row">
            <span class="lab">Zone bias <sol-help .text=${HELP.zoneBias}></sol-help></span>
            <sol-slider
              .value=${zone}
              .min=${-1}
              .max=${1}
              .step=${0.1}
              @value-changed=${(e: CustomEvent) =>
                this.pushRoom(room.subentry_id, "zone_bias_stops", e.detail.value, e.detail.final)}
            ></sol-slider>
            <span class="readout tab-num">${stopLabel(zone)}</span>
          </div>`
        : nothing}

      ${room.has_near && !room.zones.some((z) => z.presence.length)
        ? html`<div class="bias-row">
            <span class="lab">Diminish <sol-help .text=${HELP.diminish}></sol-help></span>
            <span class="pill ${room.near_clear ? "off" : "on"}"
              >near ${room.near_clear ? "clear" : "occupied"}</span
            >
            <span class="grow"></span>
            <sol-number
              .value=${Number(room.settings.diminish_pct ?? 0)}
              .min=${0}
              .max=${100}
              suffix="% when clear"
              .width=${52}
              @value-changed=${(e: CustomEvent) =>
                this.pushRoom(room.subentry_id, "diminish_pct", e.detail.value)}
            ></sol-number>
          </div>`
        : nothing}

      <button
        class="disclose"
        aria-expanded=${open}
        @click=${() => {
          const next = new Set(this.open);
          next.has(room.subentry_id)
            ? next.delete(room.subentry_id)
            : next.add(room.subentry_id);
          this.open = next;
        }}
      >
        <ha-icon class=${open ? "open" : ""} icon="mdi:chevron-right"></ha-icon>
        Per-light adjustments (${room.lights.length}${room.zones.length > 1 ? ` in ${room.zones.length} zones` : ""})
      </button>

      ${open
        ? html`<div class="lights">
            <div class="lhead">
              <span class="eyebrow">Light</span>
              <span class="eyebrow">Adjustment <sol-help .text=${HELP.perLight}></sol-help></span>
              <span class="eyebrow">Min <sol-help flip .text=${HELP.min}></sol-help></span>
              <span class="eyebrow">Max <sol-help flip .text=${HELP.max}></sol-help></span>
            </div>
            ${this.renderGrouped(room)}
          </div>`
        : nothing}

      <div class="footer">
        <span class="grow"></span>
        <span class="lab">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input
              type="checkbox"
              .checked=${Boolean(room.settings.night_off)}
              @change=${(e: Event) =>
                this.pushRoom(
                  room.subentry_id,
                  "night_off",
                  (e.target as HTMLInputElement).checked
                )}
            />
            Off when asleep
          </label>
          <sol-help flip .text=${HELP.nightOff}></sol-help>
        </span>
      </div>
    </div>`;
  }

  render() {
    return html`
      ${this.renderStrip()} ${this.renderHouseBias()}
      <div class="grid">${this.snap.rooms.map((r) => this.renderRoom(r))}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-tab-home": SolTabHome;
  }
}
