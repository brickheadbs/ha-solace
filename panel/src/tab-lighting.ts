/**
 * Lighting — compact Edenkiln-style room cards with EV room bias up front and
 * collapsible "Room setup & fixtures" drawer (Threshold offset in stops, Ambience,
 * Occupied bounds, Sleep policy, Zones, and per-light bias/clamps).
 */

import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { customElement } from "./custom-element";
import type { Hass, LightRow, RoomRow, Snapshot, ZoneRow } from "./api";
import { roomAction, setCardOrder, setHouse, setLight, setRoom, setZones } from "./api";
import { ago, consequence, countdown, lightPct, num, stopLabel } from "./fmt";
import { applyOrder, moveItem, nudgeItem, reorderStyles } from "./reorder";
import { tokens } from "./tokens";
import "./ui";

const HELP = {
  houseBias:
    "House-wide baseline shift in photographic stops (±4 EV). One stop doubles (+1 EV) or halves (-1 EV) output across all rooms while preserving inter-room balance.",
  roomBias:
    "Room-specific offset in photographic stops. Uses Exposure Envelope arithmetic: +EV both shifts the room's turn-on lux threshold upward (turning lights on sooner) and boosts dimmed evening schedule levels toward 254.",
  thresholdStops:
    "Permanent room threshold offset in photographic stops (-3 to +6 EV). Divides outdoor lux by 2^EV before evaluating the Lux Curve and Ambience Gate (+1 EV = half window light, +2 EV = quarter window light for north-facing rooms) without altering midnight brightness.",
  zoneBias:
    "Sub-zone offset within a room in photographic stops, added on top of Room Bias.",
  ambience:
    "Resting background floor (L3) while awake and dusk gate is open (0–100). 0 follows the global house setting.",
  occupiedMin:
    "Minimum brightness floor when occupied in Normal Mode (0–254). Exempt in Night Mode so 3 AM corridor navigation stays at Night Level.",
  occupiedMax:
    "Maximum brightness ceiling when occupied in Normal Mode (0–254).",
  stairDarkMin:
    "Stairway brightness at or below Blend Start Lux in Normal Mode (0–254). Keeps stairs gentle after dark while exempting 3 AM Night Mode (which uses Night Level).",
  stairBrightMax:
    "Stairway brightness at or above Blend Full Lux in Normal Mode (0–254). Keeps stairs bright in daylight so your eyes stay adapted to outdoor brightness.",
  stairStartLux:
    "Outdoor lux where the Stairway begins blending upward from Dark Minimum (log2 scale).",
  stairFullLux:
    "Outdoor lux where the Stairway reaches full Bright Maximum (log2 scale).",
  diminish:
    "Percentage step-down (L2) when a near sensor clears while the wider room stays occupied.",
  perLight:
    "Per-fixture bias adjustment in photographic stops, applied after House, Room, and Zone biases.",
  cut: "Daytime low-end cutoff (0–254). Demand below this value drops to 0 while the Ambience Gate is closed.",
  max: "Hard upper hardware ceiling (1–254) enforced across all automatic modes.",
  nightOff:
    "When Sleep Mode is active, forces this room completely dark (0) instead of Night Corridor level.",
};

@customElement("sol-tab-lighting")
export class SolTabLighting extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;
  @property({ type: Boolean }) reorderMode = false;

  @state() private open = new Set<string>();
  @state() private draft: Record<string, number> = {};
  @state() private dragId: string | null = null;
  @state() private overId: string | null = null;

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
    reorderStyles,
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
        margin-top: 10px;
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
        font-size: 12.5px;
        font-variant-numeric: tabular-nums;
        flex: 0 0 112px;
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
      .chip-note {
        margin-left: auto;
        align-self: center;
        font-size: 11px;
        color: var(--sol-amber);
        background: rgba(255, 183, 77, 0.12);
        padding: 2px 8px;
        border-radius: 6px;
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
        flex: 0 0 112px;
        display: flex;
        align-items: center;
        gap: 5px;
      }

      .disclose {
        all: unset;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 12px;
        padding-top: 8px;
        width: 100%;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
        font-size: 12px;
        color: var(--sol-text-3);
      }
      .disclose:hover {
        color: var(--sol-text);
      }
      .disclose ha-icon {
        --mdc-icon-size: 16px;
        transition: transform 0.15s ease;
      }
      .disclose ha-icon.open {
        transform: rotate(90deg);
      }

      .drawer {
        margin-top: 8px;
        padding-top: 6px;
      }
      .lights {
        margin-top: 12px;
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

  private key(...parts: string[]) {
    return parts.join("|");
  }

  private local(key: string, fallback: number): number {
    return this.draft[key] ?? fallback;
  }

  private toggleOpen(id: string) {
    const next = new Set(this.open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.open = next;
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
      }, 600);
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
      }, 600);
      this._debounceTimers.set(draftKey, timer);
    }
  }

  private async pushLight(id: string, entity: string, key: string, value: number | null) {
    await setLight(this.hass, id, entity, { [key]: value });
  }

  private clearDraft(key: string) {
    window.setTimeout(() => {
      const next = { ...this.draft };
      delete next[key];
      this.draft = next;
    }, 700);
  }

  private orderedRooms(): RoomRow[] {
    return applyOrder(
      this.snap.rooms,
      (r) => r.subentry_id,
      this.snap.card_order?.lighting
    );
  }

  private commitOrder(nextIds: string[]) {
    setCardOrder(this.hass, "lighting", nextIds);
  }

  private roomIcon(name: string): string {
    const n = name.toLowerCase();
    if (n.includes("bed")) return "mdi:bed";
    if (n.includes("kitchen") || n.includes("diner")) return "mdi:countertop";
    if (n.includes("entry") || n.includes("hall") || n.includes("stair")) return "mdi:stairs";
    if (n.includes("office")) return "mdi:desk";
    return "mdi:sofa";
  }

  private renderStrip() {
    const w = this.snap.world;
    return html`<div
      class="strip"
      style="justify-content: flex-end; padding: 4px 8px; background: transparent;"
    >
      <div><span>Updated </span><b>${ago(w.updated_at)}</b></div>
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
          <span>Master house exposure bias</span>
          <sol-help .text=${HELP.houseBias}></sol-help>
        </div>
        <div style="flex: 1;"></div>
        <div style="display: flex; background: var(--sol-control); border-radius: 14px; padding: 2px; gap: 2px;">
          ${presets.map(
            (p) => html`
              <button
                style="border: none; cursor: pointer; border-radius: 12px; padding: 4px 10px; font-family: inherit; font-size: 11.5px; font-weight: 500; background: ${value === p.v ? "#3b4a52" : "transparent"}; color: ${value === p.v ? "var(--sol-blue)" : "var(--sol-text-3)"};"
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
        <div class="cons">${ref ? consequence(ref, gamma) : "-> all rooms dark"}</div>
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
      ? `held at ${num(light.max_kelvin)} K by hardware`
      : "";
    return html`<div class="lrow">
      <div class="lname">
        <div class="n" title=${light.name}>${light.name}</div>
        <div class="s">
          ${light.group_size > 1 ? html`<span>group of ${light.group_size} · </span>` : nothing}
          ${clampedNote ? html`<span class="hw">${clampedNote} · </span>` : nothing}
          <span class="tab-num"
            >${light.level !== null ? `${lightPct(light.level, gamma)}% (${light.level} lvl)` : "—"}</span
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
            </div>
            ${unassigned.map((l) => this.renderLight(room, l))}`
        : nothing}
    `;
  }

  private async pushZone(room: RoomRow, zone: ZoneRow, patch: Partial<ZoneRow>) {
    const next = room.zones.map((z) => (z.zone_id === zone.zone_id ? { ...z, ...patch } : z));
    await setZones(this.hass, room.subentry_id, next);
  }

  private renderRoom(room: RoomRow, idx: number, allIds: string[]) {
    const gamma = this.snap.house.gamma ?? 2.39;
    const lit = (room.level ?? 0) > 0;
    const isOpen = this.open.has(room.subentry_id);
    const manual = room.manual.active;

    const biasKey = this.key(room.subentry_id, "bias_stops");
    const bias = this.local(biasKey, Number(room.settings.bias_stops ?? 0));
    const threshKey = this.key(room.subentry_id, "threshold_stops");
    const threshVal =
      Math.round(this.local(threshKey, Number(room.settings.threshold_stops ?? 0)) * 20) / 20;
    const effLux = Math.round((this.snap.world.lux ?? 0) / Math.pow(2, threshVal));
    const zoneKey = this.key(room.subentry_id, "zone_bias_stops");
    const zone = this.local(zoneKey, Number(room.settings.zone_bias_stops ?? 0));

    const ambKey = this.key(room.subentry_id, "ambience_level");
    const ambVal = this.local(ambKey, Number(room.settings.ambience_level ?? 0));

    const occMinKey = this.key(room.subentry_id, "occupied_min");
    const occMinVal = Math.round(this.local(occMinKey, Number(room.settings.occupied_min ?? 0)));
    const occMaxKey = this.key(room.subentry_id, "occupied_max");
    const occMaxVal = Math.round(this.local(occMaxKey, Number(room.settings.occupied_max ?? 254)));
    const isStairway = room.name.toLowerCase().includes("stair");
    const stairStartKey = this.key("h", "stairway_start_lux");
    const stairStartVal = Math.round(
      this.local(stairStartKey, Number(this.snap.house.stairway_start_lux ?? 10))
    );
    const stairFullKey = this.key("h", "stairway_full_lux");
    const stairFullVal = Math.round(
      this.local(stairFullKey, Number(this.snap.house.stairway_full_lux ?? 2000))
    );

    return html`
      <div
        class="reorder-shell ${this.reorderMode ? "reorder-armed" : ""} ${this.overId === room.subentry_id ? "drag-over" : ""}"
        draggable=${this.reorderMode ? "true" : "false"}
        @dragstart=${(e: DragEvent) => {
          if (!this.reorderMode) return;
          this.dragId = room.subentry_id;
          e.dataTransfer?.setData("text/plain", room.subentry_id);
        }}
        @dragover=${(e: DragEvent) => {
          if (!this.reorderMode || !this.dragId) return;
          e.preventDefault();
          this.overId = room.subentry_id;
        }}
        @dragleave=${() => {
          if (this.overId === room.subentry_id) this.overId = null;
        }}
        @drop=${(e: DragEvent) => {
          if (!this.reorderMode || !this.dragId) return;
          e.preventDefault();
          const from = this.dragId;
          this.dragId = null;
          this.overId = null;
          if (from !== room.subentry_id) {
            this.commitOrder(moveItem(allIds, from, room.subentry_id));
          }
        }}
        @dragend=${() => {
          this.dragId = null;
          this.overId = null;
        }}
      >
        ${this.reorderMode
          ? html`
              <div class="reorder-bar">
                <span class="reorder-grip">
                  <ha-icon icon="mdi:drag"></ha-icon>
                  Drag to reorder · ${room.name}
                </span>
                <span class="reorder-arrows">
                  <button
                    class="reorder-btn"
                    ?disabled=${idx === 0}
                    @click=${() => this.commitOrder(nudgeItem(allIds, room.subentry_id, -1))}
                    title="Move earlier"
                  >
                    <ha-icon icon="mdi:arrow-left"></ha-icon>
                  </button>
                  <button
                    class="reorder-btn"
                    ?disabled=${idx === allIds.length - 1}
                    @click=${() => this.commitOrder(nudgeItem(allIds, room.subentry_id, 1))}
                    title="Move later"
                  >
                    <ha-icon icon="mdi:arrow-right"></ha-icon>
                  </button>
                </span>
              </div>
            `
          : nothing}

        <div class="room">
          <div class="room-head">
            <ha-icon class="room-icon ${lit ? "lit" : ""}" icon=${this.roomIcon(room.name)}></ha-icon>
            <div class="title">
              <div style="display:flex;align-items:center;gap:6px">
                <h3>${room.name}</h3>
                <ha-icon
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
                roomAction(
                  this.hass,
                  room.subentry_id,
                  e.detail.value === "manual" ? "manual" : "auto"
                )}
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
                  <button
                    class="ghost"
                    @click=${() => roomAction(this.hass, room.subentry_id, "auto")}
                  >
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
                    ${lightPct(Math.max(...room.lights.map((l) => l.current_level), 0), gamma)}%
                    (${Math.max(...room.lights.map((l) => l.current_level), 0)} lvl)
                  </div>
                </div>
                <div class="note">Held manually — Solace automatic writes are paused.</div>
              </div>`
            : html`<div class="status">
                <div>
                  <span class="eyebrow">${isStairway ? "Eye blend" : "Demand"}</span>
                  <span class="v tab-num"
                    >${room.demand === null ? "—" : `${Math.round(room.demand * 100)} %`}</span
                  >
                </div>
                <div>
                  <span class="eyebrow">Output</span>
                  <span class="v tab-num"
                    >${room.level === null
                      ? "—"
                      : `${lightPct(room.level, gamma)}% (${room.level} lvl)`}</span
                  >
                </div>
                <div>
                  <span class="eyebrow">Mode</span>
                  <span class="v">${room.mode ?? "—"}</span>
                </div>
                ${isStairway
                  ? html`<span class="chip-note" title="Stairway log2-lux eye-adaptation range">
                      Eye curve ${Math.min(occMinVal, occMaxVal)}–${Math.max(occMinVal, occMaxVal)} lvl
                    </span>`
                  : threshVal !== 0
                    ? html`<span class="chip-note" title="Threshold offset active">
                        Threshold ${stopLabel(threshVal)}
                      </span>`
                    : nothing}
              </div>`}

          <!-- Primary Everyday Control: Room Bias (Exposure Envelope) -->
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

          <!-- Disclosure Drawer Toggle -->
          <button class="disclose" @click=${() => this.toggleOpen(room.subentry_id)}>
            <ha-icon class=${isOpen ? "open" : ""} icon="mdi:chevron-right"></ha-icon>
            <span>Room setup &amp; ${room.lights.length} fixture${room.lights.length === 1 ? "" : "s"}</span>
            <span class="grow"></span>
            <span style="font-size: 11px; color: var(--sol-text-4);">
              ${isOpen
                ? "Hide"
                : isStairway
                  ? "Eye-adaptation curve & per-light clamps"
                  : "Thresholds, bounds & per-light clamps"}
            </span>
          </button>

          ${isOpen
            ? html`
                <div class="drawer">
                  ${isStairway
                    ? html`
                        <!-- Stairway-Only Eye-Adaptation Curve Controls -->
                        <div class="bias-row">
                          <span class="lab">
                            Dark minimum <sol-help .text=${HELP.stairDarkMin}></sol-help>
                          </span>
                          <div style="flex: 1; display: flex; align-items: center; gap: 8px;">
                            <sol-slider
                              tone="amber"
                              noReset
                              .value=${occMinVal}
                              .min=${0}
                              .max=${254}
                              .step=${1}
                              @value-changed=${(e: CustomEvent) =>
                                this.pushRoom(
                                  room.subentry_id,
                                  "occupied_min",
                                  Math.round(e.detail.value),
                                  e.detail.final
                                )}
                            ></sol-slider>
                          </div>
                          <span class="readout tab-num">
                            ${lightPct(occMinVal, gamma)}% (${occMinVal} lvl)
                          </span>
                        </div>

                        <div class="bias-row">
                          <span class="lab">
                            Bright maximum <sol-help .text=${HELP.stairBrightMax}></sol-help>
                          </span>
                          <div style="flex: 1; display: flex; align-items: center; gap: 8px;">
                            <sol-slider
                              tone="amber"
                              noReset
                              .value=${occMaxVal}
                              .min=${0}
                              .max=${254}
                              .step=${1}
                              @value-changed=${(e: CustomEvent) =>
                                this.pushRoom(
                                  room.subentry_id,
                                  "occupied_max",
                                  Math.round(e.detail.value),
                                  e.detail.final
                                )}
                            ></sol-slider>
                          </div>
                          <span class="readout tab-num">
                            ${lightPct(occMaxVal, gamma)}% (${occMaxVal} lvl)
                          </span>
                        </div>

                        <div class="bias-row">
                          <span class="lab">
                            Blend start lux <sol-help .text=${HELP.stairStartLux}></sol-help>
                          </span>
                          <div style="flex: 1; display: flex; align-items: center; gap: 8px;">
                            <sol-slider
                              tone="cyan"
                              noReset
                              .value=${Math.min(250, stairStartVal)}
                              .min=${1}
                              .max=${250}
                              .step=${1}
                              @value-changed=${(e: CustomEvent) =>
                                this.pushHouse(
                                  "stairway_start_lux",
                                  Math.round(e.detail.value),
                                  e.detail.final
                                )}
                            ></sol-slider>
                            <sol-number
                              .value=${stairStartVal}
                              .min=${1}
                              .max=${500}
                              suffix="lx"
                              .width=${56}
                              @value-changed=${(e: CustomEvent) =>
                                this.pushHouse("stairway_start_lux", Math.round(e.detail.value), true)}
                            ></sol-number>
                          </div>
                        </div>

                        <div class="bias-row">
                          <span class="lab">
                            Blend full lux <sol-help .text=${HELP.stairFullLux}></sol-help>
                          </span>
                          <div style="flex: 1; display: flex; align-items: center; gap: 8px;">
                            <sol-slider
                              tone="cyan"
                              noReset
                              .value=${Math.min(10000, stairFullVal)}
                              .min=${50}
                              .max=${10000}
                              .step=${50}
                              @value-changed=${(e: CustomEvent) =>
                                this.pushHouse(
                                  "stairway_full_lux",
                                  Math.round(e.detail.value),
                                  e.detail.final
                                )}
                            ></sol-slider>
                            <sol-number
                              .value=${stairFullVal}
                              .min=${50}
                              .max=${20000}
                              suffix="lx"
                              .width=${64}
                              @value-changed=${(e: CustomEvent) =>
                                this.pushHouse("stairway_full_lux", Math.round(e.detail.value), true)}
                            ></sol-number>
                          </div>
                        </div>

                        <div style="font-size: 11px; color: var(--sol-text-4); padding: 4px 2px 6px;">
                          Log2 outdoor lux blend (bright outside -> bright stairs, dark outside -> dim stairs) · Excluded from ambient · Follows house colour · Night Mode uses Night Level.
                        </div>
                      `
                    : html`
                        <!-- Threshold Offset in EV Stops -->
                        <div class="bias-row">
                          <span class="lab">
                            Threshold offset <sol-help .text=${HELP.thresholdStops}></sol-help>
                          </span>
                          <div style="flex: 1; display: flex; align-items: center; gap: 8px;">
                            <sol-slider
                              tone="amber"
                              .value=${threshVal}
                              .min=${-3}
                              .max=${6}
                              .step=${0.05}
                              @value-changed=${(e: CustomEvent) =>
                                this.pushRoom(
                                  room.subentry_id,
                                  "threshold_stops",
                                  Math.round(e.detail.value * 20) / 20,
                                  e.detail.final
                                )}
                            ></sol-slider>
                            <div style="display: flex; gap: 3px;">
                              ${[-1, 0, 1, 2, 3].map(
                                (ev) => html`
                                  <button
                                    style="border: none; cursor: pointer; border-radius: 6px; padding: 2px 6px; font-size: 11px; background: ${threshVal === ev ? "var(--sol-amber-surface)" : "var(--sol-control)"}; color: ${threshVal === ev ? "var(--sol-amber)" : "var(--sol-text-3)"};"
                                    @click=${() =>
                                      this.pushRoom(room.subentry_id, "threshold_stops", ev, true)}
                                  >
                                    ${ev > 0 ? `+${ev}` : ev}
                                  </button>
                                `
                              )}
                            </div>
                          </div>
                          <span class="readout tab-num">
                            ${stopLabel(threshVal)} (${effLux} lx)
                          </span>
                        </div>

                        <!-- Ambience -->
                        <div class="bias-row">
                          <span class="lab">Ambience <sol-help .text=${HELP.ambience}></sol-help></span>
                          <div style="flex: 1; display: flex; align-items: center; gap: 8px;">
                            <sol-slider
                              tone="cyan"
                              noReset
                              .value=${ambVal}
                              .min=${0}
                              .max=${100}
                              .step=${1}
                              @value-changed=${(e: CustomEvent) =>
                                this.pushRoom(
                                  room.subentry_id,
                                  "ambience_level",
                                  e.detail.value,
                                  e.detail.final
                                )}
                            ></sol-slider>
                            <div style="display: flex; gap: 3px;">
                              ${[
                                { label: "House", lvl: 0 },
                                { label: "1%", lvl: 3 },
                                { label: "5%", lvl: 13 },
                                { label: "10%", lvl: 25 },
                                { label: "20%", lvl: 51 },
                              ].map(
                                (p) => html`
                                  <button
                                    style="border: none; cursor: pointer; border-radius: 6px; padding: 2px 6px; font-size: 11px; background: ${ambVal === p.lvl ? "var(--sol-cyan-tint)" : "var(--sol-control)"}; color: ${ambVal === p.lvl ? "var(--sol-cyan)" : "var(--sol-text-3)"};"
                                    @click=${() =>
                                      this.pushRoom(room.subentry_id, "ambience_level", p.lvl, true)}
                                  >
                                    ${p.label}
                                  </button>
                                `
                              )}
                            </div>
                          </div>
                          <span class="readout tab-num">
                            ${ambVal === 0 ? "Follows house" : `${lightPct(ambVal, gamma)}% (${ambVal} lvl)`}
                          </span>
                        </div>

                        <!-- Occupied Min & Max -->
                        <div class="bias-row">
                          <span class="lab">
                            Occupied min <sol-help .text=${HELP.occupiedMin}></sol-help>
                          </span>
                          <div style="flex: 1; display: flex; align-items: center; gap: 8px;">
                            <sol-slider
                              tone="amber"
                              noReset
                              .value=${occMinVal}
                              .min=${0}
                              .max=${254}
                              .step=${1}
                              @value-changed=${(e: CustomEvent) =>
                                this.pushRoom(
                                  room.subentry_id,
                                  "occupied_min",
                                  Math.round(e.detail.value),
                                  e.detail.final
                                )}
                            ></sol-slider>
                          </div>
                          <span class="readout tab-num">
                            ${occMinVal === 0 ? "Follows curve" : `${occMinVal} lvl`}
                          </span>
                        </div>

                        <div class="bias-row">
                          <span class="lab">
                            Occupied max <sol-help .text=${HELP.occupiedMax}></sol-help>
                          </span>
                          <div style="flex: 1; display: flex; align-items: center; gap: 8px;">
                            <sol-slider
                              tone="amber"
                              noReset
                              .value=${occMaxVal}
                              .min=${0}
                              .max=${254}
                              .step=${1}
                              @value-changed=${(e: CustomEvent) =>
                                this.pushRoom(
                                  room.subentry_id,
                                  "occupied_max",
                                  Math.round(e.detail.value),
                                  e.detail.final
                                )}
                            ></sol-slider>
                          </div>
                          <span class="readout tab-num">${occMaxVal} lvl</span>
                        </div>
                      `}

                  ${room.zones && room.zones.length > 1
                    ? html`<div class="bias-row">
                        <span class="lab">
                          Zone bias <sol-help .text=${HELP.zoneBias}></sol-help>
                        </span>
                        <sol-slider
                          .value=${zone}
                          .min=${-1}
                          .max=${1}
                          .step=${0.1}
                          @value-changed=${(e: CustomEvent) =>
                            this.pushRoom(
                              room.subentry_id,
                              "zone_bias_stops",
                              e.detail.value,
                              e.detail.final
                            )}
                        ></sol-slider>
                        <span class="readout tab-num">${stopLabel(zone)}</span>
                      </div>`
                    : nothing}

                  ${room.has_near && !room.zones.some((z) => z.presence.length)
                    ? html`<div class="bias-row">
                        <span class="lab">
                          Diminish <sol-help .text=${HELP.diminish}></sol-help>
                        </span>
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

                  <div class="lights">
                    <div class="lhead">
                      <span class="eyebrow">Fixture</span>
                      <span class="eyebrow">
                        Bias <sol-help .text=${HELP.perLight}></sol-help>
                      </span>
                      <span class="eyebrow">
                        Cut <sol-help flip .text=${HELP.cut}></sol-help>
                      </span>
                      <span class="eyebrow">
                        Max <sol-help flip .text=${HELP.max}></sol-help>
                      </span>
                    </div>
                    ${this.renderGrouped(room)}
                  </div>

                  ${!isStairway
                    ? html`<div class="footer">
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
                      </div>`
                    : nothing}
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  render() {
    const ordered = this.orderedRooms();
    const ids = ordered.map((r) => r.subentry_id);
    return html`
      ${this.renderStrip()} ${this.renderHouseBias()}
      <div class="grid">${ordered.map((r, i) => this.renderRoom(r, i, ids))}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-tab-lighting": SolTabLighting;
  }
}
