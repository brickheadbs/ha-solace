"""Asymmetric environmental demand filter.

PURE MODULE — no ``homeassistant`` imports, ever.

Operates strictly in the normalized demand domain u in [0.0, 1.0]:
- Fast Attack (tau = 0s): instantaneous response to darkening (storm onset / squall).
- Damped Decay (alpha = 0.5 / 10m): multi-sample exponential decay on brightening (sunbeam / cloud break).
- Monotonic clock clamp (dt = max(0.0, dt)) preventing OverflowError on backward clock steps.
- Strict BIBO bounded output in [0.0, 1.0].
"""

from __future__ import annotations

import math

__all__ = ["AsymmetricFilter"]


class AsymmetricFilter:
    """Asymmetric demand filter with instant attack (tau=0) and damped decay.

    Operates strictly in the normalized demand domain u in [0.0, 1.0].
    """

    def __init__(
        self,
        initial_value: float = 0.0,
        sample_period_s: float = 300.0,
    ) -> None:
        self.sample_period_s = max(1.0, float(sample_period_s))
        self.tau_decay = self.sample_period_s / math.log(2.0)  # half-life of 1 sample
        self._value = max(0.0, min(1.0, float(initial_value)))

    @property
    def value(self) -> float:
        """Current filtered demand value in [0.0, 1.0]."""
        return self._value

    def reset(self, value: float) -> None:
        """Reset internal filter state."""
        self._value = max(0.0, min(1.0, float(value)))

    def update(self, u_demand: float, dt_s: float | None = None) -> float:
        """Executes one filter step for demand u in [0, 1].

        dt_s defaults to nominal sample_period_s (300s). Clamps dt_s >= 0 to guard
        against non-monotonic clock adjustments (preventing OverflowError).
        """
        u = max(0.0, min(1.0, float(u_demand)))
        if dt_s is None:
            effective_dt = self.sample_period_s
        else:
            effective_dt = max(0.0, float(dt_s))

        if u >= self._value:
            # Fast Attack: instantaneous response to darkening
            self._value = u
        else:
            # Damped Decay: multi-sample rolling decay
            alpha = 1.0 - math.exp(-effective_dt / self.tau_decay)
            self._value = alpha * u + (1.0 - alpha) * self._value
            # Guarantee bounded output
            self._value = max(0.0, min(1.0, self._value))

        return self._value
