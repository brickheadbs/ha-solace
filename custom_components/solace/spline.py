"""Monotone cubic spline interpolation (Fritsch-Carlson algorithm).

PURE MODULE — no Home Assistant imports.

Provides mathematically smooth, continuous curves through arbitrary user-defined
(x, y) control points with guaranteed monotonicity (zero spurious overshoots, oscillations,
or negative spikes between nodes).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence


@dataclass(frozen=True, slots=True)
class SplinePoint:
    """A single 2D control point (node) on a spline curve."""

    x: float
    y: float


class MonotoneCubicSpline:
    """Evaluates a smooth curve through control points using Fritsch-Butland / Brodlie interpolation."""

    def __init__(
        self,
        points: Sequence[SplinePoint | tuple[float, float]],
        periodic: bool = False,
        log_x: bool = False,
    ) -> None:
        self._log_x = log_x
        raw_pts = [
            (float(p.x), float(p.y))
            if hasattr(p, "x") and hasattr(p, "y")
            else (float(p[0]), float(p[1]))
            for p in points
        ]
        if log_x:
            raw_pts = [(math.log10(1.0 + max(0.0, px)), py) for px, py in raw_pts]
        # Sort by x coordinate and deduplicate identical x values
        sorted_pts = sorted(raw_pts, key=lambda pt: pt[0])
        deduped: list[tuple[float, float]] = []
        for x, y in sorted_pts:
            if not deduped or x > deduped[-1][0] + 1e-7:
                deduped.append((x, y))
            else:
                # Overwrite duplicate x with the newest y
                deduped[-1] = (x, y)

        if periodic and len(deduped) >= 2:
            prev_pts = [(x - 24.0, y) for x, y in deduped]
            next_pts = [(x + 24.0, y) for x, y in deduped]
            deduped = prev_pts + deduped + next_pts

        self._pts = deduped
        self._n = len(self._pts)
        self._periodic = periodic

        if self._n < 2:
            self._m: list[float] = [0.0] * self._n
            return

        x = [p[0] for p in self._pts]
        y = [p[1] for p in self._pts]

        # 1. Secant slopes (deltas)
        dx = [x[k + 1] - x[k] for k in range(self._n - 1)]
        dy = [y[k + 1] - y[k] for k in range(self._n - 1)]
        deltas = [dy[k] / dx[k] if dx[k] > 0 else 0.0 for k in range(self._n - 1)]

        # 2. Brodlie / Fritsch-Butland weighted harmonic mean tangents (smooth on uneven intervals)
        m = [0.0] * self._n
        m[0] = deltas[0]
        m[-1] = deltas[-1]
        for k in range(1, self._n - 1):
            d0 = deltas[k - 1]
            d1 = deltas[k]
            if d0 * d1 <= 0:
                m[k] = 0.0
            else:
                h0 = dx[k - 1]
                h1 = dx[k]
                w0 = 2.0 * h1 + h0
                w1 = h1 + 2.0 * h0
                m[k] = (w0 + w1) / (w0 / d0 + w1 / d1)

        # 3. Fritsch-Carlson monotonicity condition
        for k in range(self._n - 1):
            if abs(deltas[k]) < 1e-12:
                m[k] = 0.0
                m[k + 1] = 0.0
            else:
                alpha = m[k] / deltas[k]
                beta = m[k + 1] / deltas[k]
                if alpha < 0:
                    m[k] = 0.0
                if beta < 0:
                    m[k + 1] = 0.0
                if alpha * alpha + beta * beta > 9.0:
                    tau = 3.0 / (alpha * alpha + beta * beta) ** 0.5
                    m[k] = tau * alpha * deltas[k]
                    m[k + 1] = tau * beta * deltas[k]

        self._m = m

    def __call__(self, x_val: float) -> float:
        """Alias for evaluate."""
        return self.evaluate(x_val)

    def evaluate(self, x_val: float) -> float:
        """Evaluate the spline at query point x_val."""
        if self._n == 0:
            return 0.0
        if self._n == 1:
            return self._pts[0][1]

        if self._log_x:
            x_val = math.log10(1.0 + max(0.0, x_val))
        elif self._periodic:
            x_val = ((x_val % 24.0) + 24.0) % 24.0

        x = [p[0] for p in self._pts]
        y = [p[1] for p in self._pts]

        # Extrapolation clamps to boundary values
        if x_val <= x[0]:
            return y[0]
        if x_val >= x[-1]:
            return y[-1]

        # Binary search for segment [k, k+1]
        low = 0
        high = self._n - 2
        k = 0
        while low <= high:
            mid = (low + high) // 2
            if x[mid] <= x_val <= x[mid + 1]:
                k = mid
                break
            if x_val < x[mid]:
                high = mid - 1
            else:
                low = mid + 1

        h = x[k + 1] - x[k]
        if h <= 0:
            return y[k]

        t = (x_val - x[k]) / h
        t2 = t * t
        t3 = t2 * t

        # Cubic Hermite basis functions
        h00 = 2 * t3 - 3 * t2 + 1
        h10 = t3 - 2 * t2 + t
        h01 = -2 * t3 + 3 * t2
        h11 = t3 - t2

        return h00 * y[k] + h10 * h * self._m[k] + h01 * y[k + 1] + h11 * h * self._m[k + 1]

    def evaluate_periodic_24h(self, hour: float) -> float:
        """Evaluate on a 24-hour periodic clock [0.0, 24.0)."""
        wrapped = hour % 24.0
        return self.evaluate(wrapped)
