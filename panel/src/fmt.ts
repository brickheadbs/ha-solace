/**
 * Display helpers.
 *
 * The one rule worth stating: **stops are the engine unit, percent is a display unit.**
 * A stop is a doubling of light, which is what makes biases additive; percent is
 * intuitive but ill-defined ("+50 % of what?"). So a stop number is never rendered
 * alone — `consequence()` is what goes beside every bias control.
 */

/** "+1", "−0.25", "0" — a real minus sign, not a hyphen. */
export const stops = (v: number): string => {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  const a = Math.abs(v);
  return sign + (a % 1 === 0 ? a.toFixed(0) : String(parseFloat(a.toFixed(2))));
};

export const stopLabel = (v: number): string =>
  v === 0 ? "0 stops" : `${stops(v)} ${Math.abs(v) === 1 ? "stop" : "stops"}`;

/**
 * Perceived light for a command level, as a percentage.
 *
 * Gamma is a *display* correction only — it is deliberately out of the command path —
 * and it is a house setting, so it is passed in rather than baked in here.
 */
export const lightPct = (level: number, gamma: number): number =>
  Math.round(100 * Math.pow(Math.max(0, Math.min(254, level)) / 254, gamma));

/** "→ level 102 (18 % light)" — the consequence that must sit beside every bias. */
export const consequence = (level: number | null, gamma: number): string =>
  level === null ? "—" : `→ level ${level} (${lightPct(level, gamma)} % light)`;

export const clock = (hour: number | null | undefined): string => {
  if (hour === null || hour === undefined || !isFinite(hour)) return "—";
  let m = Math.round(hour * 60) % 1440;
  if (m < 0) m += 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** "22:30" back to 22.5 — the inverse of `clock`, for <input type="time">. */
export const parseClock = (value: string): number => {
  const [h, m] = value.split(":");
  return (parseInt(h, 10) || 0) + (parseInt(m, 10) || 0) / 60;
};

export const num = (v: number, digits = 0): string =>
  v.toLocaleString("en-GB", { maximumFractionDigits: digits });

/** "4 m 12 s" — the manual countdown. */
export const countdown = (seconds: number | null): string => {
  if (seconds === null) return "—";
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const ago = (iso: string | null): string => {
  if (!iso) return "never";
  const delta = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(delta) || delta < 0) return "just now";
  if (delta < 60) return `${Math.round(delta)}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  return `${Math.round(delta / 3600)}h ago`;
};

/** Outdoor lux — `inf` is the "sensor never reported" fail-safe, not a real reading. */
export const lux = (value: number): string =>
  !isFinite(value) ? "no reading" : `${num(value, value < 10 ? 1 : 0)} lx`;
