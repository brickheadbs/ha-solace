/**
 * Recorder history for the Home tab's sparklines.
 *
 * `history/history_during_period` answers with a `result` message keyed by entity id,
 * in HA's *compressed* state format — `{"s": "<state>", "lu": <epoch seconds>}` — because
 * the backend passes `compressed_state_format=True`. Verified against the live instance
 * (HA 2026.x, `homeassistant/components/history/websocket_api.py`); it is not the
 * `{entity_id, state, last_changed}` shape the REST endpoint returns.
 *
 * Samples are irregular in time: the recorder stores changes, not a fixed cadence. Every
 * consumer here therefore carries timestamps through and lets the sparkline resample,
 * rather than treating the array index as an axis.
 */

import type { Hass } from "./api";

export interface Sample {
  /** Epoch milliseconds. */
  t: number;
  v: number;
}

interface CompressedState {
  s?: string;
  lu?: number;
}

interface CacheEntry {
  at: number;
  data: Map<string, Sample[]>;
}

/** One fetch per minute is plenty — the cards themselves re-render every second. */
const TTL_MS = 60_000;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Map<string, Sample[]>>>();

const parse = (raw: unknown): Map<string, Sample[]> => {
  const out = new Map<string, Sample[]>();
  if (!raw || typeof raw !== "object") return out;

  for (const [entityId, rows] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue;
    const samples: Sample[] = [];
    for (const row of rows as CompressedState[]) {
      const v = Number(row?.s);
      const lu = row?.lu;
      // `unknown` / `unavailable` states parse to NaN and must not become zeroes.
      if (!Number.isFinite(v) || typeof lu !== "number") continue;
      samples.push({ t: lu * 1000, v });
    }
    samples.sort((a, b) => a.t - b.t);
    out.set(entityId, samples);
  }
  return out;
};

/**
 * Fetch `hours` of history for `entityIds`, memoised for {@link TTL_MS}.
 *
 * Resolves to an empty map rather than rejecting: a sparkline is decoration on a card
 * whose live value comes from `hass.states`, so a recorder hiccup must not blank the card.
 */
export async function fetchHistory(
  hass: Hass,
  entityIds: string[],
  hours = 24
): Promise<Map<string, Sample[]>> {
  const ids = [...entityIds].filter(Boolean).sort();
  if (!ids.length) return new Map();

  const key = `${hours}|${ids.join(",")}`;
  const now = Date.now();

  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.data;

  const pending = inflight.get(key);
  if (pending) return pending;

  const start = new Date(now - hours * 3_600_000).toISOString();
  const request = (async () => {
    try {
      const send = hass.callWS
        ? hass.callWS.bind(hass)
        : hass.connection.sendMessagePromise.bind(hass.connection);
      const raw = await send<unknown>({
        type: "history/history_during_period",
        start_time: start,
        entity_ids: ids,
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      const data = parse(raw);
      cache.set(key, { at: Date.now(), data });
      return data;
    } catch {
      // Keep the last good answer if there is one; otherwise an empty map.
      return hit?.data ?? new Map<string, Sample[]>();
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, request);
  return request;
}
