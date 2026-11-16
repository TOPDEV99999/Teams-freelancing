import { useEffect, useRef, useState } from "react";
import { ago, api, parseDate, type HubStatus } from "./api";
import { Countdown, Icon, Light, Switch, ThemeToggle, Toasts } from "./components";
import NotifyHelper from "./NotifyHelper";
import { useStore } from "./store";
import JobsPage from "./pages/JobsPage";
import AccountsPage from "./pages/AccountsPage";
import StatsPage from "./pages/StatsPage";
import SettingsPage from "./pages/SettingsPage";
import LogsPage from "./pages/LogsPage";
import FetcherPage from "./pages/FetcherPage";
import PromptsPage from "./pages/PromptsPage";
import InboxPage from "./pages/InboxPage";
import DataPage from "./pages/DataPage";
import ActivityButton from "./ActivityPanel";

const PAGES = [
  { key: "jobs", label: "Jobs", icon: "jobs" },
  { key: "inbox", label: "Inbox", icon: "inbox" },
  { key: "fetcher", label: "Fetcher", icon: "fetcher" },
  { key: "prompts", label: "Prompts", icon: "prompts" },
  { key: "accounts", label: "Accounts", icon: "accounts" },
  { key: "stats", label: "Stats", icon: "stats" },
  { key: "settings", label: "Settings", icon: "settings" },
  { key: "data", label: "Data", icon: "database" },
  { key: "logs", label: "Logs", icon: "logs" },
] as const;
type PageKey = (typeof PAGES)[number]["key"];

function readHash(): PageKey {
  const h = location.hash.replace(/^#\/?/, "").split("/")[0];
  return (PAGES.find((p) => p.key === h)?.key ?? "jobs") as PageKey;
}

const older = (v: string | undefined, want: string) => {
  if (!v || v === "sim" || v === "test") return false;
  const a = v.split(".").map(Number), b = want.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
};

/** Polls /api/status: live generation state + detects that a newer hub/dashboard is running. */
function useHubStatus(wsConnected: boolean) {
  const [st, setSt] = useState<HubStatus | null>(null);
  const firstBuild = useRef<string | null>(null);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.status();
        if (!alive) return;
        setSt(s);
        if (firstBuild.current === null) firstBuild.current = s.build;
        else if (s.build !== firstBuild.current) setStale(true);
      } catch { /* hub offline: the live dot already says so */ }
    };
    tick();
    const t = window.setInterval(tick, 3000);
    return () => { alive = false; window.clearInterval(t); };
  }, [wsConnected]);
  return { st, stale };
}

export default function App() {
  const [page, setPage] = useState<PageKey>(readHash);
  const { ext, accounts, jobs, wsConnected, notifyEnabled, setNotifyEnabled, upsertAccount, toast, notices, counters,
    msgNotify, setMsgNotify } = useStore();
  const { st, stale } = useHubStatus(wsConnected);

  useEffect(() => {
    const h = () => setPage(readHash());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);

  const accountList = Object.values(accounts).sort((a, b) => a.id.localeCompare(b.id));
  const paused = accountList.filter((a) => a.paused);
  const newCount = Object.values(jobs).filter((j) => j.status === "new").length;
  const want = st?.expected_ext_version ?? "";
  const wantGpt = st?.expected_chatgpt_version ?? want;
  const gen = st?.generation;
  const genQueued = gen?.queued.length ?? 0;
  const genJob = gen?.current ? jobs[gen.current] : undefined;
  const unread = notices.filter((n) => !n.read).length;
  const busyCount = (gen?.current ? 1 : 0) + genQueued + (st?.active_submissions ?? 0);

  const resume = async (id: string) => {
    try { upsertAccount(await api.resumeAccount(id)); toast(`${id} resumed`, "ok"); }
    catch (e) { toast((e as Error).message); }
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-surface">
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-[0_4px_12px_-4px_rgb(99_102_241/0.7),inset_0_1px_0_rgb(255_255_255/0.3)]">
            <Icon name="spark" className="h-5 w-5" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">Workana</div>
            <div className="text-[11px] text-slate-500">Proposal Assistant</div>
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2.5 py-2">
          {PAGES.map((p) => {
            const active = page === p.key;
            return (
              <a key={p.key} href={`#/${p.key}`}
                className={`group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all duration-150 active:scale-[0.97]
                  ${active ? "bg-indigo-50 font-semibold text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"}`}>
                <span className={`absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-indigo-500 transition-all duration-200 ${active ? "opacity-100" : "scale-y-0 opacity-0"}`} />
                <Icon name={p.icon} className={`h-[18px] w-[18px] transition-transform duration-200 group-hover:scale-110 ${active ? "text-indigo-600" : "text-slate-400 group-hover:text-slate-600"}`} />
                {p.label}
                {p.key === "jobs" && newCount > 0 && (
                  <span className="ml-auto rounded-full bg-indigo-500 px-1.5 text-[10px] font-semibold leading-4 text-white tabular-nums">{newCount}</span>
                )}
                {p.key === "inbox" && unread > 0 && (
                  <span className="ml-auto rounded-full bg-rose-500 px-1.5 text-[10px] font-semibold leading-4 text-white tabular-nums">{unread}</span>
                )}
              </a>
            );
          })}
        </nav>
        <div className="mt-auto space-y-3 border-t border-slate-200 p-3">
          <Switch checked={notifyEnabled} onChange={setNotifyEnabled}
            label={<span className="flex items-center gap-1.5 text-xs text-slate-600"><Icon name="bell" className="h-3.5 w-3.5" />Notify new jobs</span>} />
          <Switch checked={msgNotify} onChange={setMsgNotify}
            label={<span className="flex items-center gap-1.5 text-xs text-slate-600"><Icon name="inbox" className="h-3.5 w-3.5" />Notify Workana messages</span>} />
          <NotifyHelper />
          <ThemeToggle />
          <div className={`flex items-center gap-2 text-xs font-medium ${wsConnected ? "text-emerald-700" : "text-rose-700"}`}>
            <span className="relative flex h-2 w-2">
              {wsConnected && <span className="ping-soft absolute h-full w-full rounded-full bg-emerald-400" />}
              <span className={`relative h-2 w-2 rounded-full ${wsConnected ? "bg-emerald-500" : "bg-rose-500"}`} />
            </span>
            {wsConnected ? "Live" : "Hub offline — reconnecting"}
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-surface px-4 py-2">
          <Light on={ext.chatgpt.connected} label="ChatGPT" outdated={older(ext.chatgpt.version, wantGpt)}
            title={older(ext.chatgpt.version, wantGpt) ? `extension ${ext.chatgpt.version} — reload it (expected ${wantGpt})` : undefined} />
          <span className="mx-1 h-4 w-px bg-slate-200" />
          {accountList.map((a) => {
            const info = ext.workana[a.id];
            const old = older(info?.version, want);
            return (
              <Light key={a.id} on={!!info?.connected} warn={a.paused} outdated={old}
                label={`${a.display_name || a.id}${(counters[a.id]?.messages ?? 0) + (counters[a.id]?.notifications ?? 0) > 0
                  ? ` · ${(counters[a.id]?.messages ?? 0) + (counters[a.id]?.notifications ?? 0)} unread` : ""}`}
                title={a.paused ? `paused: ${a.pause_reason}` : old ? `extension ${info?.version} — reload it in this profile (expected ${want})` : a.chrome_profile} />
            );
          })}
          <span className="ml-auto" />
          <FetcherChip f={st?.fetcher} />
          {gen && (gen.current || genQueued > 0) && (
            <span className="flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-800 animate-fade">
              <span className="relative flex h-2 w-2"><span className="ping-soft absolute h-full w-full rounded-full bg-amber-400" />
                <span className="relative h-2 w-2 rounded-full bg-amber-500" /></span>
              {gen.current
                ? <>ChatGPT writing for <b>{accounts[gen.current_account ?? ""]?.display_name ?? gen.current_account}</b>
                  {genJob && <span className="max-w-[16rem] truncate text-amber-700">· {genJob.title}</span>}</>
                : gen.next_at ? <>next prompt <Countdown until={gen.next_at} /></> : <>starting…</>}
              {genQueued > 0 && <span className="rounded-full bg-amber-100 px-1.5 font-semibold tabular-nums">+{genQueued}</span>}
            </span>
          )}
          <a href="#/inbox" title="Workana messages & notifications"
            className="relative flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-surface text-slate-500 hover:bg-slate-100 hover:text-slate-800">
            <Icon name="bell" className="h-4 w-4" />
            {unread > 0 && <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-rose-500 px-1 text-center text-[10px] font-bold leading-4 text-white tabular-nums">{unread}</span>}
          </a>
          <ActivityButton busyCount={busyCount} />
        </header>

        {stale && (
          <div className="flex items-center gap-3 border-b border-indigo-200 bg-indigo-50 px-4 py-2 text-sm text-indigo-800 animate-fade">
            <Icon name="refresh" className="h-4 w-4" />
            A newer version of the app is running. Reload this tab to use it.
            <button className="btn-primary ml-auto !py-1" onClick={() => location.reload()}>Reload</button>
          </div>
        )}
        {st?.urgent && (
          <div className="flex flex-wrap items-center gap-3 border-b border-orange-300 bg-orange-50 px-4 py-2 text-sm text-orange-900">
            <span className="text-lg">⚡</span>
            <span><b>Urgent:</b> “{st.urgent.title}” goes first. Other generations and sends are <b>paused</b> and continue
              automatically when its proposals are sent (ends by itself in <Countdown until={st.urgent.ends_at} /> at the latest).</span>
            <a className="btn-ghost !py-0.5" href={`#/jobs/${encodeURIComponent(st.urgent.job_id)}`}>Open job</a>
            <button className="btn-ghost !py-0.5" onClick={async () => {
              try { await api.endUrgent(); toast("Urgent mode ended - the previous order continues", "ok"); }
              catch (e) { toast((e as Error).message); }
            }}>End urgent mode</button>
          </div>
        )}
        {paused.length > 0 && (
          <div className="space-y-1 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
            {paused.map((a) => (
              <div key={a.id} className="flex items-center gap-3">
                <span>⚠️ <b>{a.display_name || a.id}</b> is paused (<code>{a.pause_reason}</code>). Fix it in that
                  browser profile (log in / solve the check / buy credits), then resume.</span>
                <button className="btn-ghost !py-0.5" onClick={() => resume(a.id)}>Resume</button>
              </div>
            ))}
          </div>
        )}

        <main key={page} className="min-h-0 flex-1 animate-fade overflow-hidden">
          {page === "jobs" && <JobsPage />}
          {page === "fetcher" && <FetcherPage />}
          {page === "prompts" && <PromptsPage />}
          {page === "accounts" && <AccountsPage />}
          {page === "stats" && <StatsPage />}
          {page === "settings" && <SettingsPage />}
          {page === "logs" && <LogsPage />}
          {page === "inbox" && <InboxPage />}
          {page === "data" && <DataPage />}
        </main>
      </div>
      <Toasts />
    </div>
  );
}


/** Always-visible proof that job fetching is alive: "Jobs checked 20s ago". */
function FetcherChip({ f }: { f?: HubStatus["fetcher"] }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((x) => x + 1), 5000); return () => window.clearInterval(t); }, []);
  if (!f) return null;
  const last = parseDate(f.last_run_at);
  const age = last ? (Date.now() - last.getTime()) / 1000 : Infinity;
  const state = !f.running ? { c: "bg-slate-300", t: "fetcher off (FETCHER in .env)" }
    : !f.enabled ? { c: "bg-slate-300", t: "fetcher stopped — Fetcher page → Start" }
      : f.busy ? { c: "bg-indigo-500", t: "checking Workana…" }
        : f.last_error ? { c: "bg-rose-500", t: `last check failed — ${f.last_error}` }
          : age > 300 ? { c: "bg-amber-400", t: `no check for ${ago(f.last_run_at)}` }
            : { c: "bg-emerald-500", t: `jobs checked ${ago(f.last_run_at)}` };
  return (
    <a href="#/fetcher" title={`${state.t}. ${f.total_new} new job(s) since start${f.restarts ? `, ${f.restarts} automatic restart(s)` : ""}.`}
      className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-surface px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100">
      <span className={`h-2 w-2 rounded-full ${state.c} ${f.busy ? "animate-pulse" : ""}`} />
      {f.running && f.enabled && !f.busy && last ? `Jobs · ${ago(f.last_run_at)}` : state.t.split(" — ")[0]}
    </a>
  );
}
