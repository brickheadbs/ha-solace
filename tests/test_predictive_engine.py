"""Unit tests for the Solace predictive circadian engine.

Verifies:
- Asymmetric demand filtering (instant attack, damped decay)
- Clear-sky solar model and forecast fusion
- Predictive horizon chords, micro-chords, and watchdog supervisor
- Pre-staged 4-level standby cache and atomic snapshots
- RampTracker / RampLock lease mechanics and writer multi-entity dispatch
"""

from __future__ import annotations

import math
import pytest
from homeassistant.core import HomeAssistant

from custom_components.solace.filter import AsymmetricFilter
from custom_components.solace.solar import ClearSkySolarModel
from custom_components.solace.horizon import (
    PredictiveHorizonPlanner,
    WatchdogSupervisor,
    WatchdogState,
    InteractivePreviewAutomaton,
    PreviewState,
)
from custom_components.solace.models import SplinePoint
from custom_components.solace.spline import MonotoneCubicSpline
from custom_components.solace.standby import (
    StateTier,
    StandbyTarget,
    FixtureStandbyState,
    StandbyStateCache,
    RampKind,
    RampTracker,
)
from custom_components.solace.writer import LightWriter


# ---------------------------------------------------------------------------
# Filter Tests
# ---------------------------------------------------------------------------


def test_filter_instant_attack():
    f = AsymmetricFilter(initial_value=0.2, sample_period_s=300.0)
    # Sudden darkness spike: demand jumps from 0.2 to 0.8
    out = f.update(0.8, dt_s=5.0)
    assert out == 0.8, "Instant attack must trigger immediately with 0 delay"
    assert f.value == 0.8


def test_filter_damped_decay():
    f = AsymmetricFilter(initial_value=0.8, sample_period_s=300.0)
    # Sudden bright flash: demand drops from 0.8 to 0.2 after 300s (one half-life)
    out = f.update(0.2, dt_s=300.0)
    # Half-life = 300s: 0.2 + (0.8 - 0.2) * 0.5 = 0.5
    assert math.isclose(out, 0.5, abs_tol=0.01)


def test_filter_negative_dt_guard():
    f = AsymmetricFilter(initial_value=0.5, sample_period_s=300.0)
    out = f.update(0.3, dt_s=-10.0)  # Clock went backwards
    assert out == 0.5, "Negative dt must clamp to 0 and hold previous value safely"


def test_filter_output_clamped():
    f = AsymmetricFilter(initial_value=0.0)
    f.update(1.5, dt_s=10.0)
    assert f.value == 1.0
    f.reset(-0.5)
    assert f.value == 0.0
    f.reset(1.5)
    assert f.value == 1.0


# ---------------------------------------------------------------------------
# Solar & Forecast Tests
# ---------------------------------------------------------------------------


def test_solar_clear_sky_curve():
    # Dusk cutoff
    assert ClearSkySolarModel.clear_sky_illuminance(-7.0) == 0.0
    # Twilight transition (-6 to 2 deg)
    assert 0.0 < ClearSkySolarModel.clear_sky_illuminance(0.0) < 2215.44
    # Full daylight (> 2 deg)
    assert ClearSkySolarModel.clear_sky_illuminance(45.0) > 50000.0


def test_solar_weather_multiplier():
    assert ClearSkySolarModel.weather_optical_multiplier("thunderstorm", 0.0) == 2.00
    assert ClearSkySolarModel.weather_optical_multiplier("rainy", 3.0) == 1.80
    assert ClearSkySolarModel.weather_optical_multiplier("clear", 0.0) == 1.00


def test_solar_forecast_clearness_and_alpha():
    # Clear conditions
    c_eff = ClearSkySolarModel.effective_cloud_coverage(0.0, "clear", 0.0)
    assert c_eff == 0.0
    assert ClearSkySolarModel.forecast_clearness(c_eff) == 1.0

    # Overcast conditions
    c_eff_overcast = ClearSkySolarModel.effective_cloud_coverage(100.0, "cloudy", 0.0)
    assert c_eff_overcast == 100.0
    k_fc = ClearSkySolarModel.forecast_clearness(c_eff_overcast)
    assert math.isclose(k_fc, 0.25, abs_tol=0.01)

    # Cloud blending alpha
    alpha = ClearSkySolarModel.synthesize_alpha_blend(c_eff=80.0, k_sensor=0.1)
    assert alpha == 1.0  # Heavy clouds produce high blending


# ---------------------------------------------------------------------------
# Horizon Planner & Watchdog Tests
# ---------------------------------------------------------------------------


def test_horizon_planner_nominal_and_adaptive_chords():
    # Spline with smooth slope
    points = [
        SplinePoint(0.0, 50.0),
        SplinePoint(6.0, 100.0),
        SplinePoint(12.0, 200.0),
        SplinePoint(18.0, 100.0),
        SplinePoint(24.0, 50.0),
    ]
    spline = MonotoneCubicSpline(points)
    planner = PredictiveHorizonPlanner(spline, sync_period_s=300.0)

    t0, t1, b0, b1 = planner.compute_chord(12.0)
    assert math.isclose(t0, 12.0)
    assert math.isclose(t1, 12.0 + 300.0 / 3600.0)
    assert planner.max_chord_error(12.0) < 1.0

    # Test adaptive chords on gentle slope
    chords = planner.compute_adaptive_chords(12.0)
    assert len(chords) == 1

    # Spline with very steep slope (> 85 levels/h)
    steep_points = [
        SplinePoint(0.0, 10.0),
        SplinePoint(6.0, 10.0),
        SplinePoint(7.0, 200.0),  # 190 levels in 1 hour
        SplinePoint(24.0, 10.0),
    ]
    steep_spline = MonotoneCubicSpline(steep_points)
    steep_planner = PredictiveHorizonPlanner(steep_spline, sync_period_s=300.0)
    steep_chords = steep_planner.compute_adaptive_chords(6.5)
    assert len(steep_chords) == 5, "Steep transition must subdivide into five 60s micro-chords"


def test_watchdog_supervisor_states():
    supervisor = WatchdogSupervisor(nominal_sync_s=300.0, timeout_s=1800.0)
    supervisor.last_sync_time = 1000.0

    # 1000 to 1300s: NORMAL_SYNC
    assert supervisor.evaluate_state(1200.0) == WatchdogState.NORMAL_SYNC

    # 1300 to 2800s: WATCHDOG_PROJECTION
    assert supervisor.evaluate_state(1500.0) == WatchdogState.WATCHDOG_PROJECTION

    # > 2800s: TIMEOUT_FAILSAFE
    assert supervisor.evaluate_state(3000.0) == WatchdogState.TIMEOUT_FAILSAFE

    # In-flight level calculation
    in_flight = supervisor.calculate_in_flight_level(
        b_start=100.0, b_target=200.0, t_start=1000.0, duration_s=300.0, now=1150.0
    )
    assert in_flight == 150.0

    # C0 re-anchoring
    b_start, b_target, dur = supervisor.re_anchor_transition(
        b_curr=150.0, b_new_target=220.0, now=1150.0, sync_period_s=300.0
    )
    assert b_start == 150.0
    assert b_target == 220.0
    assert dur == 300.0


def test_interactive_preview_automaton():
    auto = InteractivePreviewAutomaton(throttle_interval_s=0.150)
    assert auto.state == PreviewState.STEADY_STATE

    auto.start_preview(current_level=100, horizon_target=180)
    assert auto.state == PreviewState.PREVIEW_ACTIVE

    # First drag dispatch
    assert auto.update_drag(120, now=1000.0) is True
    # Throttled drag within 150ms
    assert auto.update_drag(130, now=1000.05) is False
    # Trailing edge flush
    flushed, lvl = auto.flush_trailing_edge(now=1000.20)
    assert flushed is True
    assert lvl == 130

    # Re-anchoring bridge
    target, bridge_s = auto.complete_preview(t_now=1000.0, t_horizon=1200.0, target_horizon=180)
    assert auto.state == PreviewState.STEADY_STATE
    assert target == 180
    assert bridge_s == 200.0


# ---------------------------------------------------------------------------
# Standby Cache & RampLock Tests
# ---------------------------------------------------------------------------


def test_standby_cache_and_batching():
    cache = StandbyStateCache()
    cache.set_fixture(
        "kitchen",
        "light.kitchen_1",
        FixtureStandbyState(
            l0=StandbyTarget(level=0, kelvin=None, transition_s=3.0),
            l1=StandbyTarget(level=180, kelvin=3200, transition_s=10.0),
            l2=StandbyTarget(level=90, kelvin=2700, transition_s=5.0),
            l3=StandbyTarget(level=20, kelvin=2200, transition_s=5.0),
            ls=StandbyTarget(level=5, kelvin=2000, transition_s=5.0),
        ),
    )
    cache.set_fixture(
        "kitchen",
        "light.kitchen_2",
        FixtureStandbyState(
            l0=StandbyTarget(level=0, kelvin=None, transition_s=3.0),
            l1=StandbyTarget(level=180, kelvin=3200, transition_s=10.0),
            l2=StandbyTarget(level=90, kelvin=2700, transition_s=5.0),
            l3=StandbyTarget(level=20, kelvin=2200, transition_s=5.0),
            ls=StandbyTarget(level=5, kelvin=2000, transition_s=5.0),
        ),
    )

    batches = cache.batch_room_dispatch("kitchen", ["light.kitchen_1", "light.kitchen_2"], StateTier.L1_DEMAND)
    # Both lights share (180, 3200, 10.0) -> single batch entry with 2 entities
    assert (180, 3200, 10.0) in batches
    assert set(batches[(180, 3200, 10.0)]) == {"light.kitchen_1", "light.kitchen_2"}


def test_ramp_tracker_protection():
    tracker = RampTracker()
    now = 1000.0
    tracker.acquire_fast_path_lease("light.kitchen", target_level=180, target_kelvin=3200, now=now, duration_s=10.0)

    # In flight (1000s + 10s + 0.5s guard = 1010.5s)
    assert tracker.is_locked("light.kitchen", now=1005.0) is True
    assert tracker.should_suppress_chronic_write("light.kitchen", now=1005.0) is True

    # Expired
    assert tracker.is_locked("light.kitchen", now=1011.0) is False
    assert tracker.should_suppress_chronic_write("light.kitchen", now=1011.0) is False

    # Manual release
    tracker.acquire_fast_path_lease("light.kitchen", target_level=180, target_kelvin=3200, now=now, duration_s=10.0)
    tracker.release_lock("light.kitchen")
    assert tracker.is_locked("light.kitchen", now=1001.0) is False


# ---------------------------------------------------------------------------
# Writer Batched Dispatch Tests
# ---------------------------------------------------------------------------


async def test_writer_batched_turn_on(hass: HomeAssistant):
    calls: list[dict] = []

    async def _record(call):
        calls.append(dict(call.data))

    hass.services.async_register("light", "turn_on", _record)

    writer = LightWriter(hass)
    entities = ["light.kitchen_1", "light.kitchen_2"]
    await writer.async_set_brightness(
        entities, level=180, transition_s=10.0, wake_kelvin=3200, is_acute=True
    )
    await hass.async_block_till_done()

    assert len(calls) == 1
    assert calls[0]["entity_id"] == ["light.kitchen_1", "light.kitchen_2"]
    assert calls[0]["brightness"] == 180
    assert calls[0]["color_temp_kelvin"] == 3200
    assert calls[0]["transition"] == 10.0
    loop_now = hass.loop.time()
    assert writer.ramp_tracker.is_locked("light.kitchen_1", now=loop_now) is True
    assert writer.ramp_tracker.is_locked("light.kitchen_2", now=loop_now) is True
