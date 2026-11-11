/**
 * Zero-dependency card ordering helper for Home and Lighting tabs.
 * Inert when `reorderMode` is false (zero listeners, zero DOM wrappers).
 */

import { css } from "lit";

export function applyOrder<T>(
  items: T[],
  getId: (item: T) => string,
  saved?: string[]
): T[] {
  if (!saved || !saved.length) return items;
  const rank = new Map<string, number>();
  saved.forEach((id, idx) => rank.set(id, idx));
  return [...items].sort((a, b) => {
    const ra = rank.get(getId(a));
    const rb = rank.get(getId(b));
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0;
  });
}

export function moveItem(ids: string[], fromId: string, toId: string): string[] {
  if (fromId === toId) return ids;
  const fromIdx = ids.indexOf(fromId);
  const toIdx = ids.indexOf(toId);
  if (fromIdx === -1 || toIdx === -1) return ids;
  const next = [...ids];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return next;
}

export function nudgeItem(ids: string[], id: string, delta: -1 | 1): string[] {
  const idx = ids.indexOf(id);
  if (idx === -1) return ids;
  const targetIdx = idx + delta;
  if (targetIdx < 0 || targetIdx >= ids.length) return ids;
  const next = [...ids];
  const [moved] = next.splice(idx, 1);
  next.splice(targetIdx, 0, moved);
  return next;
}

export const reorderStyles = css`
  .reorder-shell {
    position: relative;
    transition: transform 0.14s ease, outline-color 0.14s ease;
  }
  .reorder-shell.reorder-armed {
    outline: 1px dashed rgba(86, 182, 194, 0.45);
    border-radius: var(--sol-r-card, 14px);
    cursor: grab;
  }
  .reorder-shell.drag-over {
    outline: 2px solid var(--sol-cyan);
    transform: scale(0.992);
  }
  .reorder-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 5px 12px;
    margin-bottom: 6px;
    background: rgba(86, 182, 194, 0.12);
    border: 1px solid rgba(86, 182, 194, 0.3);
    border-radius: 9px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: var(--sol-cyan);
    user-select: none;
  }
  .reorder-grip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .reorder-grip ha-icon {
    --mdc-icon-size: 15px;
  }
  .reorder-arrows {
    display: inline-flex;
    gap: 4px;
  }
  .reorder-btn {
    border: 1px solid rgba(86, 182, 194, 0.35);
    background: var(--sol-card);
    color: var(--sol-cyan);
    border-radius: 6px;
    width: 24px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
  }
  .reorder-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .reorder-btn ha-icon {
    --mdc-icon-size: 14px;
  }
`;
