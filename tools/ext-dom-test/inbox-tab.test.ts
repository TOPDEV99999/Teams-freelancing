import { keepInboxTab, type TabLike } from "../../ext-workana/src/inboxTab";

let nextId = 100;
let tabs: TabLike[] = [];
const api = {
  query: async (q: { pinned?: boolean }) => tabs.filter((t) => q.pinned === undefined || !!t.pinned === q.pinned),
  create: async (p: { url: string; pinned: boolean }) => {
    // Workana redirects /inbox to the latest conversation.
    const t = { id: nextId++, url: "https://www.workana.com/inbox/backend-senior-data-engineer/sample-freelancer", pinned: p.pinned };
    tabs.push(t);
    return t;
  },
  remove: async (ids: number[]) => { tabs = tabs.filter((t) => !ids.includes(t.id!)); },
  reload: async () => undefined,
};
const fails: string[] = [];
const ok = (name: string, cond: boolean, detail = "") => { if (!cond) fails.push(`${name} ${detail}`); console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

(async () => {
  // A: 30 minute ticks + extra forced checks -> exactly one pinned tab.
  let st = { inboxTabId: null as number | null, refreshedAt: 0 };
  for (let m = 0; m < 30; m++) {
    const r = await keepInboxTab(api, { watchInbox: true, taskRunning: false, inboxTabId: st.inboxTabId, jobTabId: null,
      refreshedAt: st.refreshedAt, force: m % 7 === 0, now: m * 60000, dueMs: 240000, inboxUrl: "https://www.workana.com/inbox" });
    st = { inboxTabId: r.inboxTabId, refreshedAt: r.refreshedAt };
  }
  ok("redirected inbox: still exactly one pinned tab after 30 minutes", tabs.filter((t) => t.pinned).length === 1, JSON.stringify(tabs));

  // B: the duplicates left by 1.3.3 are closed; your own pinned Workana tab and the inbox-job tab stay.
  tabs = [
    ...Array.from({ length: 25 }, (_, i) => ({ id: i + 1, pinned: true, url: `https://www.workana.com/inbox/p${i}/me` })),
    { id: 900, pinned: true, url: "https://www.workana.com/jobs?category=it" },
    { id: 901, pinned: false, url: "https://www.workana.com/inbox/job-tab/me" },
    { id: 902, pinned: true, url: "https://www.workana.com/inbox/reading-now/me" },
  ];
  const r = await keepInboxTab(api, { watchInbox: true, taskRunning: false, inboxTabId: null, jobTabId: 902, refreshedAt: 0,
    force: false, now: 1e9, dueMs: 240000, inboxUrl: "https://www.workana.com/inbox" });
  const pinnedInbox = tabs.filter((t) => t.pinned && /\/inbox/.test(t.url!));
  ok("25 duplicates -> 1 kept (+ the tab of a running inbox job)", pinnedInbox.length === 2 && r.closed === 24, `${pinnedInbox.length} ${r.closed}`);
  ok("your own pinned Workana tab is left alone", tabs.some((t) => t.id === 900));
  ok("normal (unpinned) tabs are left alone", tabs.some((t) => t.id === 901));

  // C: switched off -> no new tab, but duplicates are still cleaned.
  tabs = [{ id: 1, pinned: true, url: "https://www.workana.com/inbox/a/me" }, { id: 2, pinned: true, url: "https://www.workana.com/inbox/b/me" }];
  const c = await keepInboxTab(api, { watchInbox: false, taskRunning: false, inboxTabId: 1, jobTabId: null, refreshedAt: 0,
    force: false, now: 0, dueMs: 1, inboxUrl: "https://www.workana.com/inbox" });
  ok("watcher off: duplicates closed, nothing opened", tabs.length === 1 && !c.created);
  tabs = [];
  const d = await keepInboxTab(api, { watchInbox: false, taskRunning: false, inboxTabId: null, jobTabId: null, refreshedAt: 0,
    force: false, now: 0, dueMs: 1, inboxUrl: "https://www.workana.com/inbox" });
  ok("watcher off: never opens a tab", tabs.length === 0 && !d.created);
  console.log(fails.length ? `${fails.length} FAILED` : "all passed");
  process.exit(fails.length ? 1 : 0);
})();
