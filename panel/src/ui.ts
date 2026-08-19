/**
 * The control surface primitives.
 *
 * These are hand-built rather than reused from HA's frontend for one reason: the
 * handoff specifies behaviour HA's own controls do not have — a centre tick at zero, a
 * reset glyph that appears only when a value is off-neutral, an amber gradient track
 * reserved for light output, and a live consequence string that recomputes on `input`
 * as well as `change`. Wrapping `ha-control-slider` to get those would be more code
 * than a styled `<input type="range">`, and `ha-*` elements are lazily registered in
 * the host bundle, so a panel that leans on them can render as blank boxes.
 *
 * `ha-icon` is the one exception — it is always registered, and re-implementing MDI
 * would be absurd.
 */

import { LitElement, css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { customElement } from "./custom-element";
import { tokens } from "./tokens";

/* ------------------------------------------------------------------ help bubble */

/**
 * The `info` glyph. Opens on hover **and** focus — the handoff is explicit about
 * keyboard parity, and a hover-only tooltip is unreachable without a mouse.
 */
@customElement("sol-help")
export class SolHelp extends LitElement {
  @property() text = "";
  /** Right-anchor near a card edge so the bubble does not run off-screen. */
  @property({ type: Boolean }) flip = false;

  static styles = [
    tokens,
    css`
      :host {
        display: inline-flex;
        position: relative;
      }
      button {
        all: unset;
        cursor: help;
        display: inline-flex;
        border-radius: 50%;
        color: var(--sol-text-4);
      }
      ha-icon {
        --mdc-icon-size: 14px;
      }
      .bubble {
        position: absolute;
        bottom: calc(100% + 9px);
        left: 0;
        width: max-content;
        max-width: 272px;
        min-width: 240px;
        background: #33363a;
        color: #dfe3e6;
        border-radius: var(--sol-r-block);
        padding: 9px 11px;
        font-size: 11.5px;
        line-height: 1.5;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.55);
        opacity: 0;
        transition: opacity 0.12s ease;
        /* Never intercept the pointer — the bubble sits over controls. */
        pointer-events: none;
        z-index: 20;
      }
      :host([flip]) .bubble {
        left: auto;
        right: 0;
      }
      button:hover + .bubble,
      button:focus-visible + .bubble,
      :host(:focus-within) .bubble {
        opacity: 1;
      }
    `,
  ];

  render() {
    if (!this.text) return nothing;
    return html`
      <button tabindex="0" aria-label=${this.text}>
        <ha-icon icon="mdi:information-outline"></ha-icon>
      </button>
      <div class="bubble" role="tooltip">${this.text}</div>
    `;
  }
}

/* ------------------------------------------------------------------ slider */

export type SliderTone = "cyan" | "amber";

/**
 * A range input with the handoff's three extras: a centre tick when the range straddles
 * zero, a reset glyph that appears only off-neutral, and live `input` events so every
 * dependent readout moves while dragging.
 *
 * Values commit continuously — there is no save button and no confirmation toast, which
 * is the whole interaction model. The *engine* absorbs the cost of that: the coordinator
 * coalesces a drag into one write per 0.3 s and uses the 0.5 s tuning transition.
 */
@customElement("sol-slider")
export class SolSlider extends LitElement {
  @property({ type: Number }) value = 0;
  @property({ type: Number }) min = -2;
  @property({ type: Number }) max = 2;
  @property({ type: Number }) step = 0.25;
  /** The value the reset glyph returns to, and the point the centre tick marks. */
  @property({ type: Number }) neutral = 0;
  @property({ type: Boolean }) small = false;
  @property() tone: SliderTone = "cyan";
  @property({ type: Boolean }) noReset = false;

  static styles = [
    tokens,
    css`
      :host {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
        min-width: 0;
      }
      .wrap {
        position: relative;
        flex: 1;
        display: flex;
        align-items: center;
        min-width: 0;
      }
      input {
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        background: transparent;
        margin: 0;
        height: 20px;
        cursor: pointer;
      }
      input::-webkit-slider-runnable-track {
        height: 4px;
        border-radius: 2px;
        background: var(--sol-track);
      }
      input::-moz-range-track {
        height: 4px;
        border-radius: 2px;
        background: var(--sol-track);
      }
      :host([small]) input::-webkit-slider-runnable-track {
        height: 3px;
        background: var(--sol-track-sm);
      }
      :host([small]) input::-moz-range-track {
        height: 3px;
        background: var(--sol-track-sm);
      }
      /* Amber is reserved for light output — it is the level slider's track, and it is
         never used to make an ordinary control look lively. */
      :host([tone="amber"]) input::-webkit-slider-runnable-track {
        background: linear-gradient(90deg, #5b4a26, var(--sol-amber));
      }
      :host([tone="amber"]) input::-moz-range-track {
        background: linear-gradient(90deg, #5b4a26, var(--sol-amber));
      }
      input::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 14px;
        height: 14px;
        margin-top: -5px;
        border-radius: 50%;
        background: var(--sol-cyan);
        border: none;
      }
      input::-moz-range-thumb {
        width: 14px;
        height: 14px;
        border: none;
        border-radius: 50%;
        background: var(--sol-cyan);
      }
      :host([tone="amber"]) input::-webkit-slider-thumb {
        background: var(--sol-amber);
      }
      :host([tone="amber"]) input::-moz-range-thumb {
        background: var(--sol-amber);
      }
      :host([small]) input::-webkit-slider-thumb {
        width: 11px;
        height: 11px;
        margin-top: -4px;
      }
      :host([small]) input::-moz-range-thumb {
        width: 11px;
        height: 11px;
      }
      input:focus-visible::-webkit-slider-thumb {
        box-shadow: 0 0 0 6px rgba(79, 195, 247, 0.25);
      }
      input:focus-visible::-moz-range-thumb {
        box-shadow: 0 0 0 6px rgba(79, 195, 247, 0.25);
      }
      .tick {
        position: absolute;
        top: 4px;
        bottom: 4px;
        width: 1px;
        background: rgba(255, 255, 255, 0.22);
        pointer-events: none;
      }
      button.reset {
        all: unset;
        cursor: pointer;
        display: inline-flex;
        color: var(--sol-text-4);
        border-radius: var(--sol-r-control);
      }
      button.reset:hover {
        color: var(--sol-text-2);
      }
      button.reset ha-icon {
        --mdc-icon-size: 15px;
      }
      .spacer {
        width: 15px;
        flex: 0 0 15px;
      }
    `,
  ];

  private _emit(value: number, final: boolean) {
    this.value = value;
    this.dispatchEvent(
      new CustomEvent("value-changed", { detail: { value, final }, bubbles: true, composed: true })
    );
  }

  render() {
    const straddles = this.min < this.neutral && this.max > this.neutral;
    const pct = ((this.neutral - this.min) / (this.max - this.min)) * 100;
    const moved = this.value !== this.neutral;
    return html`
      <div class="wrap">
        <input
          type="range"
          .min=${String(this.min)}
          .max=${String(this.max)}
          .step=${String(this.step)}
          .value=${String(this.value)}
          @input=${(e: Event) =>
            this._emit(parseFloat((e.target as HTMLInputElement).value), false)}
          @change=${(e: Event) =>
            this._emit(parseFloat((e.target as HTMLInputElement).value), true)}
        />
        ${straddles ? html`<div class="tick" style="left:${pct}%"></div>` : nothing}
      </div>
      ${this.noReset
        ? nothing
        : moved
          ? html`<button
              class="reset"
              title="Reset"
              @click=${() => this._emit(this.neutral, true)}
            >
              <ha-icon icon="mdi:backup-restore"></ha-icon>
            </button>`
          : html`<span class="spacer"></span>`}
    `;
  }
}

/* ------------------------------------------------------------------ number box */

/**
 * A compact number input. `null` renders an em-dash placeholder and a dim border — the
 * handoff's "unset" state, which is genuinely different from a set 0. Per-light clamps
 * need that distinction: an unset min is no floor, a set min of 0 is also no floor, but
 * the user's intent differs and only one of them should show as configured.
 */
@customElement("sol-number")
export class SolNumber extends LitElement {
  @property({ type: Number }) value: number | null = null;
  @property({ type: Number }) min: number | null = null;
  @property({ type: Number }) max: number | null = null;
  @property({ type: Number }) step = 1;
  @property() suffix = "";
  @property({ type: Boolean }) clearable = false;
  @property({ type: Number }) width = 60;

  static styles = [
    tokens,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      input {
        font: inherit;
        font-size: 12.5px;
        font-variant-numeric: tabular-nums;
        color: var(--sol-text);
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: var(--sol-r-control);
        padding: 6px 7px;
        box-sizing: border-box;
        text-align: right;
      }
      input.set {
        background: var(--sol-control);
        border-color: rgba(79, 195, 247, 0.35);
      }
      input::placeholder {
        color: var(--sol-faint);
      }
      /* The spinners are noise at this density and steal the width. */
      input::-webkit-outer-spin-button,
      input::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      input[type="number"] {
        -moz-appearance: textfield;
      }
      .suffix {
        font-size: 11px;
        color: var(--sol-text-4);
      }
    `,
  ];

  private _commit(raw: string) {
    const value = raw.trim() === "" ? null : parseFloat(raw);
    if (value !== null && !isFinite(value)) return;
    this.dispatchEvent(
      new CustomEvent("value-changed", {
        detail: { value: value === null && !this.clearable ? this.min ?? 0 : value },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    return html`
      <input
        type="number"
        class=${this.value !== null ? "set" : ""}
        style="width:${this.width}px"
        placeholder="—"
        .value=${this.value === null ? "" : String(this.value)}
        .min=${this.min === null ? "" : String(this.min)}
        .max=${this.max === null ? "" : String(this.max)}
        .step=${String(this.step)}
        @change=${(e: Event) => this._commit((e.target as HTMLInputElement).value)}
      />
      ${this.suffix ? html`<span class="suffix">${this.suffix}</span>` : nothing}
    `;
  }
}

/* ------------------------------------------------------------------ segmented */

export interface SegmentOption {
  value: string;
  label: string;
  /** Amber for Manual — it is a light-output state, which is what amber means here. */
  tone?: SliderTone;
}

/** One pattern, two uses: Auto/Manual on a room card and Day/Hour on the colour chart. */
@customElement("sol-segmented")
export class SolSegmented extends LitElement {
  @property({ attribute: false }) options: SegmentOption[] = [];
  @property() value = "";

  static styles = [
    tokens,
    css`
      .track {
        display: inline-flex;
        background: var(--sol-control);
        border-radius: var(--sol-r-pill);
        padding: 2px;
      }
      button {
        all: unset;
        cursor: pointer;
        font-size: 11.5px;
        font-weight: 500;
        padding: 5px 12px;
        border-radius: 12px;
        color: var(--sol-text-3);
        text-align: center;
      }
      button.on {
        background: var(--sol-cyan-track);
        color: var(--sol-cyan);
      }
      button.on.amber {
        background: var(--sol-amber-track);
        color: var(--sol-amber);
      }
    `,
  ];

  render() {
    return html`<div class="track">
      ${this.options.map(
        (o) => html`<button
          class="${o.value === this.value ? "on" : ""} ${o.tone === "amber" ? "amber" : ""}"
          aria-pressed=${o.value === this.value}
          @click=${() =>
            this.dispatchEvent(
              new CustomEvent("segment-changed", {
                detail: { value: o.value },
                bubbles: true,
                composed: true,
              })
            )}
        >
          ${o.label}
        </button>`
      )}
    </div>`;
  }
}

/* ------------------------------------------------------------------ setting row */

/**
 * The Lighting/Colour tab row: a fixed label column, a flexible slider, a fixed
 * right-aligned value. Fixed columns are what make a stack of unrelated settings scan
 * as a table rather than a ragged list.
 */
@customElement("sol-row")
export class SolRow extends LitElement {
  @property() label = "";
  @property() help = "";

  static styles = [
    tokens,
    css`
      :host {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 9px 0;
      }
      .label {
        flex: 0 0 176px;
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12.5px;
        color: var(--sol-text-2);
      }
      .control {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .value {
        flex: 0 0 88px;
        text-align: right;
        font-size: 12.5px;
        font-variant-numeric: tabular-nums;
        color: var(--sol-text);
      }
      @media (max-width: 560px) {
        :host {
          flex-wrap: wrap;
        }
        .label {
          flex-basis: 100%;
        }
      }
    `,
  ];

  render() {
    return html`
      <div class="label">
        <span>${this.label}</span>
        ${this.help ? html`<sol-help .text=${this.help}></sol-help>` : nothing}
      </div>
      <div class="control"><slot></slot></div>
      <div class="value"><slot name="value"></slot></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-help": SolHelp;
    "sol-slider": SolSlider;
    "sol-number": SolNumber;
    "sol-segmented": SolSegmented;
    "sol-row": SolRow;
  }
}
