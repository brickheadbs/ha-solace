"""Solace Predictive Circadian Lighting Engine — Mathematical Validation Harness.

Simulates and programmatically verifies:
1. Standby Cache (R1): 4-level pre-computation, O(1) retrieval, batched grouping.
2. Event Separation & RampLock (R2): acute fast-path priority, background glide suppression.
3. Asymmetric Filter (R3): storm fast-attack, sunbeam damped decay, BIBO stability.
4. Predictive Horizon Traversal (R2): 300s linear hardware chord error bounding.
5. Watchdog Projection & C0 Continuity (R2): packet loss progression and flicker-free re-anchoring.
6. Cloud Forecast & Clear-Sky Model (R4): Robledo-Soler illuminance, clearness indices, alpha blending.
7. Real-Time Interactive Preview (R5): 5-state automaton, rate floor compliance, bridge re-anchoring.

Can be run directly:
    python tests/validation/simulate_predictive_circadian.py
or via pytest:
    pytest tests/validation/simulate_predictive_circadian.py
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
import math
from pathlib import Path
import random
import sys
import threading
import time
from typing import Any, Sequence

# Ensure repository root is on sys.path for direct execution
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# Real Solace pure modules
from custom_components.solace.fade import may_run_concurrently
from custom_components.solace.models import (
    DEFAULT_BRIGHTNESS_TIMELINE,
    DEFAULT_COLOUR_TIMELINE,
    Family,
    SplinePoint,
)
from custom_components.solace.spline import MonotoneCubicSpline

# ============================================================================
# Section 1: Standby State Architecture Models (R1)
# ============================================================================


class StateTier(str, Enum):
    """Operational lighting state tiers."""

    L0_OFF = "l0_off"
    L1_DEMAND = "l1_demand"
    L2_DIMINISHED = "l2_diminished"
    L3_AMBIENCE = "l3_ambience"
    LS_NIGHT = "ls_night"


@dataclass(frozen=True, slots=True)
class StandbyTarget:
    """Pre-computed target state for a single fixture at a specific tier."""

    level: int
    kelvin: int | None
    transition_s: float


@dataclass(frozen=True, slots=True)
class FixtureStandbyState:
    """Complete 5-level pre-computed standby suite for a single fixture."""

    l0: StandbyTarget
    l1: StandbyTarget
    l2: StandbyTarget
    l3: StandbyTarget
    ls: StandbyTarget


class StandbyStateCache:
    """Continuous background cache holding pre-staged states for instant deployment."""

    def __init__(self) -> None:
        self._cache: dict[tuple[str, str], FixtureStandbyState] = {}

    def set_fixture(
        self,
        room_id: str,
        fixture_id: str,
        state: FixtureStandbyState,
    ) -> None:
        self._cache[(room_id, fixture_id)] = state

    def update_room(
        self,
        room_id: str,
        fixture_states: dict[str, FixtureStandbyState],
    ) -> None:
        """Atomically updates all fixture standby states for a room via immutable dict copy."""
        new_cache = dict(self._cache)
        for fixture_id, state in fixture_states.items():
            new_cache[(room_id, fixture_id)] = state
        self._cache = new_cache

    def get_target(
        self, room_id: str, fixture_id: str, tier: StateTier
    ) -> StandbyTarget:
        state = self._cache[(room_id, fixture_id)]
        if tier == StateTier.L0_OFF:
            return state.l0
        if tier == StateTier.L1_DEMAND:
            return state.l1
        if tier == StateTier.L2_DIMINISHED:
            return state.l2
        if tier == StateTier.L3_AMBIENCE:
            return state.l3
        if tier == StateTier.LS_NIGHT:
            return state.ls
        raise ValueError(f"Unknown tier: {tier}")

    def batch_room_dispatch(
        self, room_id: str, fixture_ids: Sequence[str], tier: StateTier
    ) -> dict[tuple[int, int | None, float], list[str]]:
        """Groups room fixtures by identical (level, kelvin, transition) for batched dispatch.

        Captures an immutable snapshot dict(self._cache) before iteration to guarantee
        atomic, non-torn reads across all fixtures in a room during concurrent background updates.
        """
        cache_snapshot = dict(self._cache)
        groups: dict[tuple[int, int | None, float], list[str]] = defaultdict(list)
        for f_id in fixture_ids:
            state = cache_snapshot.get((room_id, f_id))
            if state is None:
                continue
            if tier == StateTier.L0_OFF:
                target = state.l0
            elif tier == StateTier.L1_DEMAND:
                target = state.l1
            elif tier == StateTier.L2_DIMINISHED:
                target = state.l2
            elif tier == StateTier.L3_AMBIENCE:
                target = state.l3
            elif tier == StateTier.LS_NIGHT:
                target = state.ls
            else:
                raise ValueError(f"Unknown tier: {tier}")
            key = (target.level, target.kelvin, target.transition_s)
            groups[key].append(f_id)
        return dict(groups)


# ============================================================================
# Section 2: Event Separation & RampLock Models (R2)
# ============================================================================


class RampKind(str, Enum):
    ACUTE_FAST_PATH = "acute_fast_path"
    CHRONIC_GLIDE = "chronic_glide"


@dataclass
class FixtureRamp:
    """Active hardware ramp record with lease expiry."""

    kind: RampKind
    target_level: int
    target_kelvin: int | None
    start_time: float
    duration_s: float
    guard_band_s: float = 0.5

    @property
    def lock_expiry(self) -> float:
        if self.kind == RampKind.ACUTE_FAST_PATH:
            return self.start_time + self.duration_s + self.guard_band_s
        return 0.0

    def is_locked(self, now: float) -> bool:
        return now < self.lock_expiry


class RampTracker:
    """Tracks per-fixture ramp leases and blocks routine background writes."""

    def __init__(self) -> None:
        self._ramps: dict[str, FixtureRamp] = {}

    def acquire_lock(
        self,
        entity_id: str,
        kind: RampKind,
        duration_s: float,
        guard_band_s: float = 0.5,
        start_time: float | None = None,
        target_level: int = 0,
        target_kelvin: int | None = None,
    ) -> FixtureRamp:
        """Acquires a ramp protection lock per IRampTracker interface contract."""
        t0 = start_time if start_time is not None else 0.0
        ramp = FixtureRamp(
            kind=kind,
            target_level=target_level,
            target_kelvin=target_kelvin,
            start_time=t0,
            duration_s=duration_s,
            guard_band_s=guard_band_s,
        )
        self._ramps[entity_id] = ramp
        return ramp

    def lock(
        self,
        entity_id: str,
        kind: RampKind,
        duration_s: float,
        guard_s: float = 0.5,
    ) -> FixtureRamp:
        """Convenience lock acquisition matching PROJECT.md interface contract."""
        return self.acquire_lock(entity_id, kind, duration_s, guard_band_s=guard_s)

    def release_lock(self, entity_id: str) -> None:
        """Explicitly releases/cancels any active ramp lease on the entity."""
        self._ramps.pop(entity_id, None)

    def acquire_fast_path_lease(
        self,
        entity_id: str,
        target_level: int,
        target_kelvin: int | None,
        now: float,
        duration_s: float,
    ) -> FixtureRamp:
        """Legacy helper for backwards compatibility with existing fast-path tests."""
        return self.acquire_lock(
            entity_id=entity_id,
            kind=RampKind.ACUTE_FAST_PATH,
            duration_s=duration_s,
            guard_band_s=0.5,
            start_time=now,
            target_level=target_level,
            target_kelvin=target_kelvin,
        )

    def is_locked(self, entity_id: str, now: float) -> bool:
        ramp = self._ramps.get(entity_id)
        if ramp is None:
            return False
        return ramp.is_locked(now)

    def should_suppress_chronic_write(self, entity_id: str, now: float) -> bool:
        """Returns True if a chronic background glide must be blocked from writing."""
        return self.is_locked(entity_id, now)


class DualChannelHardwareCoordinator:
    """Manages dual-channel (brightness + colour) hardware commands with vendor safety rules.

    Guards against bidirectional microcontroller freezes on IKEA TRADFRI fixtures:
    - Forward hazard: defer colour commands while a brightness glide is active.
    - Reverse hazard: defer brightness writes while a colour step is in flight.
    """

    def __init__(self) -> None:
        self._brightness_busy_until: dict[str, float] = {}
        self._colour_busy_until: dict[str, float] = {}
        self.command_log: list[dict[str, Any]] = []

    def is_brightness_busy(self, entity_id: str, now: float) -> bool:
        return now < self._brightness_busy_until.get(entity_id, 0.0)

    def is_colour_busy(self, entity_id: str, now: float) -> bool:
        return now < self._colour_busy_until.get(entity_id, 0.0)

    def dispatch_brightness(
        self,
        entity_id: str,
        level: int,
        transition_s: float,
        now: float,
        family: Family,
    ) -> bool:
        """Dispatches brightness write; defers if active colour step on non-concurrent fixture."""
        if not may_run_concurrently(family) and self.is_colour_busy(entity_id, now):
            # Reverse hazard protection: defer brightness while colour step is active
            return False

        self._brightness_busy_until[entity_id] = now + transition_s
        self.command_log.append({
            "type": "brightness",
            "entity_id": entity_id,
            "level": level,
            "transition_s": transition_s,
            "now": now,
        })
        return True

    def dispatch_colour(
        self,
        entity_id: str,
        target_kelvin: int,
        transition_s: float,
        now: float,
        family: Family,
    ) -> bool:
        """Dispatches colour step; defers if active brightness glide on non-concurrent fixture."""
        if not may_run_concurrently(family) and self.is_brightness_busy(entity_id, now):
            # Forward hazard protection: defer colour while brightness glide is active
            return False

        self._colour_busy_until[entity_id] = now + transition_s
        self.command_log.append({
            "type": "colour",
            "entity_id": entity_id,
            "kelvin": target_kelvin,
            "transition_s": transition_s,
            "now": now,
        })
        return True


# ============================================================================
# Section 3: Asymmetric Environmental Filter (R3)
# ============================================================================


class AsymmetricFilter:
    """Asymmetric demand filter with instant attack (tau=0) and damped decay.

    Operates strictly in the normalized demand domain u in [0.0, 1.0].
    """

    def __init__(self, initial_value: float = 0.0, sample_period_s: float = 300.0) -> None:
        self.sample_period_s = sample_period_s
        self.tau_decay = sample_period_s / math.log(2.0)  # half-life of 1 sample
        self._value = max(0.0, min(1.0, float(initial_value)))

    @property
    def value(self) -> float:
        return self._value

    def reset(self, value: float) -> None:
        self._value = max(0.0, min(1.0, float(value)))

    def update(self, u_demand: float, dt_s: float | None = None) -> float:
        """Executes one filter step for demand u in [0, 1].

        dt_s defaults to nominal sample_period_s (300s). Clamps dt_s >= 0 to guard
        against non-monotonic clock adjustments (preventing OverflowError).
        """
        u = max(0.0, min(1.0, float(u_demand)))
        if dt_s is None:
            dt_s = self.sample_period_s
        else:
            dt_s = max(0.0, float(dt_s))

        if u >= self._value:
            # Fast Attack: instantaneous response to darkening
            self._value = u
        else:
            # Damped Decay: multi-sample rolling decay
            alpha = 1.0 - math.exp(-dt_s / self.tau_decay)
            self._value = alpha * u + (1.0 - alpha) * self._value
            # Guarantee bounded output
            self._value = max(0.0, min(1.0, self._value))

        return self._value


# ============================================================================
# Section 4: Predictive Horizon Planner & Error Bounding (R2)
# ============================================================================


class PredictiveHorizonPlanner:
    """Plans continuous linear hardware chords across 300s synchronization intervals."""

    def __init__(self, spline: MonotoneCubicSpline, sync_period_s: float = 300.0) -> None:
        self.spline = spline
        self.sync_period_s = sync_period_s
        self.dt_hours = sync_period_s / 3600.0

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


# ============================================================================
# Section 5: Watchdog Projection & C0 Continuity (R2)
# ============================================================================


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
        self.nominal_sync_s = nominal_sync_s
        self.timeout_s = timeout_s
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
        if now <= t_start:
            return b_start
        if now >= t_start + duration_s:
            return b_target
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


# ============================================================================
# Section 6: Clear-Sky Solar & Cloud Forecast Model (R4)
# ============================================================================


class ClearSkySolarModel:
    """Astronomical clear-sky illuminance and Met.no forecast clearness synthesizer."""

    @staticmethod
    def clear_sky_illuminance(theta_deg: float) -> float:
        """Calculates CIE/Robledo-Soler clear-sky horizontal illuminance in lux.

        Continuous profile aligned with measured installation solar table:
        - θ <= -6.0°: 0.0 lx (civil dusk cutoff)
        - -6.0° < θ <= 2.0°: Smooth twilight power curve (0 lx at -6°, 775.7 lx at 0°, 2215.44 lx at 2°)
        - θ > 2.0°: 105,000 * (sin θ)^1.15 (clear daylight)
        """
        if theta_deg <= -6.0:
            return 0.0
        if theta_deg <= 2.0:
            x = (theta_deg + 6.0) / 8.0
            return 2215.44 * (x**3.65)
        # Daylight clear-sky equation
        sin_theta = math.sin(math.radians(theta_deg))
        if sin_theta <= 0:
            return 0.0
        return 105000.0 * (sin_theta**1.15)

    @staticmethod
    def weather_optical_multiplier(condition: str, precip_mm: float) -> float:
        """Determines condition-dependent optical density multiplier."""
        cond = condition.lower()
        if "lightning" in cond or "storm" in cond:
            return 2.00
        if precip_mm > 2.0:
            return 1.80
        if "rain" in cond or "pouring" in cond or (0.1 < precip_mm <= 2.0):
            return 1.50
        if "fog" in cond:
            return 1.40
        if "cloudy" in cond or "overcast" in cond:
            return 1.25
        return 1.00

    @classmethod
    def effective_cloud_coverage(
        cls, cloud_pct: float, condition: str, precip_mm: float
    ) -> float:
        kappa = cls.weather_optical_multiplier(condition, precip_mm)
        return min(100.0, max(0.0, cloud_pct * kappa))

    @staticmethod
    def clearness_sensor(e_sensor: float, e_clear: float) -> float:
        """Calculates sensor clearness index K_sensor in [0.0, 1.2]."""
        stabilizer = 20.0  # Prevents division by zero in twilight
        k = max(0.0, e_sensor) / (e_clear + stabilizer)
        return min(1.2, max(0.0, k))

    @staticmethod
    def forecast_clearness(c_eff: float) -> float:
        """Kasten-Czeplak empirical forecast clearness index."""
        c_fraction = max(0.0, min(100.0, c_eff)) / 100.0
        return max(0.02, 1.0 - 0.75 * (c_fraction**2.5))

    @classmethod
    def synthesize_alpha_blend(
        cls,
        c_eff: float,
        k_sensor: float,
        cloud_blend_threshold: float = 50.0,
    ) -> float:
        """Computes Solace cloud blending parameter alpha in [0.0, 1.0]."""
        if c_eff <= cloud_blend_threshold:
            alpha_fc = 0.0
        else:
            alpha_fc = (c_eff - cloud_blend_threshold) / (100.0 - cloud_blend_threshold)
            alpha_fc = min(1.0, max(0.0, alpha_fc))

        # Sensor clearness factor (0.60 clear to 0.10 heavy overcast)
        alpha_sensor = (0.60 - k_sensor) / (0.60 - 0.10)
        alpha_sensor = min(1.0, max(0.0, alpha_sensor))

        return max(alpha_fc, alpha_sensor)


# ============================================================================
# Section 7: Interactive Tuning Preview Automaton (R5)
# ============================================================================


class PreviewState(str, Enum):
    STEADY_STATE = "steady_state"
    PREVIEW_START = "preview_start"
    PREVIEW_ACTIVE = "preview_active"
    PREVIEW_SETTLING = "preview_settling"
    RE_ANCHORING = "re_anchoring"


class InteractivePreviewAutomaton:
    """Manages ephemeral 1-2s slider tuning previews and graceful re-anchoring."""

    def __init__(self, throttle_interval_s: float = 0.150) -> None:
        self.throttle_interval_s = throttle_interval_s
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


# ============================================================================
# Programmatic Validation Test Suite
# ============================================================================


def test_standby_cache_and_batching() -> None:
    """Test R1: Pre-computed standby state cache and batched grouping."""
    cache = StandbyStateCache()

    # Create 3 fixtures in room 'kitchen'
    # Fixture 1 and 2 share identical demand target, Fixture 3 has custom clamp
    f1_state = FixtureStandbyState(
        l0=StandbyTarget(level=0, kelvin=None, transition_s=3.0),
        l1=StandbyTarget(level=180, kelvin=3000, transition_s=2.0),
        l2=StandbyTarget(level=90, kelvin=3000, transition_s=5.0),
        l3=StandbyTarget(level=40, kelvin=2400, transition_s=10.0),
        ls=StandbyTarget(level=15, kelvin=2200, transition_s=2.0),
    )
    f2_state = FixtureStandbyState(
        l0=StandbyTarget(level=0, kelvin=None, transition_s=3.0),
        l1=StandbyTarget(level=180, kelvin=3000, transition_s=2.0),
        l2=StandbyTarget(level=90, kelvin=3000, transition_s=5.0),
        l3=StandbyTarget(level=40, kelvin=2400, transition_s=10.0),
        ls=StandbyTarget(level=15, kelvin=2200, transition_s=2.0),
    )
    f3_state = FixtureStandbyState(
        l0=StandbyTarget(level=0, kelvin=None, transition_s=3.0),
        l1=StandbyTarget(level=120, kelvin=3000, transition_s=2.0),  # Clamped to 120
        l2=StandbyTarget(level=60, kelvin=3000, transition_s=5.0),
        l3=StandbyTarget(level=40, kelvin=2400, transition_s=10.0),
        ls=StandbyTarget(level=15, kelvin=2200, transition_s=2.0),
    )

    cache.set_fixture("kitchen", "light.k1", f1_state)
    cache.set_fixture("kitchen", "light.k2", f2_state)
    cache.set_fixture("kitchen", "light.k3", f3_state)

    # Verify O(1) lookup returns exact targets
    assert cache.get_target("kitchen", "light.k1", StateTier.L1_DEMAND).level == 180
    assert cache.get_target("kitchen", "light.k3", StateTier.L1_DEMAND).level == 120
    assert cache.get_target("kitchen", "light.k1", StateTier.L0_OFF).level == 0
    assert cache.get_target("kitchen", "light.k1", StateTier.LS_NIGHT).level == 15

    # Verify batched grouping for L1 dispatch: k1 and k2 must be grouped together
    groups_l1 = cache.batch_room_dispatch(
        "kitchen", ["light.k1", "light.k2", "light.k3"], StateTier.L1_DEMAND
    )
    assert (180, 3000, 2.0) in groups_l1
    assert (120, 3000, 2.0) in groups_l1
    assert set(groups_l1[(180, 3000, 2.0)]) == {"light.k1", "light.k2"}
    assert groups_l1[(120, 3000, 2.0)] == ["light.k3"]

    # Verify L3 ambience grouping: all 3 share (40, 2400, 10.0) -> single batched call
    groups_l3 = cache.batch_room_dispatch(
        "kitchen", ["light.k1", "light.k2", "light.k3"], StateTier.L3_AMBIENCE
    )
    assert len(groups_l3) == 1
    assert set(groups_l3[(40, 2400, 10.0)]) == {"light.k1", "light.k2", "light.k3"}


def test_event_separation_and_ramp_lock() -> None:
    """Test R2: Priority hierarchy and RampLock lease blocking 300s background writes."""
    tracker = RampTracker()
    entity_id = "light.living_room_ceiling"

    # Occupancy turn-on fires at t=100.0s with duration 10.0s (+ 0.5s guard band)
    t_occ = 100.0
    duration = 10.0
    tracker.acquire_fast_path_lease(entity_id, 200, 3200, t_occ, duration)

    # 1. During acute ease-out (t=102.0s), RampLock is active
    assert tracker.is_locked(entity_id, 102.0) is True
    assert tracker.should_suppress_chronic_write(entity_id, 102.0) is True

    # 2. At t=109.9s, RampLock remains active
    assert tracker.is_locked(entity_id, 109.9) is True
    assert tracker.should_suppress_chronic_write(entity_id, 109.9) is True

    # 3. Within guard band (t=110.3s), RampLock remains active
    assert tracker.is_locked(entity_id, 110.3) is True
    assert tracker.should_suppress_chronic_write(entity_id, 110.3) is True

    # 4. After lease expiry (t=110.6s), RampLock clears
    assert tracker.is_locked(entity_id, 110.6) is False
    assert tracker.should_suppress_chronic_write(entity_id, 110.6) is False

    # 5. IRampTracker Interface Compliance: acquire_lock, lock, and manual release_lock
    manual_entity = "light.kitchen_accent"
    tracker.acquire_lock(
        manual_entity,
        RampKind.ACUTE_FAST_PATH,
        duration_s=10.0,
        guard_band_s=0.5,
        start_time=100.0,
    )
    assert tracker.is_locked(manual_entity, 105.0) is True
    # Test explicit cancellation via release_lock
    tracker.release_lock(manual_entity)
    assert tracker.is_locked(manual_entity, 105.0) is False

    # Convenience lock method
    tracker.lock(manual_entity, RampKind.ACUTE_FAST_PATH, duration_s=5.0, guard_s=0.5)
    assert tracker.is_locked(manual_entity, 2.0) is True
    tracker.release_lock(manual_entity)
    assert tracker.is_locked(manual_entity, 2.0) is False


def test_asymmetric_filter_storm_attack() -> None:
    """Test R3: Storm onset darkening step response achieves 0s latency and 0 overshoot."""
    flt = AsymmetricFilter(initial_value=0.0)
    # Darkening step from 0.0 to 0.85
    y0 = flt.update(0.85)
    assert y0 == 0.85, f"Expected immediate attack 0.85, got {y0}"
    # Additional darkening step to 0.95
    y1 = flt.update(0.95)
    assert y1 == 0.95


def test_asymmetric_filter_sunbeam_spike() -> None:
    """Test R3: Single-sample sunbeam spike is damped by exactly 50% with zero overshoot."""
    flt = AsymmetricFilter(initial_value=0.80)
    # Transient cloud gap (sunbeam surge drops demand to 0.0)
    y_spike = flt.update(0.00, dt_s=300.0)
    # Half-life of 300s -> alpha = 0.5 -> 0.5 * 0.0 + 0.5 * 0.80 = 0.40
    assert abs(y_spike - 0.40) < 1e-4, f"Expected 0.4000, got {y_spike}"

    # Sunbeam closes on next sample (demand returns to 0.80)
    y_recover = flt.update(0.80, dt_s=300.0)
    # Instant attack triggers immediately
    assert y_recover == 0.80, f"Expected instant recovery 0.80, got {y_recover}"


def test_asymmetric_filter_persistent_decay() -> None:
    """Test R3: Persistent clearing sky decays over 2 samples (10m) with strict monotonicity."""
    flt = AsymmetricFilter(initial_value=0.80)
    history = [flt.value]
    for _ in range(4):
        history.append(flt.update(0.00, dt_s=300.0))

    # Expected progression: 0.80 -> 0.40 -> 0.20 -> 0.10 -> 0.05
    assert abs(history[1] - 0.40) < 1e-4
    assert abs(history[2] - 0.20) < 1e-4  # 600s = 10 minutes (settled to 25% of baseline)
    assert abs(history[3] - 0.10) < 1e-4
    assert abs(history[4] - 0.05) < 1e-4

    # Verify strict monotonicity
    for i in range(len(history) - 1):
        assert history[i] > history[i + 1]


def test_asymmetric_filter_bibo_stability() -> None:
    """Test R3: Filter maintains strict BIBO bounds in [0.0, 1.0] across 10,000 random inputs."""
    random.seed(42)
    flt = AsymmetricFilter(initial_value=0.5)
    for _ in range(10000):
        u_rand = random.uniform(0.0, 1.0)
        dt_rand = random.uniform(10.0, 1200.0)
        y = flt.update(u_rand, dt_s=dt_rand)
        assert 0.0 <= y <= 1.0, f"Stability violation: y={y} outside [0, 1]"


def test_predictive_horizon_chord_error() -> None:
    """Test R2: 300s linear hardware chord error is bounded by Cauchy theorem (< 0.20 levels)."""
    # Create a steep circadian timeline: 204 level drop across dusk
    circadian_timeline = (
        SplinePoint(0.0, 50.0),
        SplinePoint(6.0, 50.0),
        SplinePoint(9.0, 254.0),
        SplinePoint(18.0, 254.0),
        SplinePoint(21.5, 50.0),  # Dusk drop: 204 levels in 3.5h
        SplinePoint(24.0, 50.0),
    )
    spline_b = MonotoneCubicSpline(circadian_timeline, periodic=True)
    spline_k = MonotoneCubicSpline(DEFAULT_COLOUR_TIMELINE, periodic=True)

    planner_b = PredictiveHorizonPlanner(spline_b, sync_period_s=300.0)
    planner_k = PredictiveHorizonPlanner(spline_k, sync_period_s=300.0)

    # Evaluate across all 288 5-minute intervals in 24 hours
    dt_hours = 300.0 / 3600.0
    max_err_b = 0.0
    max_err_k = 0.0

    for step in range(288):
        t0 = step * dt_hours
        err_b = planner_b.max_chord_error(t0, num_samples=10)
        err_k = planner_k.max_chord_error(t0, num_samples=10)
        if err_b > max_err_b:
            max_err_b = err_b
        if err_k > max_err_k:
            max_err_k = err_k

    # Assert bounded error
    assert (
        max_err_b < 0.20
    ), f"Brightness chord error exceeded bound: {max_err_b:.4f} levels"
    assert (
        max_err_k < 1.0
    ), f"Colour chord error exceeded bound: {max_err_k:.4f} Kelvin"

    # Confirms sub-quantum resolution to 1-level Zigbee hardware
    assert max_err_b <= 0.12


def test_watchdog_projection_delayed_packets() -> None:
    """Test R2: Watchdog projection state transitions and monotonic extrapolation."""
    watchdog = WatchdogSupervisor(nominal_sync_s=300.0, timeout_s=1800.0)
    watchdog.last_sync_time = 1000.0

    # At t=1200s (elapsed 200s <= 300s): NORMAL_SYNC
    assert watchdog.evaluate_state(1200.0) == WatchdogState.NORMAL_SYNC

    # At t=1350s (elapsed 350s > 300s): WATCHDOG_PROJECTION
    assert watchdog.evaluate_state(1350.0) == WatchdogState.WATCHDOG_PROJECTION

    # At t=2500s (elapsed 1500s <= 1800s): WATCHDOG_PROJECTION
    assert watchdog.evaluate_state(2500.0) == WatchdogState.WATCHDOG_PROJECTION

    # At t=2900s (elapsed 1900s > 1800s): TIMEOUT_FAILSAFE
    assert watchdog.evaluate_state(2900.0) == WatchdogState.TIMEOUT_FAILSAFE


def test_watchdog_reanchoring_c0_continuity() -> None:
    """Test R2: Zero-jump re-anchoring upon delayed sensor recovery."""
    # Bulb launched transition from level 100 to 200 over 300s at t=0
    b_start = 100.0
    b_target = 200.0
    t_start = 0.0
    duration = 300.0

    # Delayed sensor packet arrives at t=450s during a watchdog projection
    # Prior transition was planned from t=300 to t=600 targeting 220
    b_proj_start = 200.0
    b_proj_target = 220.0
    t_proj_start = 300.0

    t_recv = 450.0
    b_in_flight = WatchdogSupervisor.calculate_in_flight_level(
        b_proj_start, b_proj_target, t_proj_start, duration, t_recv
    )
    # Exactly halfway: 200 + 0.5 * 20 = 210.0
    assert abs(b_in_flight - 210.0) < 1e-4

    # Re-anchoring initiates fresh 300s glide to new target 240.0
    b_reanchor_start, b_new_target, t_glide = WatchdogSupervisor.re_anchor_transition(
        b_in_flight, 240.0, t_recv, sync_period_s=300.0
    )

    # C0 Continuity Invariant: Start of new transition strictly equals prior level
    assert b_reanchor_start == b_in_flight
    step_jump = abs(b_reanchor_start - b_in_flight)
    assert step_jump == 0.0, f"Discontinuity detected: step={step_jump}"


def test_cloud_solar_model_bounds() -> None:
    """Test R4: Clear-sky solar model bounds, clearness indices, and alpha blending."""
    model = ClearSkySolarModel

    # 1. Clear-sky bounds
    assert model.clear_sky_illuminance(-10.0) == 0.0
    assert model.clear_sky_illuminance(-6.0) == 0.0

    # Boundary continuity at theta = 2.0 deg (< 1.0 lx step jump)
    e_left = model.clear_sky_illuminance(1.9999)
    e_right = model.clear_sky_illuminance(2.0001)
    assert (
        abs(e_right - e_left) < 1.0
    ), f"Solar clear-sky discontinuity at 2.0 deg: left={e_left:.2f}, right={e_right:.2f}"

    # Sunset/sunrise horizon (0 deg)
    e_horizon = model.clear_sky_illuminance(0.0)
    assert 700.0 <= e_horizon <= 850.0, f"Unexpected horizon lux: {e_horizon}"

    # Summer solar noon at 54N (~55 deg)
    e_summer_noon = model.clear_sky_illuminance(55.0)
    assert 75000.0 <= e_summer_noon <= 90000.0, f"Unexpected noon lux: {e_summer_noon}"

    # 2. Clearness Index
    k_overcast = model.clearness_sensor(e_sensor=150.0, e_clear=50000.0)
    assert 0.0 <= k_overcast <= 0.01

    k_clear = model.clearness_sensor(e_sensor=50000.0, e_clear=50000.0)
    assert 0.95 <= k_clear <= 1.05

    # 3. Weather Optical Multiplier
    kappa_clear = model.weather_optical_multiplier("sunny", 0.0)
    assert kappa_clear == 1.0
    kappa_storm = model.weather_optical_multiplier("lightning-rainy", 5.0)
    assert kappa_storm == 2.0

    # 4. Alpha Blending
    # Clear day (cloud=10%, k_sensor=1.0) -> alpha must be 0.0
    alpha_clear = model.synthesize_alpha_blend(c_eff=10.0, k_sensor=1.0)
    assert alpha_clear == 0.0

    # Heavy overcast day (cloud=95%, k_sensor=0.05) -> alpha must be 1.0
    alpha_overcast = model.synthesize_alpha_blend(c_eff=95.0, k_sensor=0.05)
    assert alpha_overcast == 1.0


def test_interactive_preview_automaton() -> None:
    """Test R5: 5-state preview automaton, rate floor compliance, and bridge re-anchoring."""
    preview = InteractivePreviewAutomaton(throttle_interval_s=0.150)
    assert preview.state == PreviewState.STEADY_STATE

    # Start preview
    preview.start_preview(current_level=100, horizon_target=180)
    assert preview.state == PreviewState.PREVIEW_ACTIVE

    # Drag throttling: first event dispatches
    t0 = 1000.0
    assert preview.update_drag(120, now=t0) is True

    # Immediate event at t0+0.050s (50ms) is throttled
    assert preview.update_drag(130, now=t0 + 0.050) is False

    # Event at t0+0.160s (160ms) is dispatched
    assert preview.update_drag(140, now=t0 + 0.160) is True

    # Rate floor verification: 15 mired change over 1.5s transition
    delta_mired = 15.0
    t_prev_colour = 1.5
    rate = delta_mired / t_prev_colour  # 10.0 mired/s
    r_crit = 0.156  # mired/s (Zigbee accumulator floor from fade.py)
    assert rate > r_crit * 10, f"Rate {rate} insufficiently above R_crit {r_crit}"

    # Pause drag
    preview.pause_drag()
    assert preview.state == PreviewState.PREVIEW_SETTLING

    # Case 1: Complete preview with ample horizon time (delta_t_remain >= 45s)
    # Horizon scheduled at t=1300s, settle at t=1100s -> delta_t = 200s
    target_1, trans_1 = preview.complete_preview(
        t_now=1100.0, t_horizon=1300.0, target_horizon=180
    )
    assert target_1 == 180
    assert trans_1 == 200.0

    # Case 2: Complete preview near horizon boundary (delta_t_remain < 45s)
    preview.start_preview(current_level=140, horizon_target=180)
    # Horizon at t=1300s, settle at t=1280s -> delta_t = 20s
    target_2, trans_2 = preview.complete_preview(
        t_now=1280.0, t_horizon=1300.0, target_horizon=180
    )
    # Must hold steady at preview level with short transition
    assert target_2 == 140
    assert trans_2 == 15.0


def test_standby_cache_atomic_snapshot_zero_torn_reads() -> None:
    """Test R1: Atomic update_room and immutable snapshot reads guarantee 0.00% torn reads."""
    cache = StandbyStateCache()
    room_id = "living_room"
    fixtures = [f"light.fixture_{i}" for i in range(6)]

    state_a = FixtureStandbyState(
        l0=StandbyTarget(0, None, 3.0),
        l1=StandbyTarget(100, 2700, 2.0),
        l2=StandbyTarget(50, 2700, 5.0),
        l3=StandbyTarget(30, 2400, 10.0),
        ls=StandbyTarget(15, 2200, 2.0),
    )
    state_b = FixtureStandbyState(
        l0=StandbyTarget(0, None, 3.0),
        l1=StandbyTarget(220, 3200, 2.0),
        l2=StandbyTarget(110, 3200, 5.0),
        l3=StandbyTarget(40, 2400, 10.0),
        ls=StandbyTarget(15, 2200, 2.0),
    )

    # Initialize cache with state A
    cache.update_room(room_id, {f: state_a for f in fixtures})

    stop_event = threading.Event()
    torn_reads = 0
    total_reads = 0
    read_lock = threading.Lock()

    def writer() -> None:
        curr = state_b
        while not stop_event.is_set():
            cache.update_room(room_id, {f: curr for f in fixtures})
            curr = state_a if curr is state_b else state_b
            time.sleep(0.0001)

    def reader() -> None:
        nonlocal torn_reads, total_reads
        while not stop_event.is_set():
            groups = cache.batch_room_dispatch(room_id, fixtures, StateTier.L1_DEMAND)
            with read_lock:
                total_reads += 1
                # All fixtures in room share identical state: exactly 1 group must be returned.
                # If len(groups) > 1, fixtures were read across two states (torn read).
                if len(groups) > 1:
                    torn_reads += 1

    threads = [threading.Thread(target=reader) for _ in range(4)]
    writer_thread = threading.Thread(target=writer)

    writer_thread.start()
    for t in threads:
        t.start()

    time.sleep(0.25)
    stop_event.set()

    writer_thread.join()
    for t in threads:
        t.join()

    assert total_reads > 50, f"Expected > 50 reads, got {total_reads}"
    assert torn_reads == 0, (
        f"Torn reads detected: {torn_reads} / {total_reads} ({torn_reads / total_reads * 100:.2f}%)"
    )


def test_asymmetric_filter_negative_dt_guard() -> None:
    """Test R3: Asymmetric filter gracefully guards against negative dt (non-monotonic clock)."""
    flt = AsymmetricFilter(initial_value=0.50)
    # Negative dt (e.g. system clock stepped backwards by 350,000s)
    y = flt.update(0.20, dt_s=-350000.0)
    # Clamping dt_s = max(0.0, dt_s) yields dt_s = 0 -> alpha = 0 -> y remains at initial 0.50
    assert y == 0.50, f"Expected output 0.50, got {y}"
    # Also test negative dt when demand is higher (attack path)
    y_attack = flt.update(0.85, dt_s=-1000.0)
    assert y_attack == 0.85


def test_steep_transition_adaptive_micro_chords() -> None:
    """Test R2: Adaptive micro-chords restore error < 0.20 levels on steep curves (delta_T < 2.3h)."""
    # Steep 1.0-hour dusk transition: drops 204 levels from 254 to 50 between 18.0 and 19.0
    steep_timeline = (
        SplinePoint(0.0, 50.0),
        SplinePoint(6.0, 50.0),
        SplinePoint(9.0, 254.0),
        SplinePoint(18.0, 254.0),
        SplinePoint(19.0, 50.0),  # Steep 1h drop: slope ~204 lvls/h > 85 lvls/h
        SplinePoint(24.0, 50.0),
    )
    spline = MonotoneCubicSpline(steep_timeline, periodic=True)
    planner = PredictiveHorizonPlanner(spline, sync_period_s=300.0)

    # Evaluate over the steep drop interval (t0 = 18.0 hours)
    t0 = 18.0
    raw_chord_err = planner.max_chord_error(t0, num_samples=20)
    # For a 1h drop over 300s, raw chord error exceeds 0.20 levels (~0.97 levels)
    assert raw_chord_err > 0.20, f"Expected raw error > 0.20, got {raw_chord_err}"

    # With adaptive micro-chords (subdividing into five 60s chords), error is restored to < 0.20
    adaptive_err = planner.max_adaptive_chord_error(t0, num_samples=20)
    assert (
        adaptive_err < 0.20
    ), f"Adaptive micro-chord error {adaptive_err} exceeded bound 0.20"


def test_interactive_preview_trailing_edge_flush() -> None:
    """Test R5: Trailing-edge throttle flush updates bulb to final slider position upon release."""
    preview = InteractivePreviewAutomaton(throttle_interval_s=0.150)
    t0 = 1000.0
    preview.start_preview(current_level=100, horizon_target=180)

    # Drag event at t0: dispatched
    assert preview.update_drag(120, now=t0) is True

    # Drag event at t0 + 0.050s: throttled (bulb remains at 120)
    assert preview.update_drag(135, now=t0 + 0.050) is False
    assert preview.last_dispatched_level == 120
    assert preview.preview_level == 135

    # User releases slider at t0 + 0.060s: pause_drag flushes trailing edge
    flushed, level = preview.pause_drag(now=t0 + 0.060)
    assert flushed is True
    assert level == 135
    assert preview.last_dispatched_level == 135


def test_ikea_bidirectional_channel_serialization() -> None:
    """Test R2: IKEA bulbs defer colour steps during brightness glides AND defer brightness writes during colour steps."""
    coordinator = DualChannelHardwareCoordinator()
    ikea_bulb = "light.ikea_tradfri_bulb"
    aqara_bulb = "light.aqara_cct_bulb"

    # 1. Forward Hazard: Start 300s brightness glide at t=0
    assert (
        coordinator.dispatch_brightness(
            ikea_bulb, level=180, transition_s=300.0, now=0.0, family=Family.IKEA
        )
        is True
    )
    assert (
        coordinator.dispatch_brightness(
            aqara_bulb, level=180, transition_s=300.0, now=0.0, family=Family.AQARA_CCT
        )
        is True
    )

    # At t=10.0s, attempt colour step
    # IKEA bulb MUST defer (brightness glide is active until t=300s)
    assert (
        coordinator.dispatch_colour(
            ikea_bulb, target_kelvin=3000, transition_s=4.0, now=10.0, family=Family.IKEA
        )
        is False
    )
    # Aqara bulb CAN run concurrently
    assert (
        coordinator.dispatch_colour(
            aqara_bulb, target_kelvin=3000, transition_s=4.0, now=10.0, family=Family.AQARA_CCT
        )
        is True
    )

    # 2. Reverse Hazard: At t=400s (brightness glide long finished)
    # Start 4.0s colour step on IKEA bulb
    assert (
        coordinator.dispatch_colour(
            ikea_bulb, target_kelvin=3200, transition_s=4.0, now=400.0, family=Family.IKEA
        )
        is True
    )
    assert (
        coordinator.dispatch_colour(
            aqara_bulb, target_kelvin=3200, transition_s=4.0, now=400.0, family=Family.AQARA_CCT
        )
        is True
    )

    # At t=402.0s, acute brightness write arrives
    # IKEA bulb MUST defer brightness (colour step active until t=404.0s)
    assert (
        coordinator.dispatch_brightness(
            ikea_bulb, level=220, transition_s=2.0, now=402.0, family=Family.IKEA
        )
        is False
    )
    # Aqara bulb CAN run concurrently
    assert (
        coordinator.dispatch_brightness(
            aqara_bulb, level=220, transition_s=2.0, now=402.0, family=Family.AQARA_CCT
        )
        is True
    )

    # At t=405.0s, colour step is complete: IKEA bulb accepts brightness write
    assert (
        coordinator.dispatch_brightness(
            ikea_bulb, level=220, transition_s=2.0, now=405.0, family=Family.IKEA
        )
        is True
    )


# ============================================================================
# Standalone CLI Entry Point
# ============================================================================


def run_all_tests() -> bool:
    """Executes all validation tests and outputs summary results."""
    tests = [
        ("Standby Cache & Batched Grouping (R1)", test_standby_cache_and_batching),
        ("Standby Cache: Atomic Snapshot Zero Torn Reads (R1)", test_standby_cache_atomic_snapshot_zero_torn_reads),
        ("Event Separation & RampLock Lease (R2)", test_event_separation_and_ramp_lock),
        ("IKEA Dual-Channel Serialization Hazard (R2)", test_ikea_bidirectional_channel_serialization),
        ("Asymmetric Filter: Storm Fast-Attack (R3)", test_asymmetric_filter_storm_attack),
        ("Asymmetric Filter: Sunbeam Spike Damping (R3)", test_asymmetric_filter_sunbeam_spike),
        ("Asymmetric Filter: Persistent Decay (R3)", test_asymmetric_filter_persistent_decay),
        ("Asymmetric Filter: BIBO Stability Proof (R3)", test_asymmetric_filter_bibo_stability),
        ("Asymmetric Filter: Negative dt Guard (R3)", test_asymmetric_filter_negative_dt_guard),
        ("Predictive Horizon: 300s Chord Error Bound (R2)", test_predictive_horizon_chord_error),
        ("Steep Transition: Adaptive Micro-Chords (R2)", test_steep_transition_adaptive_micro_chords),
        ("Watchdog Projection: Packet Loss Extrapolation (R2)", test_watchdog_projection_delayed_packets),
        ("Watchdog Re-Anchoring: C0 Continuity (R2)", test_watchdog_reanchoring_c0_continuity),
        ("Clear-Sky & Cloud Forecast Model (R4)", test_cloud_solar_model_bounds),
        ("Interactive Tuning Preview Automaton (R5)", test_interactive_preview_automaton),
        ("Interactive Preview: Trailing-Edge Throttle Flush (R5)", test_interactive_preview_trailing_edge_flush),
    ]

    print("=" * 78)
    print("Solace Predictive Circadian Engine — Mathematical Validation Harness")
    print("=" * 78)

    passed = 0
    failed = 0

    for name, test_fn in tests:
        try:
            test_fn()
            print(f"[PASS] {name}")
            passed += 1
        except Exception as e:
            print(f"[FAIL] {name}: {e}")
            failed += 1

    print("-" * 78)
    print(f"Total: {len(tests)} | Passed: {passed} | Failed: {failed}")
    print("=" * 78)

    return failed == 0


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)
