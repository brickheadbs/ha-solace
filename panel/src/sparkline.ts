/**
 * Sparkline geometry for the Home tab cards.
 *
 * Three things here are deliberate, because getting any of them wrong is what makes a
 * sparkline look "off":
 *
 *   1. **Time is the x axis, not the array index.** The recorder stores changes, so a
 *      quiet night and a busy hour produce the same number of samples. Plotting by index
 *      squashes the night and stretches the hour. Everything is resampled onto an evenly
 *      spaced time grid first, holding the last known value forward — which is also what
 *      the sensor actually did between reports.
 *   2. **The curve is a Fritsch–Carlson monotone cubic**, emitted as béziers. A plain
 *      Catmull-Rom overshoots on spiky data, which on an area chart shows up as the fill
 *      bulging past the baseline or above the card. Monotone tangents cannot overshoot.
 *   3. **The band is a fixed pixel height, stretched horizontally only.** The old code
 *      scaled a 60px-tall viewBox to a 150px card with `preserveAspectRatio="none"`,
 *      which stretched the curve 2.5× vertically and made every card's noise look like
 *      a mountain range.
 */

export interface Sample {
  t: number;
  v: number;
}

export interface SparkOptions {
  /** viewBox width. Arbitrary — the band stretches horizontally to the card. */
  width?: number;
  /** viewBox height, in real pixels: the band renders at exactly this height. */
  height?: number;
  /** Vertical breathing room so the peak isn't clipped by the stroke. */
  pad?: number;
  /** Columns to resample into. More is smoother, and costs nothing at this size. */
  columns?: number;
  /**
   * Smallest y range to plot. A fridge that moved 0.2 °C all day should read as flat,
   * not as a mountain range; without a floor the y axis amplifies sensor quantisation.
   */
  minSpan?: number;
  /** Log scale for values that span decades (lux). Values ≤ 0 clamp to the floor. */
  scale?: "linear" | "log";
  /**
   * Linearly interpolate between reports instead of holding the last value.
   *
   * Step-hold is the honest choice for a discrete state, but every sensor plotted here
   * is a continuous physical quantity sampled irregularly — a tank that reads 41° then
   * 47° twelve minutes later passed through the values between. Holding draws that as a
   * staircase, which is the "stepping" these cards showed on hot water.
   */
  interpolate?: boolean;
  /**
   * Put the series *mean* at this fraction of the band height, measured from the floor.
   *
   * Without it the domain is min..max, so a series that spent the day near its own
   * minimum hugs the bottom of the band. Anchoring the mean lifts the whole curve to a
   * consistent height across cards, which is what makes a row of them read as a set.
   */
  anchorMean?: number;
  /** Window start/end in epoch ms. Defaults to the samples' own extent. */
  from?: number;
  to?: number;
}

export interface Spark {
  /** `d` for the stroked curve. */
  line: string;
  /** `d` for the filled area beneath it. */
  area: string;
  /** Extremes of the *raw* samples, with the moment each occurred. */
  min: number;
  max: number;
  minAt: number;
  maxAt: number;
  /** Latest sample, and where the "now" dot goes. */
  last: number;
  dotX: number;
  dotY: number;
  width: number;
  height: number;
}

const LOG_FLOOR = 0.1;

const round = (n: number) => Math.round(n * 100) / 100;

/** Fritsch–Carlson tangents: the slopes that make a cubic spline monotone. */
function monotoneTangents(ys: number[], h: number): number[] {
  const n = ys.length;
  const m = new Array<number>(n).fill(0);
  if (n < 2) return m;

  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / h);

  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  }

  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * b * d[i];
    }
  }
  return m;
}

/**
 * Build a sparkline from timestamped samples, or `null` when there is nothing to draw.
 *
 * A single sample is not enough for a curve — the caller should fall back to hiding the
 * band rather than drawing a straight line that implies a day of flat data it never saw.
 */
export function buildSpark(samples: Sample[], opts: SparkOptions = {}): Spark | null {
  const width = opts.width ?? 300;
  const height = opts.height ?? 64;
  const pad = opts.pad ?? 5;
  const columns = Math.max(8, opts.columns ?? 72);
  const minSpan = opts.minSpan ?? 0;
  const logScale = opts.scale === "log";

  const clean = samples.filter((s) => Number.isFinite(s.v) && Number.isFinite(s.t));
  if (clean.length < 2) return null;

  const from = opts.from ?? clean[0].t;
  const to = opts.to ?? clean[clean.length - 1].t;
  if (!(to > from)) return null;

  // --- resample onto an even time grid ----------------------------------------------
  const interpolate = opts.interpolate ?? true;
  const grid = new Array<number>(columns);
  let cursor = 0;
  for (let i = 0; i < columns; i++) {
    const t = from + ((to - from) * i) / (columns - 1);
    while (cursor < clean.length && clean[cursor].t <= t) cursor++;
    const prev = clean[Math.max(0, cursor - 1)];
    const next = clean[cursor];
    if (!next || next === prev) {
      grid[i] = prev.v;
    } else if (!interpolate) {
      grid[i] = prev.v;
    } else {
      const span = next.t - prev.t;
      const f = span > 0 ? Math.min(1, Math.max(0, (t - prev.t) / span)) : 0;
      grid[i] = prev.v + (next.v - prev.v) * f;
    }
  }

  // --- extremes come from the raw samples, so the label matches what happened -------
  let min = Infinity;
  let max = -Infinity;
  let minAt = clean[0].t;
  let maxAt = clean[0].t;
  for (const s of clean) {
    if (s.t < from || s.t > to) continue;
    if (s.v < min) {
      min = s.v;
      minAt = s.t;
    }
    if (s.v > max) {
      max = s.v;
      maxAt = s.t;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;

  // --- y domain ---------------------------------------------------------------------
  const project = (v: number) => (logScale ? Math.log10(Math.max(LOG_FLOOR, v)) : v);
  const pMin = project(min);
  const pMax = project(max);
  const floor = logScale ? 0.3 : minSpan;

  let lo: number;
  let hi: number;

  const anchor = opts.anchorMean;
  if (anchor !== undefined && anchor > 0.02 && anchor < 0.98) {
    // Widen the domain just enough that the mean lands on the anchor with every sample
    // still inside the band. Solving both bounds for the range and taking the larger is
    // what keeps the anchor exact without ever clipping the extremes.
    const pMean = grid.reduce((a, v) => a + project(v), 0) / grid.length;
    const need = Math.max(
      (pMean - pMin) / anchor,
      (pMax - pMean) / (1 - anchor),
      floor
    );
    lo = pMean - anchor * need;
    hi = lo + need;
  } else {
    lo = pMin;
    hi = pMax;
    if (hi - lo < floor) {
      const mid = (hi + lo) / 2;
      lo = mid - floor / 2;
      hi = mid + floor / 2;
    }
  }
  const range = hi - lo || 1;

  const usable = height - pad * 2;
  const ys = grid.map((v) => height - pad - ((project(v) - lo) / range) * usable);
  const xs = grid.map((_, i) => (width * i) / (columns - 1));

  // --- monotone cubic → bézier --------------------------------------------------------
  const h = xs[1] - xs[0];
  const m = monotoneTangents(ys, h);
  let line = `M${round(xs[0])},${round(ys[0])}`;
  for (let i = 0; i < columns - 1; i++) {
    const c1x = xs[i] + h / 3;
    const c1y = ys[i] + (m[i] * h) / 3;
    const c2x = xs[i + 1] - h / 3;
    const c2y = ys[i + 1] - (m[i + 1] * h) / 3;
    line += `C${round(c1x)},${round(c1y)} ${round(c2x)},${round(c2y)} ${round(xs[i + 1])},${round(ys[i + 1])}`;
  }

  const area = `${line}L${round(width)},${height}L0,${height}Z`;

  return {
    line,
    area,
    min,
    max,
    minAt,
    maxAt,
    last: grid[columns - 1],
    dotX: xs[columns - 1],
    dotY: ys[columns - 1],
    width,
    height,
  };
}

/** `14:07` in the browser's locale, for the high/low captions. */
export function clockAt(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
