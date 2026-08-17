import { css } from "lit";

/**
 * The design system, one layer deep.
 *
 * The handoff specifies exact hex values but asks for them to be expressed through the
 * **host's** tokens so the panel follows the user's theme, with the literals kept as
 * fallbacks "so you can verify you have landed in the same place". That is what every
 * `var(--ha-…, #literal)` pair below is.
 *
 * Two rules from the handoff that are load-bearing rather than decorative:
 *   * **Amber means light output or a hardware clamp. Never decoration.**
 *   * **Cyan means interactive or selected.**
 * Both are mapped to HA's own semantic tokens (`--state-icon-active-color`,
 * `--primary-color`), so a theme that recolours them keeps the meaning.
 */
export const tokens = css`
  @import url("https://use.typekit.net/yte7tax.css");

  :host {
    --sol-font-body: "komet", "semplicitapro", var(--ha-font-family-body, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif);
    --sol-font-caps: "komet-sc", "komet", "semplicitapro", sans-serif;
    --sol-font-mono: var(--ha-font-family-code, "Roboto Mono", monospace);

    --sol-page: var(--primary-background-color, #111213);
    --sol-card: var(--ha-card-background, var(--card-background-color, #1c1c1d));
    --sol-block: var(--secondary-background-color, #232325);
    --sol-control: #242426;

    --sol-text: var(--primary-text-color, #e8eaed);
    --sol-text-2: #c8ccd0;
    --sol-text-3: var(--secondary-text-color, #9aa0a6);
    --sol-text-4: #6f7377;
    --sol-faint: #5c6063;

    --sol-cyan: var(--primary-color, #4fc3f7);
    --sol-cyan-tint: rgba(79, 195, 247, 0.14);
    --sol-cyan-track: #3b4a52;
    --sol-amber: var(--state-icon-active-color, #ffb74d);
    --sol-amber-light: #ffcc80;
    --sol-amber-surface: #2a2418;
    --sol-amber-track: #4a3f28;
    --sol-green: var(--success-color, #66bb6a);

    --sol-track: #3a3d40;
    --sol-track-sm: #35383b;
    --sol-hair: var(--divider-color, rgba(255, 255, 255, 0.08));
    --sol-hair-faint: rgba(255, 255, 255, 0.05);

    --sol-r-pill: 14px;
    --sol-r-card: 12px;
    --sol-r-block: 8px;
    --sol-r-control: 6px;
    --sol-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);

    --sol-series-ambience: #5c8dd6;
    --sol-series-start: var(--primary-color, #4fc3f7);
    --sol-series-sunset: #ffb74d;
    --sol-series-dusk: #7e57c2;
    --sol-series-full: #f06292;

    display: block;
    color: var(--sol-text);
    font-family: var(--sol-font-body);
  }

  /* Numeric readouts are tabular everywhere — a value that shifts width while a slider
     is dragged reads as flicker. */
  .tab-num {
    font-variant-numeric: tabular-nums;
  }

  .card {
    background: var(--sol-card);
    border-radius: var(--sol-r-card);
    box-shadow: var(--sol-shadow);
    padding: 15px 18px 16px;
  }

  .card-head {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 12px;
  }
  .card-head ha-icon {
    --mdc-icon-size: 19px;
    color: var(--sol-cyan);
  }
  .card-head h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 500;
  }

  .eyebrow {
    font-family: var(--sol-font-caps);
    font-size: 10.5px;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: var(--sol-text-4);
  }

  .caption {
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--sol-text-4);
  }

  /* Focus ring, everywhere, per the handoff. */
  :focus-visible {
    outline: 2px solid var(--sol-cyan);
    outline-offset: 2px;
  }
`;
