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

    const n = clean.length;
    const xs = clean.map((p) => p.x);
    const ys = clean.map((p) => p.y);
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
