import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Account, type ExtStatus, type Job, type LogEvent, type Notice, type Submission, type WatchCounters } from "./api";

type Listener = (type: string, data: any) => void;

interface Store {
  jobs: Record<string, Job>;
  accounts: Record<string, Account>;
  ext: ExtStatus;
  logs: LogEvent[];
  wsConnected: boolean;
  reloadAccounts: () => Promise<void>;
  upsertJob: (j: Job) => void;
  upsertAccount: (a: Account) => void;
  subscribe: (fn: Listener) => () => void;
  toast: (msg: string, kind?: "error" | "ok") => void;
  toasts: { id: number; msg: string; kind: "error" | "ok" }[];
  notifyEnabled: boolean;
  setNotifyEnabled: (v: boolean) => void;
  /** Workana messages / notifications (Inbox page). */
  notices: Notice[];
  setNotices: (fn: (n: Notice[]) => Notice[]) => void;
  counters: Record<string, WatchCounters>;
  msgNotify: boolean;
  setMsgNotify: (v: boolean) => void;
  reloadAll: () => Promise<void>;
}

const Ctx = createContext<Store | null>(null);
export const useStore = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("StoreProvider missing");
  return s;
};

function mergeJob(old: Job | undefined, nu: Job): Job {
  if (!old) return nu;
  // Queue ETA fields (not_before / blocked) only come with submission_updated events: keep them.
  const keep = (x: Submission) => ({ ...(old.submissions ?? []).find((o) => o.id === x.id), ...x }) as Submission;
  const submissions = (nu.submissions ?? old.submissions ?? []).map(keep);
  const submission = nu.submission ? keep(nu.submission) : null;
  return { ...old, ...nu, submissions, submission };
}

export function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.35);
  } catch { /* audio blocked */ }
}

function readNotifyPref(key = "notify", dflt = false): boolean {
  try { const v = localStorage.getItem(key); return v === null ? dflt : v === "1"; } catch { return dflt; }
}

function chime() {
  // Two soft notes: different from the single "new job" beep.
  try {
    const ctx = new AudioContext();
    [660, 990].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.32);
    });
  } catch { /* audio blocked */ }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [accounts, setAccounts] = useState<Record<string, Account>>({});
  const [ext, setExt] = useState<ExtStatus>({ chatgpt: { connected: false }, workana: {} });
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: "error" | "ok" }[]>([]);
  const [notifyEnabled, setNotifyState] = useState(() => readNotifyPref("notify", true));
  const [msgNotify, setMsgNotifyState] = useState(() => readNotifyPref("notifyMessages", true));
  const [notices, setNotices] = useState<Notice[]>([]);
  const [counters, setCounters] = useState<Record<string, WatchCounters>>({});
  const msgNotifyRef = useRef(msgNotify);
  msgNotifyRef.current = msgNotify;
  const listeners = useRef(new Set<Listener>());
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const notifyRef = useRef(notifyEnabled);
  notifyRef.current = notifyEnabled;

  const toast = useCallback((msg: string, kind: "error" | "ok" = "error") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);

  const setNotifyEnabled = useCallback((v: boolean) => {
    setNotifyState(v);
    try { localStorage.setItem("notify", v ? "1" : "0"); } catch { /* ignore */ }
    if (v && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
  }, []);

  const setMsgNotify = useCallback((v: boolean) => {
    setMsgNotifyState(v);
    try { localStorage.setItem("notifyMessages", v ? "1" : "0"); } catch { /* ignore */ }
    if (v && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
  }, []);

  const upsertJob = useCallback((j: Job) => setJobs((m) => ({ ...m, [j.id]: mergeJob(m[j.id], j) })), []);
  const upsertAccount = useCallback(
    (a: Account) => setAccounts((m) => ({ ...m, [a.id]: { ...(m[a.id] ?? {}), ...a } })), []);

  const reloadAccounts = useCallback(async () => {
    const list = await api.accounts();
    setAccounts(Object.fromEntries(list.map((a) => [a.id, a])));
  }, []);

  const reloadAll = useCallback(async () => {
    try {
      const [jl, , lg, st, nt] = await Promise.all([api.jobs(), reloadAccounts(), api.logs(), api.status(),
        api.notices().catch(() => ({ items: [] as Notice[], counters: {} }))]);
      setJobs(Object.fromEntries(jl.map((j) => [j.id, j])));
      setLogs(lg);
      setExt(st.extensions);
      setNotices(nt.items);
      setCounters(nt.counters ?? {});
      if (!st.secret_configured) toast("HUB_SHARED_SECRET is not set in .env — extensions cannot connect.");
    } catch (e) {
      toast(`Could not load data: ${(e as Error).message}`);
    }
  }, [reloadAccounts, toast]);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => { listeners.current.delete(fn); };
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let timer: number | undefined;

    const handle = (type: string, data: any) => {
      switch (type) {
        case "job_new": {
          upsertJob(data);
          const acc = data.assigned_account_id ? accountsRef.current[data.assigned_account_id] : null;
          if (notifyRef.current) {
            beep();
            if ("Notification" in window && Notification.permission === "granted") {
              const n = new Notification(acc ? `New job for ${acc.display_name || acc.id}` : "New Workana job",
                { body: `${data.title}\n${data.budget_text || ""}`, tag: `job-${data.id}` });
              n.onclick = () => { window.focus(); location.hash = `#/jobs/${encodeURIComponent(data.id)}`; };
            }
          }
          break;
        }
        case "job_updated":
          upsertJob(data);
          break;
        case "drafts_ready":
          upsertJob({ ...data, drafts: undefined, drafts_by_account: undefined, draft_count: data.drafts?.length ?? 0 });
          break;
        case "submission_updated":
          setJobs((m) => {
            const j = m[data.job_id];
            if (!j) return m;
            const subs = j.submissions ?? [];
            const i = subs.findIndex((x) => x.id === data.id);
            const merged = { ...(i >= 0 ? subs[i] : {}), ...data } as Submission;
            const submissions = i >= 0 ? subs.map((x, k) => (k === i ? merged : x)) : [...subs, merged];
            const submission = data.account_id === j.assigned_account_id ? merged : j.submission;
            return { ...m, [j.id]: { ...j, submissions, submission } };
          });
          break;
        case "submission_deleted":
          setJobs((m) => {
            const j = m[data.job_id];
            if (!j) return m;
            const submissions = (j.submissions ?? []).filter((x) => x.id !== data.id);
            return { ...m, [j.id]: { ...j, submissions, submission: j.submission?.id === data.id ? null : j.submission } };
          });
          break;
        case "account_updated":
          upsertAccount(data);
          break;
        case "account_deleted":
          setAccounts((m) => { const c = { ...m }; delete c[data.id]; return c; });
          break;
        case "ext_status":
          setExt(data);
          break;
        case "log":
          setLogs((l) => [data, ...l].slice(0, 500));
          break;
        case "logs_cleared":
          if (!data?.older_than_days) setLogs([]);
          else api.logs().then(setLogs).catch(() => undefined);
          break;
        case "jobs_deleted":
          setJobs((m) => { const c = { ...m }; for (const id of data.ids ?? []) delete c[id]; return c; });
          break;
        case "reload":
          reloadAll();
          break;
        case "notice_new": {
          setNotices((n) => [data, ...n.filter((x) => x.id !== data.id)].slice(0, 500));
          const acc = data.account_id ? accountsRef.current[data.account_id] : null;
          const who = acc ? acc.display_name || acc.id : "Workana";
          toast(`${data.kind === "notification" ? "🔔" : "💬"} ${who}: ${data.title}${data.body ? ` — ${data.body.slice(0, 90)}` : ""}`, "ok");
          if (msgNotifyRef.current) {
            chime();
            if ("Notification" in window && Notification.permission === "granted") {
              const n = new Notification(`${data.kind === "notification" ? "Workana notification" : "Workana message"} · ${who}`,
                { body: `${data.title}${data.body ? `\n${data.body.slice(0, 180)}` : ""}`, tag: `notice-${data.id}` });
              n.onclick = () => { window.focus(); location.hash = "#/inbox"; };
            }
          }
          break;
        }
        case "notice_updated":
          setNotices((n) => n.map((x) => (x.id === data.id ? data : x)));
          break;
        case "notices_read":
          setNotices((n) => n.map((x) => (data.all || (data.ids ?? []).includes(x.id) ? { ...x, read: data.read !== false } : x)));
          break;
        case "notices_cleared":
          api.notices().then((r) => setNotices(r.items)).catch(() => undefined);
          break;
        case "counters": {
          const { account_id, ...c } = data;
          setCounters((m) => ({ ...m, [account_id]: c }));
          break;
        }
      }
      listeners.current.forEach((fn) => fn(type, data));
    };

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/ui`);
      ws.onopen = () => {
        attempt = 0;
        setWsConnected(true);
        reloadAll(); // catch up on anything missed while disconnected
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          handle(msg.type, msg.data);
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        setWsConnected(false);
        if (stopped) return;
        const delay = [1000, 2000, 5000, 10000][Math.min(attempt++, 3)];
        timer = window.setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, [reloadAll, upsertAccount, upsertJob, toast]);

  return (
    <Ctx.Provider value={{ jobs, accounts, ext, logs, wsConnected, reloadAccounts, upsertJob, upsertAccount,
      subscribe, toast, toasts, notifyEnabled, setNotifyEnabled, notices, setNotices, counters, msgNotify, setMsgNotify,
      reloadAll }}>
      {children}
    </Ctx.Provider>
  );
}
