import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ago, fmtBytes, type MaintStats, type Retention, type SettingsValues } from "../api";
import { ConfirmDanger, Icon, Switch } from "../components";
import { useStore } from "../store";

const JOB_STATUSES = ["new", "drafted", "sent", "skipped", "error"] as const;

function Section({ title, icon, children, desc }: { title: string; icon: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="card space-y-3 p-4">
      <div className="flex items-center gap-2">
        <Icon name={icon} className="h-5 w-5 text-indigo-600" />
        <h2 className="font-semibold">{title}</h2>
      </div>
      {desc && <p className="text-sm text-slate-500">{desc}</p>}
      {children}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

type Pending = { title: string; body: ReactNode; action: string; run: () => Promise<string> } | null;

export default function DataPage() {
  const { toast } = useStore();
  const [st, setSt] = useState<MaintStats | null>(null);
  const [vals, setVals] = useState<SettingsValues | null>(null);
  const [ret, setRet] = useState<Retention | null>(null);
  const [retDirty, setRetDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  // one-off deletion forms
  const [logDays, setLogDays] = useState(0);
  const [jobDays, setJobDays] = useState(30);
  const [jobStatuses, setJobStatuses] = useState<string[]>(["new", "skipped", "error"]);
  const [keepSent, setKeepSent] = useState(true);
  const [draftDays, setDraftDays] = useState(14);

  const load = useCallback(async () => {
    try {
      const [s, cfg] = await Promise.all([api.maintStats(), api.settings()]);
      setSt(s);
      setVals(cfg.values);
      if (!retDirty) setRet(cfg.values.retention);
    } catch (e) { toast((e as Error).message); }
  }, [toast, retDirty]);
  useEffect(() => { load(); }, [load]);

  const confirmRun = async () => {
    if (!pending) return;
    setBusy(true);
    try { toast(await pending.run(), "ok"); setPending(null); await load(); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };
  const quick = async (fn: () => Promise<string>) => {
    setBusy(true);
    try { toast(await fn(), "ok"); await load(); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const saveChatgpt = (patch: Partial<SettingsValues["chatgpt"]>) => vals && quick(async () => {
    const r = await api.saveSettings({ chatgpt: { ...vals.chatgpt, ...patch } });
    setVals(r.values);
    return "ChatGPT history setting saved";
  });
  const saveRetention = () => ret && quick(async () => {
    const r = await api.saveSettings({ retention: ret });
    setRet(r.values.retention);
    setRetDirty(false);
    return "Automatic clean-up saved";
  });
  const setR = <K extends keyof Retention>(k: K, v: Retention[K]) => { if (ret) { setRet({ ...ret, [k]: v }); setRetDirty(true); } };
  const ageText = (d: number) => (d > 0 ? `older than ${d} day${d === 1 ? "" : "s"}` : "of any age");

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-4xl space-y-4 pb-16">
        <div className="flex items-center gap-2">
          <h1 className="mr-auto text-xl font-semibold">Data &amp; history</h1>
          <a className="btn-ghost" href="/api/maintenance/backup" download title="Download a copy of everything (jobs, accounts, prompts, settings, history)">
            <Icon name="database" className="h-4 w-4" /> Download backup
          </a>
        </div>

        <Section title="Storage" icon="database">
          {st ? (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <Stat label="Database" value={fmtBytes(st.db_bytes)} />
              <Stat label="Jobs" value={st.jobs} sub={st.oldest_job ? `oldest ${ago(st.oldest_job)}` : undefined} />
              <Stat label="Generated proposals" value={st.drafts} sub={`${st.submissions} bids`} />
              <Stat label="Log lines" value={st.logs} sub={`${st.notices} notices (${st.notices_unread} unread)`} />
            </div>
          ) : <div className="skeleton h-16" />}
          <button className="btn-ghost" disabled={busy} title="Gives the space freed by deletions back to the disk"
            onClick={() => quick(async () => { const r = await api.vacuum(); return `Compacted: ${fmtBytes(r.before)} → ${fmtBytes(r.after)}`; })}>
            Compact database
          </button>
        </Section>

        <Section title="Job history" icon="jobs" desc="Deletes jobs together with their generated proposals and bids. Jobs that are being generated, queued or sent are never deleted. Deleted jobs are not fetched again.">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-32"><span className="label">Older than (days)</span>
              <input className="input" type="number" min={0} value={jobDays} onChange={(e) => setJobDays(Math.max(0, Number(e.target.value)))} /></div>
            <div><span className="label">Status</span>
              <div className="flex flex-wrap gap-1.5">
                {JOB_STATUSES.map((s) => {
                  const on = jobStatuses.includes(s);
                  return (
                    <button key={s} onClick={() => setJobStatuses(on ? jobStatuses.filter((x) => x !== s) : [...jobStatuses, s])}
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${on ? "border-indigo-500 bg-indigo-500 text-white" : "border-slate-200 text-slate-600 hover:border-indigo-300"}`}>
                      {s}{st?.jobs_by_status[s] !== undefined ? ` (${st.jobs_by_status[s]})` : ""}
                    </button>
                  );
                })}
              </div></div>
            <Switch checked={keepSent} onChange={setKeepSent} label={<span className="text-sm">Keep jobs with a sent bid (for Stats)</span>} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-danger" disabled={busy || !jobStatuses.length} onClick={() => setPending({
              title: "Delete job history?", action: "Delete jobs",
              body: <>Jobs {ageText(jobDays)} with status <b>{jobStatuses.join(", ")}</b>{keepSent ? ", except jobs with a sent bid," : ""} are deleted with their drafts and bids. This cannot be undone (download a backup first if unsure).</>,
              run: async () => { const r = await api.purgeJobs({ older_than_days: jobDays, statuses: jobStatuses, keep_sent: keepSent }); return `${r.deleted} job(s) deleted${r.kept ? `, ${r.kept} kept (busy)` : ""}`; },
            })}><Icon name="trash" className="h-4 w-4" /> Delete matching jobs</button>
          </div>
          <div className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
            <div className="w-32"><span className="label">Older than (days)</span>
              <input className="input" type="number" min={0} value={draftDays} onChange={(e) => setDraftDays(Math.max(0, Number(e.target.value)))} /></div>
            <button className="btn-ghost" disabled={busy} onClick={() => setPending({
              title: "Delete old generated proposals?", action: "Delete proposals",
              body: <>Generated proposals {ageText(draftDays)} of jobs that are <b>sent or skipped</b> are deleted. The text that was actually sent stays in each bid.</>,
              run: async () => `${(await api.purgeDrafts(draftDays)).deleted} proposal(s) deleted`,
            })}>Delete old generated proposals</button>
          </div>
        </Section>

        <Section title="Logs" icon="logs">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-32"><span className="label">Older than (days)</span>
              <input className="input" type="number" min={0} value={logDays} onChange={(e) => setLogDays(Math.max(0, Number(e.target.value)))} /></div>
            <button className="btn-danger" disabled={busy || !st?.logs} onClick={() => setPending({
              title: "Delete logs?", action: "Delete logs", body: <>Log lines {ageText(logDays)} are deleted.</>,
              run: async () => `${(await api.clearLogs(logDays)).deleted} log line(s) deleted`,
            })}><Icon name="trash" className="h-4 w-4" /> Delete logs</button>
            <button className="btn-ghost" disabled={busy || !st?.notices} onClick={() => setPending({
              title: "Delete Inbox notices?", action: "Delete notices", body: <>Workana messages/notifications {ageText(logDays)} are removed from the Inbox page (nothing changes on Workana).</>,
              run: async () => `${(await api.clearNoticesOlder(logDays)).deleted} notice(s) deleted`,
            })}>Delete Inbox notices</button>
          </div>
        </Section>

        <Section title="ChatGPT history" icon="prompts"
          desc="Each proposal is written in a fresh ChatGPT chat. Keep them out of your ChatGPT history so it does not fill up.">
          {vals && (
            <div className="space-y-2">
              <Switch checked={vals.chatgpt.temporary_chat} disabled={busy} onChange={(v) => saveChatgpt({ temporary_chat: v })}
                label={<span className="text-sm">Use <b>temporary chats</b> (never saved to ChatGPT history) — recommended</span>} />
              <Switch checked={vals.chatgpt.delete_after_reply} disabled={busy} onChange={(v) => saveChatgpt({ delete_after_reply: v })}
                label={<span className="text-sm">If a chat is saved anyway, <b>delete it</b> right after the reply was read</span>} />
            </div>
          )}
          <button className="btn-ghost" disabled={busy} onClick={() => setPending({
            title: "Delete the assistant's ChatGPT chats?", action: "Delete chats",
            body: <>The ChatGPT extension deletes the chats <b>it created</b> that are still in your ChatGPT history. Your own chats are not touched. ChatGPT must be idle.</>,
            run: async () => {
              const r = await api.deleteChatgptChats();
              return r.note ?? `${r.deleted ?? 0} chat(s) deleted${r.failed ? `, ${r.failed} failed (${r.first_error})` : ""}`;
            },
          })}>Delete assistant chats now</button>
        </Section>

        <Section title="Automatic clean-up" icon="refresh" desc="Runs once a day in the background. 0 days = keep forever.">
          {ret && (
            <div className="space-y-3">
              <Switch checked={ret.enabled} onChange={(v) => setR("enabled", v)} label={<span className="text-sm font-medium">Enabled</span>} />
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div><span className="label">Delete logs after (days)</span>
                  <input className="input" type="number" min={0} value={ret.logs_days} onChange={(e) => setR("logs_days", Number(e.target.value))} /></div>
                <div><span className="label">Delete jobs after (days)</span>
                  <input className="input" type="number" min={0} value={ret.jobs_days} onChange={(e) => setR("jobs_days", Number(e.target.value))} /></div>
                <div><span className="label">Delete notices after (days)</span>
                  <input className="input" type="number" min={0} value={ret.notices_days} onChange={(e) => setR("notices_days", Number(e.target.value))} /></div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="label !mb-0">Job statuses</span>
                {JOB_STATUSES.map((s) => {
                  const on = ret.job_statuses.includes(s);
                  return (
                    <button key={s} onClick={() => setR("job_statuses", on ? ret.job_statuses.filter((x) => x !== s) : [...ret.job_statuses, s])}
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${on ? "border-indigo-500 bg-indigo-500 text-white" : "border-slate-200 text-slate-600"}`}>{s}</button>
                  );
                })}
                <Switch checked={ret.keep_sent} onChange={(v) => setR("keep_sent", v)} label={<span className="text-sm">keep jobs with a sent bid</span>} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn-primary" disabled={!retDirty || busy} onClick={saveRetention}>Save</button>
                <button className="btn-ghost" disabled={busy || retDirty} onClick={() => setPending({
                  title: "Run the clean-up now?", action: "Run now", body: <>Deletes what the saved rules above select.</>,
                  run: async () => { const r = await api.runRetention(); return `Clean-up done: ${r.jobs ?? 0} job(s), ${r.logs ?? 0} log line(s), ${r.notices ?? 0} notice(s)`; },
                })}>Run now</button>
                <span className="text-xs text-slate-500">{st?.retention_last_run ? `last run ${ago(st.retention_last_run + "Z")}` : "never ran yet"}</span>
              </div>
            </div>
          )}
        </Section>
      </div>
      <ConfirmDanger open={!!pending} title={pending?.title ?? ""} action={pending?.action ?? ""} busy={busy}
        onClose={() => setPending(null)} onConfirm={confirmRun}>{pending?.body}</ConfirmDanger>
    </div>
  );
}
