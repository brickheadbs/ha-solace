/**
 * Fritsch-Carlson Monotone Cubic Spline Interpolation for interactive canvas and SVG curves.
 * Guarantees zero overshoot or unprompted dipping between points.
 */

export interface Point {
  x: number;
  y: number;
}

export class MonotoneSpline {
  private xs: number[] = [];
  private ys: number[] = [];
  private ms: number[] = [];
  private hs: number[] = [];
  private periodic: boolean;

  constructor(points: Point[], periodic = false) {
    this.periodic = periodic;
    this.build(points);
  }

  private build(rawPoints: Point[]): void {
    if (!rawPoints.length) return;
    const sorted = [...rawPoints].sort((a, b) => a.x - b.x);
    // Remove duplicate consecutive x
    const clean: Point[] = [];
    for (const p of sorted) {
      if (clean.length && Math.abs(clean[clean.length - 1].x - p.x) < 1e-6) {
        continue;
      }
      clean.push(p);
    }

    if (clean.length === 1) {
      this.xs = [clean[0].x];
      this.ys = [clean[0].y];
      this.ms = [0];
      this.hs = [1];
      return;
    }

    let pts = clean;
    if (this.periodic && clean.length >= 2) {
      const prev = clean.map((p) => ({ x: p.x - 24.0, y: p.y }));
      const next = clean.map((p) => ({ x: p.x + 24.0, y: p.y }));
      pts = [...prev, ...clean, ...next];
    }

    const n = pts.length;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const hs: number[] = [];
    const deltas: number[] = [];

    for (let i = 0; i < n - 1; i++) {
      const h = Math.max(1e-6, xs[i + 1] - xs[i]);
      hs.push(h);
      deltas.push((ys[i + 1] - ys[i]) / h);
    }

    const ms: number[] = new Array(n).fill(0);
    ms[0] = deltas[0];
    ms[n - 1] = deltas[n - 2];

    for (let i = 1; i < n - 1; i++) {
      if (deltas[i - 1] * deltas[i] <= 0) {
        ms[i] = 0;
      } else {
        ms[i] = (deltas[i - 1] + deltas[i]) / 2;
      }
    }

    for (let i = 0; i < n - 1; i++) {
      const d = deltas[i];
      if (Math.abs(d) < 1e-9) {
        ms[i] = 0;
        ms[i + 1] = 0;
        continue;
      }
      const alpha = ms[i] / d;
      const beta = ms[i + 1] / d;
      const s = alpha * alpha + beta * beta;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        ms[i] = tau * alpha * d;
        ms[i + 1] = tau * beta * d;
      }
    }

    this.xs = xs;
    this.ys = ys;
    this.ms = ms;
    this.hs = hs;
  }

  public evaluate(xVal: number): number {
    if (!this.xs.length) return 0;
    if (this.xs.length === 1) return this.ys[0];

    let x = xVal;
    if (this.periodic) {
      x = ((x % 24.0) + 24.0) % 24.0;
    }

    if (x <= this.xs[0]) {
      return this.ys[0];
    }
    if (x >= this.xs[this.xs.length - 1]) {
      return this.ys[this.ys.length - 1];
    }

    let i = 0;
    while (i < this.xs.length - 2 && x > this.xs[i + 1]) {
      i++;
    }

    const h = this.hs[i];
    const t = (x - this.xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;

    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    return h00 * this.ys[i] + h10 * h * this.ms[i] + h01 * this.ys[i + 1] + h11 * h * this.ms[i + 1];
  }
}

/**
 * Bounded cubic Hermite spline for DISPLAY ONLY.
 *
 * MonotoneSpline deliberately clamps the tangent to zero at any local
 * extremum (see the `deltas[i-1] * deltas[i] <= 0` branch above) to
 * guarantee the interpolated curve never dips or overshoots past a
 * control point's own value. That guarantee matters for evaluation, but
 * away from a true extremum it also flattens transitions more than a
 * rendered line needs to.
 *
 * IMPORTANT — a first version of this class used a plain unclamped
 * three-point (Catmull-Rom) tangent at every node, including extrema.
 * That overshot past the node range: for DEF_BRIGHT's 9.5h peak
 * (level 254, already the max of all control points AND the hardware
 * ceiling), any nonzero tangent there pushes the curve above 254 on one
 * side of the node — provably, not just empirically (see the `s > 9`
 * comment below). tab-curves.ts was clamping the drawn pixel into the
 * plot box afterwards, which turned that overshoot into a hard flat clip
 * pinned to the axis edge — the same defect this class exists to remove,
 * in a worse (and physically false — "brightness 260") form.
 *
 * This version fixes that: at a genuine local extremum the tangent is
 * still forced to exactly zero (mathematically the only overshoot-free
 * choice there — see below), but everywhere else it starts from a wider
 * three-point chord (instead of MonotoneSpline's plain average of the
 * two adjacent secants, which ignores how uneven the node spacing is)
 * and then gets the same Fritsch-Carlson magnitude rescale MonotoneSpline
 * applies, so no segment anywhere can swing past either of its own
 * endpoints. Net effect: transitions between extrema round a little more
 * naturally; a node that is a strict local max/min of the whole curve
 * still renders as flat right at that node, because it mathematically
 * must (see WHY below) — that is not a bug in this class, it is a
 * property of the data. If a flat peak/trough is undesirable, the fix is
 * moving that control point's y off the axis ceiling/floor, not tuning
 * this interpolant further.
 *
 * WHY the extremum tangent cannot be softened without overshooting:
 * take a peak node i with y[i-1] < y[i] > y[i+1]. If the tangent at node
 * i is positive, then immediately to the right of node i (heading into
 * the descending segment) the curve is still increasing — so it rises
 * above y[i] before turning down, exceeding the peak's own value. If the
 * tangent is negative instead, the ascending segment on the left
 * approaches node i from above y[i] for the same reason, again
 * exceeding it. Zero is the only value with no overshoot on either
 * side — this is exactly Fritsch-Carlson's rule, not an arbitrary
 * simplification, and it holds regardless of how the tangent is derived.
 *
 * Do not use this class anywhere the actual demand/brightness/colour
 * value is computed for the backend; use MonotoneSpline for that.
 */
export class DisplaySpline {
  private xs: number[] = [];
  private ys: number[] = [];
  private ms: number[] = [];
  private hs: number[] = [];
  private periodic: boolean;

  constructor(points: Point[], periodic = false) {
    this.periodic = periodic;
    this.build(points);
  }

  private build(rawPoints: Point[]): void {
    if (!rawPoints.length) return;
    const sorted = [...rawPoints].sort((a, b) => a.x - b.x);
    const clean: Point[] = [];
    for (const p of sorted) {
      if (clean.length && Math.abs(clean[clean.length - 1].x - p.x) < 1e-6) {
        continue;
      }
      clean.push(p);
    }

    if (clean.length === 1) {
      this.xs = [clean[0].x];
      this.ys = [clean[0].y];
      this.ms = [0];
      this.hs = [1];
      return;
    }

    let pts = clean;
    if (this.periodic && clean.length >= 2) {
      const prev = clean.map((p) => ({ x: p.x - 24.0, y: p.y }));
      const next = clean.map((p) => ({ x: p.x + 24.0, y: p.y }));
      pts = [...prev, ...clean, ...next];
    }

    const n = pts.length;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const hs: number[] = [];
    const deltas: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const h = Math.max(1e-6, xs[i + 1] - xs[i]);
      hs.push(h);
      deltas.push((ys[i + 1] - ys[i]) / h);
    }

    const ms: number[] = new Array(n).fill(0);
    ms[0] = deltas[0];
    ms[n - 1] = deltas[n - 2];

    for (let i = 1; i < n - 1; i++) {
      if (deltas[i - 1] * deltas[i] <= 0) {
        // Genuine local extremum (or a flat run): forced to zero, see
        // the class doc for why no nonzero value avoids overshoot here.
        ms[i] = 0;
      } else {
        // Locally monotonic: a three-point chord through the actual
        // neighbour x-positions, which — unlike MonotoneSpline's plain
        // average of the two adjacent secant slopes — is a distance-
        // weighted blend of them, so lopsided node spacing does not
        // produce a lopsided-looking tangent. This is a weighted average
        // of deltas[i-1] and deltas[i], so it is automatically the same
        // sign as both (they already agree in sign here).
        ms[i] = (ys[i + 1] - ys[i - 1]) / (xs[i + 1] - xs[i - 1]);
      }
    }

    // Fritsch-Carlson magnitude guard: even with matching sign, a
    // three-point tangent can be larger than one of its two adjoining
    // segments can absorb without overshooting past the far endpoint.
    // Rescale ms[i]/ms[i+1] down together so neither segment can swing
    // past either of its own two control points — identical guarantee to
    // MonotoneSpline, just applied on top of the smoother starting
    // tangents above instead of the averaged ones.
    for (let i = 0; i < n - 1; i++) {
      const d = deltas[i];
      if (Math.abs(d) < 1e-9) {
        ms[i] = 0;
        ms[i + 1] = 0;
        continue;
      }
      const alpha = ms[i] / d;
      const beta = ms[i + 1] / d;
      const s = alpha * alpha + beta * beta;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        ms[i] = tau * alpha * d;
        ms[i + 1] = tau * beta * d;
      }
    }

    this.xs = xs;
    this.ys = ys;
    this.ms = ms;
    this.hs = hs;
  }

  public evaluate(xVal: number): number {
    if (!this.xs.length) return 0;
    if (this.xs.length === 1) return this.ys[0];

    let x = xVal;
    if (this.periodic) {
      x = ((x % 24.0) + 24.0) % 24.0;
    }

    if (x <= this.xs[0]) {
      return this.ys[0];
    }
    if (x >= this.xs[this.xs.length - 1]) {
      return this.ys[this.ys.length - 1];
    }

    let i = 0;
    while (i < this.xs.length - 2 && x > this.xs[i + 1]) {
      i++;
    }

    const h = this.hs[i];
    const t = (x - this.xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;

    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    return h00 * this.ys[i] + h10 * h * this.ms[i] + h01 * this.ys[i + 1] + h11 * h * this.ms[i + 1];
  }
}
