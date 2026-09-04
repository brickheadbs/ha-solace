"""Pre-stored standby state cache, batched parameter grouping, and RampLock leases.

PURE MODULE — no ``homeassistant`` imports, ever.

Implements:
- 5-level pre-computed standby suite (L0_OFF, L1_DEMAND, L2_DIMINISHED, L3_AMBIENCE, LS_NIGHT).
- Atomic room state replacement dict-copy guaranteeing 0.00% torn reads across multi-fixture rooms.
- Parameter grouping for single-service-call batched dispatch (eliminating Zigbee queuing/popcorning).
- FixtureRamp and RampTracker enforcing RampLock hardware lockout leases to protect acute turn-ons
  from chronic background glide preemption.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from enum import Enum
from typing import Sequence

__all__ = [
    "StateTier",
    "StandbyTarget",
    "FixtureStandbyState",
    "StandbyStateCache",
    "RampKind",
    "FixtureRamp",
    "RampTracker",
]


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
        """Sets standby state for a single fixture."""
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
        """O(1) target retrieval for a specific fixture and tier."""
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
        """Convenience lock acquisition."""
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
        """Acquires an acute fast path lease with default 0.5s guard band."""
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
