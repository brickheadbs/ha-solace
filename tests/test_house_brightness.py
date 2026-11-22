"""House brightness light: the brightness <-> house-bias mapping it gives Google Home."""

from __future__ import annotations

import pytest

from custom_components.solace.light import bias_to_brightness, brightness_to_bias


def test_neutral_is_half():
    assert bias_to_brightness(0.0) == 128
    assert brightness_to_bias(128) == 0.0


@pytest.mark.parametrize("bias", [-2.0, -1.3, -0.4, 0.0, 0.35, 1.0, 2.0])
def test_round_trip_within_one_step(bias):
    assert abs(brightness_to_bias(bias_to_brightness(bias)) - bias) <= 0.05


def test_ends_clamp_to_voice_range():
    assert brightness_to_bias(255) == 2.0
    assert brightness_to_bias(1) == -2.0
    assert bias_to_brightness(4.0) == 255
    assert bias_to_brightness(-4.0) == 1  # lowest level, never 0 (0 would read as off)


def test_bias_is_on_the_settings_step():
    for b in range(1, 256, 7):
        v = brightness_to_bias(b)
        assert abs(v / 0.05 - round(v / 0.05)) < 1e-9
