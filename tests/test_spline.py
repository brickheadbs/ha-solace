"""Unit tests for the monotone cubic spline interpolator."""

import pytest

from custom_components.solace.spline import MonotoneCubicSpline, SplinePoint


def test_empty_and_single_point():
    spline_empty = MonotoneCubicSpline([])
    assert spline_empty.evaluate(10.0) == 0.0

    spline_one = MonotoneCubicSpline([SplinePoint(5.0, 100.0)])
    assert spline_one.evaluate(0.0) == 100.0
    assert spline_one.evaluate(5.0) == 100.0
    assert spline_one.evaluate(10.0) == 100.0


def test_linear_interpolation():
    points = [SplinePoint(0.0, 0.0), SplinePoint(10.0, 100.0)]
    spline = MonotoneCubicSpline(points)

    assert spline.evaluate(0.0) == 0.0
    assert spline.evaluate(5.0) == 50.0
    assert spline.evaluate(10.0) == 100.0
    assert spline.evaluate(-5.0) == 0.0  # Clamp low
    assert spline.evaluate(15.0) == 100.0  # Clamp high


def test_monotonicity_guarantee():
    # Monotonically increasing data points
    points = [
        SplinePoint(0.0, 0.0),
        SplinePoint(2.0, 10.0),
        SplinePoint(4.0, 10.0),  # Flat step
        SplinePoint(6.0, 50.0),
        SplinePoint(8.0, 100.0),
    ]
    spline = MonotoneCubicSpline(points)

    # Values must never decrease anywhere on [0, 8]
    prev = 0.0
    for i in range(100):
        x = i * 8.0 / 99.0
        val = spline.evaluate(x)
        assert val >= prev - 1e-9, f"Monotonicity violation at x={x}: {val} < {prev}"
        prev = val


def test_lux_demand_curve():
    # Outdoor lux to indoor demand (100% -> 0%)
    points = [
        SplinePoint(0.0, 1.0),
        SplinePoint(50.0, 0.9),
        SplinePoint(500.0, 0.4),
        SplinePoint(2500.0, 0.0),
    ]
    spline = MonotoneCubicSpline(points)

    assert spline.evaluate(0.0) == 1.0
    assert spline.evaluate(2500.0) == 0.0
    assert spline.evaluate(5000.0) == 0.0  # Beyond bright daylight -> 0 demand

    # Twilight at 200 lx should be between 0.9 and 0.4
    mid_demand = spline.evaluate(200.0)
    assert 0.4 < mid_demand < 0.9


def test_24h_periodic_timeline():
    points = [
        SplinePoint(0.0, 20.0),
        SplinePoint(6.5, 120.0),
        SplinePoint(9.5, 254.0),
        SplinePoint(18.5, 180.0),
        SplinePoint(23.5, 20.0),
        SplinePoint(24.0, 20.0),
    ]
    spline = MonotoneCubicSpline(points, periodic=True)

    assert spline.evaluate_periodic_24h(0.0) == 20.0
    assert spline.evaluate_periodic_24h(24.0) == 20.0
    assert spline.evaluate_periodic_24h(9.5) == 254.0
    # Modulo test: hour 25.5 should evaluate at 1.5
    assert spline.evaluate_periodic_24h(25.5) == spline.evaluate(1.5)


def test_24h_periodic_wrapping_across_midnight():
    # Points without explicit 0.0 or 24.0 nodes
    points = [
        SplinePoint(6.5, 120.0),
        SplinePoint(9.5, 254.0),
        SplinePoint(18.5, 180.0),
        SplinePoint(23.5, 25.0),
    ]
    spline = MonotoneCubicSpline(points, periodic=True)

    # 0.0 and 24.0 must evaluate to identical values
    val_0 = spline.evaluate(0.0)
    val_24 = spline.evaluate(24.0)
    assert abs(val_0 - val_24) < 1e-9

    # Value at midnight must smoothly interpolate between 23.5 (25.0) and 6.5 (120.0)
    assert 25.0 < val_0 < 120.0

    # Values just before and after midnight must be continuous
    val_before = spline.evaluate(23.99)
    val_after = spline.evaluate(0.01)
    assert abs(val_before - val_after) < 1.0
