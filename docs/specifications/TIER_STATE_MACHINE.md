# Tier State Machine — design spec

**Status:** approved 2026-09-13 (Brandon). Supersedes the continuous-level write path.
**Source of truth for tier semantics:** Brandon's `Home Assistant Modes` sheet, 2026-09-12.

## Goal

Solace tracks the *actual* state of each fixture, holds every level precalculated, and
emits a command only when a room genuinely changes state. Levels are curve-derived and
recomputed every cycle; switching between them is discrete.

## Tiers

| Tier | Name | Meaning |
|---|---|---|
| `L0` | Off | normal off state |
| `L1` | On | normal on state |
| `L2` | Diminished | kitchen only, opposite side |
| `L3` | Ambient | ambience floor |
| `L1S` | Special | **a slot, not a tier** — see below |

`L1S` is a *substitution*: while a special mode is bound to a room, everything behaves
normally but `L1S` is used in place of `L1` for that room. It unbinds on mode timeout or
trigger. Night ramp and morning ramp are two **providers** that bind to the slot; a third
mode costs nothing. Do **not** add `L1SN`/`L1SM` as new enum members.

`StateTier.LS_NIGHT` is removed — it was a globally-latched fifth peer tier, which is the
wrong shape.

### Special-mode providers are clock-derived, not occupancy-derived

An `L1S` provider is a pure function of wall-clock time. Occupancy selects *which tier
applies*; the clock supplies *its value*. Consequence, and the reason this is easy:

- Leave the bedroom mid-ramp → room drops to `L3`.
- Return 2 minutes later → room selects `L1S`, whose value is `f(now)`.
- The ramp "continues as if you never left" because there is no ramp state to preserve.

Tolerance ±2 min. Resume uses the normal up-transition; after a short absence the delta
is small, so the resume fade is small.

## Values

All tier targets are precalculated for every fixture each cycle (`_update_standby_cache`,
already does this) and stored as `StandbyTarget(level, kelvin, transition_s)`.

Within-tier drift **is** followed — a room sitting in `L1` all afternoon tracks the curve —
but only when the change is perceptible, and never during an in-flight ramp.

## Perceptual dead zone (replaces flat `dead_zone`)

Measured hardware curve: output ∝ level^2.3. A flat 8-level dead zone is inverted —
it suppresses ~8% output change at level 200 (correct) but ~95% at level 20 (wrong), and
`ambience_floor`=9, `night_level`=26 and `min_cutoff`=48 all live in the broken half.

Rule: suppress a write unless predicted **output** changes by more than
`perceptual_dead_zone_pct` (default 3%), i.e.

    abs((new/old)**2.3 - 1) >= pct

with the level-0 and tier-change cases always writing. Keep the flat `dead_zone` setting
only as a floor against integer jitter.

## Transition selection — a matrix, not a ladder

A transition is a function of `(from_tier, to_tier, occupied)`. This replaces the
`if/elif` chain on `solution.source` / `last_src`, which already produced one silent bug
(see the scar comment in `_async_apply`) because every branch was unreachable.

| UI name | From → To | When | Setting |
|---|---|---|---|
| Occupancy | Clear (L0 **or L3**) → L1/L1S | room was clear, someone arrives | `transition_up_occupancy_s` (10 s) |
| Occupied Turn-On | L0 → L1/L1S | room *already* occupied, lights come up | `transition_up_occupied_on_s` (300 s) |
| Ambience Wake | Clear → L3 | gate opens: dark and awake, room clear | `transition_up_ambience_s` (60 s) |
| Diminish | L1 → L2 | other side of the room clears | `transition_down_diminish_s` (10 s) |
| Ambience Settle | L2 → L3 | dwell expires | `transition_down_ambience_s` (10 s) |
| Environmental / Off | L* → L0 | gate closes, or room empties | `transition_down_off_s` (20 s) |
| — | L2 → L1 | occupied side returns | **TBC — likely Occupancy** |
| Update L1 | L1 ↔ L1S, and same → same | value change, not a tier change | slew-rate derived |

⚠️ **Corrected 2026-09-15 from the live panel's own labels.** An earlier draft of this
table had a single "any → L3" row with a rising/falling flag. That was wrong twice over:

* There are **two distinct L3 entries**, not one with a direction — `Ambience Wake`
  (Clear → L3, 60 s) and `Ambience Settle` (L2 → L3, 10 s).
* There is **no L1 → L3 at all**. The path down is L1 → L2 → L3 as the dwell expires.

And **"Clear" is not L0.** With the ambience gate open a clear room rests at L3, not off.
That is why Brandon's grid row reads L3 → L2, L3 → L1 and L3 → L1S all as 10 — every one
of those is `Occupancy` firing from the resting state — and why his L3 → L0 = `x` is
right *as an occupancy path*: leaving ambience for off is driven by the gate closing
(daylight or asleep), which is the `Environmental / Off` row instead.

## Slew-rate transitions (replaces fixed `transition_automatic_s` for updates)

Today a 3-level nudge and a 150-level jump both get 300 s. Instead derive `T` from the
size of the shift so perceptual rate stays in a comfortable band, then clamp:

    T = clamp(delta_output / target_rate, min_update_s, max_update_s)

Small drift → short quiet fade. Storm → the light moves now. `fade.rate()` and the
R-based framework already exist for colour; this is the brightness analogue.

### Filter state selects the transition

`AsymmetricFilter` already computes instant-attack on darkening and damped decay on
brightening, then that information is discarded. Attack state must select the fast
transition, decay state the slow one — otherwise a squall response still takes 5 minutes
to arrive.

## Deferred, never dropped

`should_suppress_chronic_write` and the in-flight dead-zone guard currently `return`,
discarding the update until the next cycle. They must instead **park the latest target**
per fixture and flush it when the ramp lease expires. Same suppression, no lost updates,
and updates stop colliding with the 10 s turn-on ramp.

## Hardware invariants

These are load-bearing. Each is measured, not inferred.

1. **Never emit a bare `state: ON`.** A colour-only write reaches z2m as
   `{"state":"ON", "color_temp":X}` with no brightness, which z2m sends as a bare genOnOff
   `On`; the bulb then honours its own `OnLevel`/`OnTransitionTime` and jumps.
   Reproduced 2026-09-13 on `Kitchen Diner East`: off at level 4 → **76 → 152 in 4 s**.
   `on_level` is 152 on the desk and diner bulbs, 206 on Kitchen Sink West, 3 on the office
   corners. Every write must carry a level; the tier model gives this for free.
2. **IKEA: brightness always wins.** Measured 2026-08-12 — `Entry Ceiling` brightness
   90→40 over 600 s with concurrent colour **stalled at 84** for the whole window while a
   same-family control tracked exactly. The writer currently serialises *symmetrically*,
   so colour can win the race and brightness is dropped. Invert it: on IKEA, colour yields
   to brightness and is **discarded, not queued**. Those bulbs clamp at 4000 K anyway.
   (`may_run_concurrently`'s docstring asks for a confirming run before this hardens.)
3. **Colour never inherits the brightness transition.** The wake path puts `wake_kelvin`
   in the same service call as the level, so a 300 s wake gives colour R = 0.067 mired/s
   against `R_crit` 0.156. Measured 2026-09-13: colour crawled at 0.033 mired/s and was
   still 14 mired short after brightness arrived. Colour gets its own short transition.

## State verification

z2m `get` read-back is cheap and reliable (used ~12 times during the 2026-09-13
investigation). HA's state is z2m's *optimistic echo* and was caught wrong that day:
HA reported `light.living_office_w` on at brightness 100 while the hardware read
`onOff: 0, currentLevel: 1`, and Solace then went silent on the room for three hours
because every guard keys off that belief.

- Verify on every tier change.
- Slow background sweep for fixtures that have not been verified recently.
- On divergence, reconcile with an absolute write.

## Removals

- The continuous `solution.level` write path in `_async_apply`.
- The `source`/`last_src` transition ladder.
- Work Mode's `replace(solution, ..., should_write=True)` dead-zone bypass — Work Mode
  becomes an `L1` value provider, not a write forcer. That bypass is why the three office
  fixtures were the only ones in the house emitting an identical no-op write every 5.5
  minutes for hours.
- `StateTier.LS_NIGHT`.
