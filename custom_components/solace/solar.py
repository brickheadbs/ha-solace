"""Astronomical clear-sky solar model and cloud forecast synthesizer.

PURE MODULE — no ``homeassistant`` imports, ever.

Implements:
- Continuous Robledo-Soler clear-sky horizontal illuminance E_clear(theta).
- Weather condition optical depth multiplier kappa_cond.
- Dual Clearness Indices K_sensor (local sensor truth) and K_fc (forecast model).
- Unified cloud blending parameter alpha in [0.0, 1.0].
"""

from __future__ import annotations

import math

__all__ = ["ClearSkySolarModel"]


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
        """Effective cloud coverage adjusted by condition optical depth."""
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
