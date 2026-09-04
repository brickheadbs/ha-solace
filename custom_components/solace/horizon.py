"""Predictive horizon planning, watchdog extrapolation, and preview automaton.

PURE MODULE — no ``homeassistant`` imports, ever.

Implements:
- 300s linear hardware chord planning tracking 24h circadian splines.
- Cauchy error bound verification and adaptive 60s micro-chords on steep curves.
- 3-state watchdog supervisor (NORMAL_SYNC, WATCHDOG_PROJECTION, TIMEOUT_FAILSAFE).
- C0 zero-jump re-anchoring on delayed sensor recovery.
- 5-state interactive tuning preview automaton with 150ms wire throttle, trailing-edge flush,
  and bridge re-anchoring.
"""

from __future__ import annotations

from enum import Enum
import math
from typing import Sequence

from .spline import MonotoneCubicSpline

__all__ = [
    "PredictiveHorizonPlanner",
    "WatchdogState",
    "WatchdogSupervisor",
    "PreviewState",
    "InteractivePreviewAutomaton",
]


class PredictiveHorizonPlanner:
    """Plans continuous linear hardware chords across 300s synchronization intervals."""

    def __init__(self, spline: MonotoneCubicSpline, sync_period_s: float = 300.0) -> None:
        self.spline = spline
        self.sync_period_s = max(1.0, float(sync_period_s))
        self.dt_hours = self.sync_period_s / 3600.0

    def compute_chord(self, t0_hours: float) -> tuple[float, float, float, float]:
        """Returns (t0, t1, B0, B1)."""
        t1_hours = (t0_hours + self.dt_hours) % 24.0
        b0 = self.spline.evaluate_periodic_24h(t0_hours)
        b1 = self.spline.evaluate_periodic_24h(t1_hours)
        return t0_hours, t1_hours, b0, b1

    def max_chord_error(self, t0_hours: float, num_samples: int = 20) -> float:
        """Calculates maximum absolute deviation between linear chord and spline."""
        _, _, b0, b1 = self.compute_chord(t0_hours)
        max_err = 0.0
        for s in range(1, num_samples):
            fraction = s / float(num_samples)
            t_interp = t0_hours + fraction * self.dt_hours
            b_chord = b0 + fraction * (b1 - b0)
            b_spline = self.spline.evaluate_periodic_24h(t_interp)
            err = abs(b_chord - b_spline)
            if err > max_err:
                max_err = err
        return max_err

    def peak_slope(self, t0_hours: float, num_samples: int = 10) -> float:
        """Calculates peak instantaneous derivative |dB/dt| in levels/hour across interval."""
        max_d = 0.0
        delta = 0.0001
        for i in range(num_samples + 1):
            t = (t0_hours + i * (self.dt_hours / float(num_samples))) % 24.0
            t_plus = (t + delta) % 24.0
            t_minus = (t - delta) % 24.0
            b_plus = self.spline.evaluate_periodic_24h(t_plus)
            b_minus = self.spline.evaluate_periodic_24h(t_minus)
            d = abs(b_plus - b_minus) / (2.0 * delta)
            if d > max_d:
                max_d = d
        return max_d

    def compute_adaptive_chords(
        self, t0_hours: float
    ) -> list[tuple[float, float, float, float]]:
        """Returns a list of (t_start, t_end, b_start, b_end) chords across the 300s sync window.

        If local peak slope |dB/dt| > 85 levels/hour (transition width delta_T < 2.3h), dynamically
        subdivides the 300s window into five 60s micro-chords to maintain error < 0.20 levels.
        """
        b0 = self.spline.evaluate_periodic_24h(t0_hours)
        b1 = self.spline.evaluate_periodic_24h((t0_hours + self.dt_hours) % 24.0)

        if self.peak_slope(t0_hours) <= 85.0:
            return [(t0_hours, (t0_hours + self.dt_hours) % 24.0, b0, b1)]

        # Subdivide into 5 micro-chords of 60s each
        micro_dt_hours = 60.0 / 3600.0
        chords: list[tuple[float, float, float, float]] = []
        for m in range(5):
            t_m0 = (t0_hours + m * micro_dt_hours) % 24.0
            t_m1 = (t0_hours + (m + 1) * micro_dt_hours) % 24.0
            bm0 = self.spline.evaluate_periodic_24h(t_m0)
            bm1 = self.spline.evaluate_periodic_24h(t_m1)
            chords.append((t_m0, t_m1, bm0, bm1))
        return chords

    def max_adaptive_chord_error(self, t0_hours: float, num_samples: int = 20) -> float:
        """Calculates maximum absolute error across the 300s window using adaptive micro-chords."""
        chords = self.compute_adaptive_chords(t0_hours)
        max_err = 0.0
        for t_start, t_end, b_start, b_end in chords:
            dur_h = (t_end - t_start) if t_end >= t_start else (t_end + 24.0 - t_start)
            for s in range(1, num_samples):
                fraction = s / float(num_samples)
                t_interp = (t_start + fraction * dur_h) % 24.0
                b_chord = b_start + fraction * (b_end - b_start)
                b_spline = self.spline.evaluate_periodic_24h(t_interp)
                err = abs(b_chord - b_spline)
                if err > max_err:
                    max_err = err
        return max_err


class WatchdogState(str, Enum):
    NORMAL_SYNC = "normal_sync"
    WATCHDOG_PROJECTION = "watchdog_projection"
    TIMEOUT_FAILSAFE = "timeout_failsafe"


class WatchdogSupervisor:
    """Supervises periodic sensor reception and coordinates seamless C0 re-anchoring."""

    def __init__(
        self,
        nominal_sync_s: float = 300.0,
        timeout_s: float = 1800.0,
    ) -> None:
        self.nominal_sync_s = float(nominal_sync_s)
        self.timeout_s = float(timeout_s)
        self.last_sync_time: float = 0.0
        self.last_valid_demand: float = 0.0

    def evaluate_state(self, now: float) -> WatchdogState:
        elapsed = now - self.last_sync_time
        if elapsed <= self.nominal_sync_s:
            return WatchdogState.NORMAL_SYNC
        if elapsed <= self.timeout_s:
            return WatchdogState.WATCHDOG_PROJECTION
        return WatchdogState.TIMEOUT_FAILSAFE

    @staticmethod
    def calculate_in_flight_level(
        b_start: float,
        b_target: float,
        t_start: float,
        duration_s: float,
        now: float,
    ) -> float:
        """Calculates exact physical level of a bulb undergoing a linear transition."""
        if duration_s <= 0.0 or now >= t_start + duration_s:
            return b_target
        if now <= t_start:
            return b_start
        fraction = (now - t_start) / duration_s
        return b_start + fraction * (b_target - b_start)

    @staticmethod
    def re_anchor_transition(
        b_curr: float,
        b_new_target: float,
        now: float,
        sync_period_s: float = 300.0,
    ) -> tuple[float, float, float]:
        """Returns (b_start, b_target, transition_s) ensuring C0 continuity."""
        # Starting point is strictly b_curr, ensuring zero level jump
        return b_curr, b_new_target, sync_period_s


class PreviewState(str, Enum):
    STEADY_STATE = "steady_state"
    PREVIEW_START = "preview_start"
    PREVIEW_ACTIVE = "preview_active"
    PREVIEW_SETTLING = "preview_settling"
    RE_ANCHORING = "re_anchoring"


class InteractivePreviewAutomaton:
    """Manages ephemeral 1-2s slider tuning previews and graceful re-anchoring."""

    def __init__(self, throttle_interval_s: float = 0.150) -> None:
        self.throttle_interval_s = float(throttle_interval_s)
        self.state = PreviewState.STEADY_STATE
        self.last_dispatch_time: float = 0.0
        self.preview_level: int = 0
        self.baseline_target: int = 0
        self.last_dispatched_level: int | None = None

    def start_preview(self, current_level: int, horizon_target: int) -> None:
        self.state = PreviewState.PREVIEW_START
        self.preview_level = current_level
        self.last_dispatched_level = current_level
        self.baseline_target = horizon_target
        self.state = PreviewState.PREVIEW_ACTIVE

    def update_drag(self, new_level: int, now: float) -> bool:
        """Updates drag level; returns True if dispatched, False if throttled."""
        self.preview_level = new_level
        if now - self.last_dispatch_time >= self.throttle_interval_s:
            self.last_dispatch_time = now
            self.last_dispatched_level = new_level
            return True
        return False

    def flush_trailing_edge(self, now: float) -> tuple[bool, int]:
        """Flushes final slider drag level if pending level differs from last dispatch.

        Guarantees bulb reflects final pointer release position even if last drag was throttled.
        """
        if self.preview_level != self.last_dispatched_level:
            self.last_dispatch_time = now
            self.last_dispatched_level = self.preview_level
            return True, self.preview_level
        return False, self.preview_level

    def pause_drag(self, now: float | None = None) -> tuple[bool, int]:
        """Transitions to PREVIEW_SETTLING and flushes trailing-edge position if now is provided."""
        self.state = PreviewState.PREVIEW_SETTLING
        if now is not None:
            return self.flush_trailing_edge(now)
        return False, self.preview_level

    def complete_preview(
        self, t_now: float, t_horizon: float, target_horizon: int
    ) -> tuple[int, float]:
        """Calculates bridge re-anchoring target and duration."""
        self.state = PreviewState.RE_ANCHORING
        delta_t_remain = max(0.0, t_horizon - t_now)
        if delta_t_remain >= 45.0:
            bridge_transition = delta_t_remain
            bridge_target = target_horizon
        else:
            bridge_transition = 15.0
            bridge_target = self.preview_level
        self.state = PreviewState.STEADY_STATE
        return bridge_target, bridge_transition
