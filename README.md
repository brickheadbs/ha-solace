# Solace

A lighting **calculation engine** for Home Assistant, as a HACS custom integration.

Rooms are added inside the integration as config subentries — not one automation per
light. One outdoor lux sensor drives the whole house; everything else is a tunable.

> **v0.3, explicitly beta.** Two prior lighting systems in this house were built and torn
> down. This is the third attempt, and the name is reused deliberately while **none of the
> old code is**. Only independently re-verified findings carried forward.

## The rule that shapes everything

**Nothing is hardcoded.** Every number — gamma, the lux thresholds, every transition,
every bias, the debounces — is a helper with a starting value, stored in the config entry
so it survives restarts. A value that cannot be changed from the UI is a bug.

## Layout

| File | What it is |
|---|---|
| `engine.py` | The 17-step pipeline, lux → one bulb's level. **Pure** — no HA imports. |
| `colour.py` | House-wide colour curve, dusk-anchored, mired-interpolated. **Pure.** |
| `fade.py` | Output planner. Encodes the measured Zigbee rate limits. **Pure.** |
| `models.py` | Settings dataclasses. **Pure.** |
| `coordinator.py` | Two clocks, manual detection, the calculation loop. |
| `writer.py` | The **sole** writer to lights. Context stamping lives here. |
| `config_flow.py` | House entry + one subentry per room. |

The four pure modules are where the logic bugs live, and they are unit-tested with plain
pytest. Everything else is plumbing, covered by integration tests against a real HA.

```bash
python -m venv .venv && .venv/bin/pip install pytest homeassistant pytest-homeassistant-custom-component
.venv/bin/python -m pytest
```

## The pipeline

Order matters — several steps are only correct in this position.

```
 1 outdoor lux          10 diminish (kitchen only, a reduction that stays)
 2 ambient gate         11 occupancy / gate
 3 demand (log)         12 min cutoff
 4 mode + evening ramp  13 manual (wins over everything computed)
 5 bias (stops, additive) 14 CLAMP — per light, LAST, only when level > 0
 6 clip to full         15 rate limit (tracking only)
 7 level 0-254          16 dead zone
 8 night override       17 command + an explicit transition
 9 ambience floor
```

**Levels are 0-254 integers, never percent.** At 1 % a percent UI can only command 2.54,
and the 1-10 % band is where this house lives.

**Bias is in stops, added not multiplied.** One stop doubles the light. Additive means a
room dial moves everything while per-light offsets keep their relationship.

## Why brightness and colour use different mechanisms

This is measured hardware behaviour, not preference. Long **colour** transitions corrupt;
long **brightness** transitions do not. It is a rate limit:

```
R = Δ / T          R_crit(colour) ≈ 0.156 mired/s
```

Below that floor the bulb's fixed-point step accumulator underflows, it jumps to a
hardware rail and **stalls there permanently** with no error. Seven measured data points
separate perfectly on R, and the boundary brackets 1/64 mired per decisecond.

| Channel | Mechanism |
|---|---|
| **Brightness** | One long hardware `transition`. Verified linear to 40 minutes. |
| **Colour** | Small stepped absolutes — short fade, then hold. |

Two things that look like fixes and are not:

* **Chunking a slow glide does not help.** `R = Δ/T` is invariant under chunking.
* **`transition` = the step interval is wrong.** R comes from the step's own transition
  time. `{"color_temp": +5, "transition": 60}` underflows; over 4 s it does not.

🔴 **IKEA bulbs cannot run both channels at once** — a colour step froze an in-flight
brightness fade for 420 s against a clean control. Solace serialises them on that family.

## Traps this deliberately avoids

| Trap | What happens if you get it wrong |
|---|---|
| `context.user_id` for manual detection | A REST call with a long-lived token carries a `user_id` too. Every script looks like a human. Stamp your own context instead. |
| Exact attribute comparison | Bulbs echo back values that differ from what was commanded; the room locks into manual within a tick. Use thresholds. |
| Clamping before the zero check | Clamping 0 up to `clamp_min` leaves the room glowing at level 1 instead of off. |
| Rate-limiting on and off | Traced: light at 60, target 0, the limiter moved it *up* to 54. |
| Decimal clock comparisons | `23.5 < 6.5` is False. All clock windows run on `(clock - 18) % 24`. |
| Manual age with no touched flag | A fresh boot has age 0, which is always less than the hold window ⇒ manual forever. |
| `always_update=False` with a mutable data object | Identity comparison says "unchanged" every tick; every sensor freezes while the lights keep updating. |
| The default request-refresh debouncer | 10 s cooldown, not immediate — a slider does nothing, then snaps. |

## Not built yet

* **The Lit + TypeScript settings panel.** The `number` entities are the interim control
  surface and write the same config entry the panel will.
* **Cutover.** Removing the live blueprint automations is a behaviour change to a working
  house and is gated on an explicit go-ahead.
