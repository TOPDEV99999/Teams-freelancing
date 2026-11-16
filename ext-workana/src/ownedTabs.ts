/**
 * Tabs this extension opened (bid forms, conversation reads) and when to close them.
 *
 * Closing used to rely on setTimeout in the service worker, but Chrome suspends idle service workers, so the
 * timer often never fired and tabs piled up. Now every tab is recorded with its closing time in storage, and a
 * periodic check (heartbeat + alarm, both survive suspension) closes whatever is due.
 */
export interface OwnedTab { kind: "submit" | "inbox"; openedAt: number; closeAt: number | null; failed?: boolean }
export type Owned = Record<string, OwnedTab>;

export const KEEP_FAILED_MS = 10 * 60 * 1000; // a failed bid's tab stays this long for you to look at
export const MAX_FAILED_OPEN = 3; // ...but never more than this many at once (oldest closes first)
export const QUICK_FAIL_MS = 15000; // nothing to look at (job closed / already bid): close soon
export const QUICK_FAIL_CODES = new Set(["job_closed", "already_bid"]);

export function register(owned: Owned, tabId: number, kind: OwnedTab["kind"], now: number): Owned {
  return { ...owned, [String(tabId)]: { kind, openedAt: now, closeAt: null } };
}

export function scheduleClose(owned: Owned, tabId: number, inMs: number, now: number, failed = false): Owned {
  const t = owned[String(tabId)];
  if (!t) return owned;
  return { ...owned, [String(tabId)]: { ...t, closeAt: now + inMs, failed } };
}

/** Which tabs to close now, and the registry without them (and without tabs that no longer exist). */
export function due(owned: Owned, now: number, openIds: Set<number>, protectedIds: Set<number>): { close: number[]; owned: Owned } {
  const live: Owned = {};
  for (const [k, v] of Object.entries(owned)) if (openIds.has(Number(k))) live[k] = v;
  const close = new Set<number>();
  for (const [k, v] of Object.entries(live)) {
    if (v.closeAt !== null && v.closeAt <= now && !protectedIds.has(Number(k))) close.add(Number(k));
  }
  // Too many failed tabs kept for inspection: close the oldest.
  const failed = Object.entries(live).filter(([k, v]) => v.failed && !close.has(Number(k)) && !protectedIds.has(Number(k)))
    .sort((a, b) => a[1].openedAt - b[1].openedAt);
  for (const [k] of failed.slice(0, Math.max(0, failed.length - MAX_FAILED_OPEN))) close.add(Number(k));
  for (const id of close) delete live[String(id)];
  return { close: [...close], owned: live };
}
