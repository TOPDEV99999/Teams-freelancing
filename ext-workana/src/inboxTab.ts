/**
 * The ONE pinned Workana tab the watcher keeps open (its header menus carry the conversation list and the
 * notifications). It is identified by its tab id: Workana redirects /inbox to the latest conversation
 * (/inbox/<project>/<you>), so the address cannot identify it. Version 1.3.3 and older looked for the exact
 * /inbox address, never found its own tab after the redirect and opened a new pinned tab every minute -
 * this also closes those duplicates.
 */
export interface TabLike { id?: number; url?: string; pinned?: boolean; active?: boolean }
export interface TabsApi {
  query(q: { pinned?: boolean; url?: string }): Promise<TabLike[]>;
  create(p: { url: string; active: boolean; pinned: boolean }): Promise<TabLike>;
  remove(ids: number[]): Promise<void>;
  reload(id: number): Promise<void>;
}
export interface KeepState {
  watchInbox: boolean;
  taskRunning: boolean; // a proposal is being filled: don't open tabs now
  inboxTabId?: number | null;
  jobTabId?: number | null; // tab of a dashboard inbox job (never closed here)
  refreshedAt: number;
  force: boolean;
  now: number;
  dueMs: number;
  inboxUrl: string;
}
export interface KeepResult { inboxTabId: number | null; refreshedAt: number; created: boolean; closed: number; reloaded: boolean }

const isInboxUrl = (u?: string) => /^https:\/\/www\.workana\.com\/(?:[a-z]{2}\/)?inbox(?:[/?#]|$)/.test(u ?? "");

export async function keepInboxTab(tabs: TabsApi, st: KeepState): Promise<KeepResult> {
  const out: KeepResult = { inboxTabId: st.inboxTabId ?? null, refreshedAt: st.refreshedAt, created: false, closed: 0, reloaded: false };
  const pinned = (await tabs.query({ pinned: true, url: "https://www.workana.com/*" })).filter((t) => t.id !== undefined);
  const keep = pinned.find((t) => t.id === st.inboxTabId) ?? pinned.find((t) => isInboxUrl(t.url)) ?? null;
  // Duplicates: other pinned Workana inbox tabs (pinned tabs on other Workana pages are yours - left alone).
  const extras = pinned.filter((t) => t.id !== keep?.id && t.id !== st.jobTabId && isInboxUrl(t.url)).map((t) => t.id!);
  if (extras.length) {
    await tabs.remove(extras).catch(() => undefined);
    out.closed = extras.length;
  }
  if (!st.watchInbox) return out;
  if (!keep) {
    if (st.taskRunning) return out;
    const t = await tabs.create({ url: st.inboxUrl, active: false, pinned: true });
    out.inboxTabId = t.id ?? null;
    out.refreshedAt = st.now;
    out.created = true;
    return out;
  }
  out.inboxTabId = keep.id!;
  if (keep.active && !st.force) return out; // you are looking at it
  if (st.force || st.now - st.refreshedAt > st.dueMs) {
    out.refreshedAt = st.now;
    await tabs.reload(keep.id!).catch(() => undefined);
    out.reloaded = true;
  }
  return out;
}
