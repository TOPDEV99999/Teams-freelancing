/**
 * Workana submitter — service worker.
 * Receives `submit` from the hub (only commands for THIS profile's account reach us),
 * opens the job tab and drives the content script through the stages. The current task lives in
 * chrome.storage.local so it survives page navigations and worker restarts.
 */
import { HubClient, getLocal } from "../../ext-common/hubClient";
import { bidFormUrlFor, CLOSE_TAB_AFTER_SUCCESS, HUB_URL_DEFAULT, THREAD, TIMINGS, VERSION, WATCH } from "./config";
import type { ContentMsg, ErrorCode, Mode, Task } from "./types";

const MAX_PROCESSED = 500;

const client = new HubClient({
  role: "workana",
  version: VERSION,
  defaultUrl: HUB_URL_DEFAULT,
  registerExtras: async () => {
    const { accountId } = await getLocal("accountId");
    return accountId ? { account: accountId } : null;
  },
  onMessage: (msg) => {
    if (msg.type === "submit") void handleSubmit(msg);
    else if (msg.type === "cancel") void handleCancel(Number(msg.submission_id));
    else if (msg.type === "inbox_read" || msg.type === "inbox_send") void queueInboxJob(msg);
    else if (msg.type === "inbox_refresh") void refreshInbox(true);
  },
  onTick: () => { void checkDeadline(); void flushNotices(); void checkInboxJob(); },
});
client.start();

// ---------------------------------------------------------------- messages / notifications watcher
type Conv = { slug: string; url: string; name: string; snippet: string; unread: boolean };
type Notice = { kind: "message" | "notification"; key: string; title: string; body: string; url: string };

async function queueNotices(items: Notice[]) {
  if (!items.length) return;
  const { noticeOutbox = [] } = await getLocal("noticeOutbox");
  await chrome.storage.local.set({ noticeOutbox: [...noticeOutbox, ...items].slice(-200) });
  await flushNotices();
}

async function flushNotices() {
  if (!client.isOpen()) return;
  const { noticeOutbox = [] } = await getLocal("noticeOutbox");
  if (!noticeOutbox.length) return;
  if (client.send({ type: "notice", items: noticeOutbox })) await chrome.storage.local.set({ noticeOutbox: [] });
}

async function onCounters(c: { messages: number | null; notifications: number | null; title: number | null }, source: string) {
  const { counters: prev } = await getLocal("counters");
  await chrome.storage.local.set({ counters: { ...c, at: Date.now(), source } });
  client.send({ type: "counters", messages: c.messages, notifications: c.notifications, source });
  const before = prev?.notifications ?? null;
  const { bellWorks } = await getLocal("bellWorks");
  // When the bell list can be read, onBell() reports each notification with its real text instead.
  if (!bellWorks && c.notifications !== null && before !== null && c.notifications > before) {
    const n = c.notifications - before;
    await queueNotices([{
      kind: "notification", key: `notif:${Date.now()}`, url: "https://www.workana.com/",
      title: `${n} new Workana notification${n > 1 ? "s" : ""}`,
      body: `${c.notifications} unread in total - open Workana and click the bell to read ${n > 1 ? "them" : "it"}.`,
    }]);
  }
  // More unread messages than before: refresh the background inbox tab to read who wrote.
  const mb = prev?.messages ?? null;
  if (c.messages !== null && mb !== null && c.messages > mb) void refreshInbox(true);
}

const normText = (t: string) => t.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80);

/** Our own proposal shows up as the last line of a new inbox conversation - that is not a client message. */
async function isOwnText(snippet: string): Promise<boolean> {
  const { ownTexts = [] } = await getLocal("ownTexts");
  const n = normText(snippet).slice(0, 40);
  return !!n && (ownTexts as string[]).some((t) => t.startsWith(n) || n.startsWith(t.slice(0, 40)));
}

async function onConversations(items: Conv[], own?: string | null) {
  if (own && /^[A-Za-z0-9_\-]{2,120}$/.test(own)) await chrome.storage.local.set({ ownSlug: own });
  client.send({ type: "inbox_list", items: items.slice(0, 200) });
  const { seenConvs, watchSeeded } = await getLocal(["seenConvs", "watchSeeded"]);
  const seen: Record<string, string> = seenConvs ?? {};
  const fresh: Notice[] = [];
  for (const c of items) {
    const sig = c.snippet || c.name;
    const known = c.slug in seen;
    if (known && seen[c.slug] === sig) continue;
    seen[c.slug] = sig;
    // First run: remember everything, alert only for conversations that are unread right now.
    if (!watchSeeded && !c.unread) continue;
    if (c.unread || (watchSeeded && !(await isOwnText(c.snippet)))) {
      fresh.push({ kind: "message", key: `${c.slug}|${sig}`.slice(0, 300), title: c.name || "New message",
        body: c.snippet, url: c.url });
    }
  }
  await chrome.storage.local.set({ seenConvs: seen, watchSeeded: true, lastConvScan: { at: Date.now(), count: items.length } });
  await queueNotices(fresh);
}

/** Workana notifications (bell menu): each new one becomes a notice with its real text. */
async function onBell(items: { key: string; title: string; body: string }[]) {
  const { bellSeen = [], bellSeeded } = await getLocal(["bellSeen", "bellSeeded"]);
  const seen = new Set<string>(bellSeen as string[]);
  const fresh = items.filter((i) => i.key && !seen.has(i.key));
  for (const i of items) seen.add(i.key);
  await chrome.storage.local.set({ bellSeen: [...seen].slice(-400), bellSeeded: true, bellWorks: true });
  if (!bellSeeded || !fresh.length) return; // first read: remember what is already there, alert only for new ones
  await queueNotices(fresh.slice(0, 10).map((i) => ({
    kind: "notification" as const, key: i.key, title: i.title, body: i.body, url: "https://www.workana.com/users/notifications",
  })));
}

/** Keep one pinned Workana inbox tab in the background and refresh it now and then (popup option). */
async function refreshInbox(force = false) {
  const { watchInbox = true, task } = await getLocal(["watchInbox", "task"]);
  if (!watchInbox) return;
  const tabs = await chrome.tabs.query({ url: "https://www.workana.com/inbox*" });
  const tab = tabs.find((t) => !/\/inbox\/./.test(t.url ?? "")) ?? null;
  if (!tab) {
    if (task) return; // don't open tabs while a proposal is being filled
    await chrome.tabs.create({ url: WATCH.inboxUrl, active: false, pinned: true });
    return;
  }
  if (tab.active && !force) return; // you are looking at it
  const { inboxRefreshedAt = 0 } = await getLocal("inboxRefreshedAt");
  const due = WATCH.refreshMs * (0.75 + Math.random() * 0.5);
  if (force || Date.now() - inboxRefreshedAt > due) {
    await chrome.storage.local.set({ inboxRefreshedAt: Date.now() });
    if (tab.id !== undefined) await chrome.tabs.reload(tab.id).catch(() => undefined);
  }
}
// ---------------------------------------------------------------- dashboard inbox (read a conversation / send a reply)
type InboxJob = { id: string; op: "read" | "send"; slug: string; text?: string; tabId?: number; deadline?: number };

async function queueInboxJob(msg: any) {
  const slug = String(msg.slug ?? "");
  if (!/^[A-Za-z0-9_\-]{2,200}$/.test(slug)) {
    client.send({ type: "inbox_result", id: msg.id, ok: false, error: "invalid conversation id" });
    return;
  }
  const job: InboxJob = { id: String(msg.id), op: msg.type === "inbox_send" ? "send" : "read", slug,
    ...(msg.type === "inbox_send" ? { text: String(msg.text ?? "") } : {}) };
  const { inboxQueue = [] } = await getLocal("inboxQueue");
  await chrome.storage.local.set({ inboxQueue: [...inboxQueue, job].slice(-20) });
  await nextInboxJob();
}

async function nextInboxJob() {
  const { inboxJob, inboxQueue = [] } = await getLocal(["inboxJob", "inboxQueue"]);
  if (inboxJob || !inboxQueue.length) return;
  const [job, ...rest] = inboxQueue as InboxJob[];
  // Conversation address: /inbox/<project>/<your profile slug> (learned from the header's conversation list).
  const { ownSlug } = await getLocal("ownSlug");
  const url = `https://www.workana.com/inbox/${job.slug}${ownSlug ? `/${ownSlug}` : ""}`;
  const tab = await chrome.tabs.create({ url, active: false });
  await chrome.storage.local.set({ inboxQueue: rest, inboxJob: { ...job, tabId: tab.id, deadline: Date.now() + THREAD.jobTimeoutMs } });
}

async function finishInboxJob(result: Record<string, unknown>) {
  const { inboxJob } = await getLocal("inboxJob");
  if (!inboxJob) return;
  client.send({ type: "inbox_result", id: inboxJob.id, op: inboxJob.op, slug: inboxJob.slug, ...result });
  await chrome.storage.local.set({ inboxJob: null });
  if (inboxJob.tabId !== undefined) {
    const tabId = inboxJob.tabId;
    setTimeout(() => { chrome.tabs.remove(tabId).catch(() => undefined); }, result.ok ? 1500 : 8000);
  }
  setTimeout(() => { void nextInboxJob(); }, 2000 + Math.random() * 2000);
}

async function checkInboxJob() {
  const { inboxJob } = await getLocal("inboxJob");
  if (inboxJob && Date.now() > (inboxJob.deadline ?? 0)) {
    await finishInboxJob({ ok: false, error: "the conversation page did not answer in time" });
  } else if (!inboxJob) {
    await nextInboxJob();
  }
}

// ---------------------------------------------------------------- page-structure captures (to tune selectors)
async function wantsSnapshot(page: string): Promise<boolean> {
  if (!["job", "bidform", "inbox", "thread"].includes(page)) return false;
  const { snapshotted = {} } = await getLocal("snapshotted");
  const key = `${VERSION}:${page}`;
  if (snapshotted[key]) return false;
  await chrome.storage.local.set({ snapshotted: { ...snapshotted, [key]: Date.now() } });
  return true;
}

async function forwardSnapshot(msg: any) {
  const { snapLimiter = {} } = await getLocal("snapLimiter");
  const key = `${msg.page}:${String(msg.reason ?? "").slice(0, 20)}`;
  if (Date.now() - (snapLimiter[key] ?? 0) < 10 * 60 * 1000) return; // at most one per page type + reason every 10 min
  await chrome.storage.local.set({ snapLimiter: { ...snapLimiter, [key]: Date.now() } });
  client.send({ type: "snapshot", page: msg.page, path: msg.path, reason: msg.reason, outline: String(msg.outline ?? "").slice(0, 400000) });
}

chrome.alarms.create("inbox-watch", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "inbox-watch") void refreshInbox(); });

// ---------------------------------------------------------------- storage helpers
async function getTask(): Promise<Task | null> {
  const { task } = await getLocal("task");
  return task ?? null;
}
async function setTask(task: Task | null) {
  await chrome.storage.local.set({ task });
}

function today(): string {
  return new Date().toLocaleDateString("sv"); // YYYY-MM-DD local
}

async function markProcessed(id: string): Promise<boolean> {
  const { processed = [] } = await getLocal("processed");
  if ((processed as (string | number)[]).map(String).includes(id)) return false;
  await chrome.storage.local.set({ processed: [...processed, id].slice(-MAX_PROCESSED) });
  return true;
}

// ---------------------------------------------------------------- hub commands
/** The hub cancelled this submission: forget the task (the tab stays open; nothing else is clicked). */
async function handleCancel(sid: number) {
  const task = await getTask();
  if (task?.submission_id !== sid) return;
  await setTask(null);
  client.log(`submission #${sid} cancelled from the dashboard`, "info");
  try {
    await chrome.tabs.sendMessage(task.tabId, { kind: "cancelled", submission_id: sid });
  } catch { /* tab gone */ }
}

async function handleSubmit(msg: { submission_id: number; attempt?: string; job_id: string; url: string; text: string; price: number; days: number }) {
  const sid = Number(msg.submission_id);
  // A retried submission keeps its id, so de-duplicate per dispatch attempt (not per id).
  const key = msg.attempt ? `${sid}@${msg.attempt}` : String(sid);
  if (!(await markProcessed(key))) {
    client.log(`ignored duplicate submit #${sid}`, "warn");
    return;
  }
  const current = await getTask();
  if (current) {
    report(sid, "failed", "busy", `still working on submission #${current.submission_id}`);
    return;
  }
  if (!/^https:\/\/www\.workana\.com\//.test(msg.url)) {
    report(sid, "failed", "form_not_found", `refusing non-Workana URL: ${msg.url}`);
    return;
  }
  const { mode = "fill_only", ownTexts = [] } = (await getLocal(["mode", "ownTexts"])) as { mode?: Mode; ownTexts?: string[] };
  await chrome.storage.local.set({ ownTexts: [...ownTexts, normText(msg.text)].slice(-50) });
  // Straight to the proposal form (/messages/bid/<slug>); the job page is only used as a fallback.
  const tab = await chrome.tabs.create({ url: bidFormUrlFor(msg.job_id, msg.url) ?? msg.url, active: true });
  const task: Task = {
    submission_id: sid, job_id: msg.job_id, url: msg.url, text: msg.text, price: msg.price, days: msg.days,
    tabId: tab.id!, stage: "opening", mode, startedAt: Date.now(),
    deadline: Date.now() + (mode === "auto_submit" ? TIMINGS.autoSubmitDeadlineMs : TIMINGS.fillOnlyDeadlineMs),
  };
  await setTask(task);
  progress(sid, `opening the proposal form (${mode})`);
}

function progress(sid: number, stage: string) {
  client.send({ type: "progress", submission_id: sid, stage });
}

async function report(sid: number, status: "sent" | "failed", error?: ErrorCode, detail?: string) {
  const ok = client.send({ type: "result", submission_id: sid, status, ...(error ? { error } : {}), ...(detail ? { detail } : {}) });
  if (!ok) {
    // Hub offline: keep the result and resend on reconnect.
    const { outbox = [] } = await getLocal("outbox");
    await chrome.storage.local.set({ outbox: [...outbox, { sid, status, error, detail }] });
  }
  const { counter } = await getLocal("counter");
  const c = counter?.date === today() ? counter : { date: today(), count: 0 };
  if (status === "sent") c.count += 1;
  await chrome.storage.local.set({
    counter: c,
    lastResult: { submission_id: sid, status, error: error ?? null, detail: detail ?? null, at: Date.now() },
  });
  const task = await getTask();
  if (task?.submission_id === sid) {
    await setTask(null);
    // Verified sends: close the job tab after a moment (failed / cancelled tabs stay open for you to look at).
    if (status === "sent" && CLOSE_TAB_AFTER_SUCCESS) {
      const tabId = task.tabId;
      setTimeout(() => { chrome.tabs.remove(tabId).catch(() => undefined); }, TIMINGS.closeTabDelayMs);
    }
  }
}

async function flushOutbox() {
  if (!client.isOpen()) return;
  const { outbox = [] } = await getLocal("outbox");
  if (!outbox.length) return;
  const rest = [];
  for (const r of outbox) {
    const sent = client.send({ type: "result", submission_id: r.sid, status: r.status, ...(r.error ? { error: r.error } : {}), ...(r.detail ? { detail: r.detail } : {}) });
    if (!sent) rest.push(r);
  }
  await chrome.storage.local.set({ outbox: rest });
}

async function checkDeadline() {
  await flushOutbox();
  const task = await getTask();
  if (task && Date.now() > task.deadline) {
    await report(task.submission_id, "failed", "timeout",
      task.stage === "filled" ? "form was filled but no verified submission before the deadline" : `stuck at stage '${task.stage}'`);
  }
}

// ---------------------------------------------------------------- content script channel
chrome.runtime.onMessage.addListener((msg: ContentMsg | { kind: string; [k: string]: any }, sender, sendResponse) => {
  (async () => {
    const task = await getTask();
    switch (msg.kind) {
      case "hello": {
        // Only the tab we opened for the current task gets instructions.
        const mine = task && sender.tab?.id === task.tabId;
        const { inboxJob } = await getLocal("inboxJob");
        if (inboxJob && sender.tab?.id === inboxJob.tabId) {
          sendResponse({ task: null, inboxJob });
          return;
        }
        sendResponse({ task: mine ? task : null, snapshot: await wantsSnapshot(String((msg as any).page ?? "")) });
        return;
      }
      case "inbox_result": {
        const { inboxJob } = await getLocal("inboxJob");
        if (inboxJob && inboxJob.id === (msg as any).id && sender.tab?.id === inboxJob.tabId) {
          const { kind: _k, id: _i, ...rest } = msg as any;
          await finishInboxJob(rest);
        }
        sendResponse({ ok: true });
        return;
      }
      case "snapshot":
        await forwardSnapshot(msg);
        sendResponse({ ok: true });
        return;
      case "stage": {
        if (task && task.submission_id === (msg as any).submission_id) {
          await setTask({ ...task, stage: (msg as any).stage });
        }
        sendResponse({ ok: true });
        return;
      }
      case "progress":
        progress((msg as any).submission_id, (msg as any).text);
        sendResponse({ ok: true });
        return;
      case "result": {
        const m = msg as Extract<ContentMsg, { kind: "result" }>;
        if (task && task.submission_id === m.submission_id) await report(m.submission_id, m.status, m.error, m.detail);
        sendResponse({ ok: true });
        return;
      }
      case "counters":
        await onCounters(msg as any, sender.tab?.url?.includes("/inbox") ? "inbox" : "tab");
        sendResponse({ ok: true });
        return;
      case "conversations":
        await onConversations((msg as any).items ?? [], (msg as any).own);
        sendResponse({ ok: true });
        return;
      case "bell":
        await onBell((msg as any).items ?? []);
        sendResponse({ ok: true });
        return;
      case "check_now": {
        await refreshInbox(true);
        const tabs = await chrome.tabs.query({ url: "https://www.workana.com/*" });
        let report: any = null;
        for (const t of tabs) {
          try { report = await chrome.tabs.sendMessage(t.id!, { kind: "scan_now" }); if (report) break; } catch { /* not ready */ }
        }
        sendResponse({ ok: true, report, tabs: tabs.length });
        return;
      }
      // ---- popup actions
      case "reconnect":
        client.reconnectNow();
        sendResponse({ ok: true });
        return;
      case "manual_result": {
        // Human override from the popup when page verification can't confirm (e.g. selectors outdated).
        if (task) await report(task.submission_id, msg.status, msg.status === "failed" ? "manual" : undefined,
          msg.status === "sent" ? "confirmed manually in popup" : "marked failed manually in popup");
        sendResponse({ ok: true });
        return;
      }
    }
    sendResponse({ ok: false });
  })();
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { inboxJob } = await getLocal("inboxJob");
  if (inboxJob && inboxJob.tabId === tabId) await finishInboxJob({ ok: false, error: "the conversation tab was closed" });
  const task = await getTask();
  if (task && task.tabId === tabId) {
    await report(task.submission_id, "failed", "timeout", "job tab was closed before the submission was verified — check Workana manually");
  }
});
