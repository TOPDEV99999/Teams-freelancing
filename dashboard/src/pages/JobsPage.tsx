import { useEffect, useMemo, useState } from "react";
import { api, fmtTime, type Job } from "../api";
import { Badge, ConfirmDanger, Icon, LastSeen, Switch, TRUST_STYLE, TrustBadge, isTypingTarget } from "../components";
import { useStore } from "../store";
import JobDetail from "./JobDetail";

const STATUSES = ["", "new", "generating", "drafted", "sent", "skipped", "error"];
const TRUST_RANK: Record<string, number> = { unknown: 0, low: 0, new: 1, fair: 2, good: 3, high: 4 };
const SUB_DOT: Record<string, string> = {
  queued: "bg-amber-400", sending: "bg-indigo-500 animate-pulse", sent: "bg-emerald-500", failed: "bg-rose-500",
};

/** Small per-account chips: who bids on this job and how far each one got. */
function TargetChips({ job, names }: { job: Job; names: Record<string, string> }) {
  return (
    <div className="flex flex-wrap gap-1">
      {(job.targets ?? []).map((a) => {
        const sub = job.submissions?.find((x) => x.account_id === a);
        const drafted = job.draft_accounts?.includes(a);
        return (
          <span key={a} title={`${names[a] ?? a}: ${sub?.status ?? (drafted ? "drafts ready" : "no drafts")}`}
            className="flex items-center gap-1 whitespace-nowrap rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700">
            <span className={`h-1.5 w-1.5 rounded-full ${sub ? SUB_DOT[sub.status] : drafted ? "bg-violet-400" : "bg-slate-300"}`} />
            {names[a] ?? a}
          </span>
        );
      })}
    </div>
  );
}

export default function JobsPage() {
  const { jobs, accounts, toast, upsertJob } = useStore();
  const [status, setStatus] = useState("");
  const [account, setAccount] = useState("");
  const [q, setQ] = useState("");
  const [bmin, setBmin] = useState("");
  const [bmax, setBmax] = useState("");
  const [minTrust, setMinTrust] = useState("");
  const [sortTrust, setSortTrust] = useState(false);
  const [sortSeen, setSortSeen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  // Bulk pre-assignment
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulkAccounts, setBulkAccounts] = useState<string[]>([]);
  const [bulkAuto, setBulkAuto] = useState(false);
  const [bulkStyle, setBulkStyle] = useState("");
  const [styleKeys, setStyleKeys] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  useEffect(() => {
    api.settings().then((r) => setStyleKeys(r.values.styles.map((x) => x.key))).catch(() => undefined);
  }, []);
  const [selected, setSelectedState] = useState<string | null>(() => {
    const parts = location.hash.replace(/^#\/?/, "").split("/");
    return parts[0] === "jobs" && parts[1] ? decodeURIComponent(parts[1]) : null;
  });
  const setSelected = (id: string | null) => {
    setSelectedState(id);
    history.replaceState(null, "", id ? `#/jobs/${encodeURIComponent(id)}` : "#/jobs");
  };
  // Links like #/jobs/<id> (Inbox, Cancel panel) open that job even when this page is already shown.
  useEffect(() => {
    const h = () => {
      const parts = location.hash.replace(/^#\/?/, "").split("/");
      if (parts[0] === "jobs" && parts[1]) setSelectedState(decodeURIComponent(parts[1]));
    };
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  // A deleted job closes its panel.
  useEffect(() => { if (selected && Object.keys(jobs).length && !jobs[selected]) setSelectedState(null); }, [jobs, selected]);

  const accountList = Object.values(accounts).sort((a, b) => a.id.localeCompare(b.id));
  const names = Object.fromEntries(accountList.map((a) => [a.id, a.display_name || a.id]));

  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const min = bmin ? Number(bmin) : null;
    const max = bmax ? Number(bmax) : null;
    return Object.values(jobs)
      .filter((j) => !status || j.status === status)
      .filter((j) => !account || (account === "unassigned" ? !(j.targets ?? []).length && !j.assigned_account_id
        : j.assigned_account_id === account || (j.targets ?? []).includes(account)))
      .filter((j) => !ql || j.title.toLowerCase().includes(ql) || (j.snippet ?? "").toLowerCase().includes(ql)
        || j.skills.some((s) => s.toLowerCase().includes(ql)))
      .filter((j) => min == null || (j.budget_max ?? j.budget_min ?? Infinity) >= min)
      .filter((j) => max == null || (j.budget_min ?? j.budget_max ?? 0) <= max)
      .filter((j) => !minTrust || (minTrust === "known" ? (j.trust?.tier ?? "unknown") !== "unknown"
        : TRUST_RANK[j.trust?.tier ?? "unknown"] >= TRUST_RANK[minTrust]))
      .sort((a, b) => (sortSeen ? String(b.client_info?.last_login ?? "").localeCompare(String(a.client_info?.last_login ?? "")) : 0)
        || (sortTrust ? (b.trust?.score ?? 0) - (a.trust?.score ?? 0) : 0) || b.fetched_at.localeCompare(a.fetched_at));
  }, [jobs, status, account, q, bmin, bmax, minTrust, sortTrust, sortSeen]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isTypingTarget(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== "j" && k !== "k") return;
      e.preventDefault();
      const idx = list.findIndex((j) => j.id === selected);
      const next = k === "j" ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx - 1);
      if (list[next]) {
        setSelected(list[next].id);
        document.getElementById(`job-row-${list[next].id}`)?.scrollIntoView({ block: "nearest" });
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [list, selected]);

  const assign = async (job: Job, accountId: string) => {
    try { upsertJob(await api.assign(job.id, accountId || null)); }
    catch (e) { toast((e as Error).message); }
  };

  const toggleChecked = (id: string) => setChecked((c) => {
    const n = new Set(c);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const allVisibleChecked = list.length > 0 && list.every((j) => checked.has(j.id));
  const toggleAllVisible = () => setChecked(allVisibleChecked ? new Set() : new Set(list.map((j) => j.id)));
  const toggleBulkAccount = (a: string) =>
    setBulkAccounts((l) => (l.includes(a) ? l.filter((x) => x !== a) : [...l, a]));
  const skipBulk = async () => {
    setBulkBusy(true);
    let ok = 0;
    for (const id of checked) {
      try { upsertJob(await api.skip(id)); ok++; } catch { /* locked / sending: leave it */ }
    }
    toast(`${ok} of ${checked.size} job(s) skipped`, ok ? "ok" : "error");
    setChecked(new Set());
    setBulkBusy(false);
  };
  // Proposals the bulk button will generate: picked accounts × jobs, or each job's own matching accounts.
  const bulkCount = [...checked].reduce((n, id) => {
    const j = jobs[id];
    if (!j || j.status === "skipped") return n;
    const done = new Set((j.submissions ?? []).map((x) => x.account_id));
    const accs = bulkAccounts.length ? bulkAccounts : (j.targets ?? []);
    return n + accs.filter((a) => !done.has(a)).length;
  }, 0);
  const deleteBulk = async () => {
    setBulkBusy(true);
    try {
      const r = await api.deleteJobs([...checked]);
      const kept = Object.keys(r.kept).length;
      toast(`${r.deleted.length} job(s) deleted${kept ? ` · ${kept} kept (generating / queued / sending)` : ""}`, kept ? "error" : "ok");
      setChecked(new Set());
      setConfirmDel(false);
    } catch (e) { toast((e as Error).message); }
    finally { setBulkBusy(false); }
  };
  const queueBulk = async () => {
    setBulkBusy(true);
    try {
      const r = await api.batch({ job_ids: [...checked], account_ids: bulkAccounts, auto_send: bulkAuto, auto_style: bulkStyle });
      toast(`${r.jobs.length} job(s) queued · ${r.generations_queued} proposal(s) to generate, one after another`
        + (r.skipped.length ? ` · ${r.skipped.length} skipped (no matching account — pick accounts in the bar)` : ""),
        r.generations_queued ? "ok" : "error");
      setChecked(new Set());
    } catch (e) { toast((e as Error).message); }
    finally { setBulkBusy(false); }
  };

  return (
    <div className="flex h-full">
      <section className={`flex min-w-0 flex-col ${selected ? "w-1/2 border-r border-slate-200" : "w-full"}`}>
        <div className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-surface p-3">
          <div className="w-56"><span className="label">Search</span>
            <div className="relative">
              <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
              <input className="input !pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="title, skill…" />
            </div></div>
          <div><span className="label">Status</span>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s || "all"}</option>)}
            </select></div>
          <div><span className="label">Account</span>
            <select className="input" value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">all</option>
              <option value="unassigned">unassigned</option>
              {accountList.map((a) => <option key={a.id} value={a.id}>{a.display_name || a.id}</option>)}
            </select></div>
          <div className="w-20"><span className="label">Min $</span>
            <input className="input" type="number" value={bmin} onChange={(e) => setBmin(e.target.value)} /></div>
          <div className="w-20"><span className="label">Max $</span>
            <input className="input" type="number" value={bmax} onChange={(e) => setBmax(e.target.value)} /></div>
          <div><span className="label">Client trust</span>
            <select className="input" value={minTrust} onChange={(e) => setMinTrust(e.target.value)}>
              <option value="">any</option>
              <option value="known">with payment data</option>
              <option value="new">new client or better</option>
              <option value="fair">{TRUST_STYLE.fair.name.toLowerCase()} or better</option>
              <option value="good">{TRUST_STYLE.good.name.toLowerCase()} or better</option>
              <option value="high">{TRUST_STYLE.high.name.toLowerCase()} only</option>
            </select></div>
          <label className="flex items-center gap-1.5 pb-2 text-xs text-slate-600" title="Most trustworthy clients first">
            <input type="checkbox" checked={sortTrust} onChange={(e) => setSortTrust(e.target.checked)} /> sort by trust</label>
          <label className="flex items-center gap-1.5 pb-2 text-xs text-slate-600" title="Clients who logged in most recently first">
            <input type="checkbox" checked={sortSeen} onChange={(e) => setSortSeen(e.target.checked)} /> recently active first</label>
          <div className="ml-auto text-xs text-slate-500">
            {list.length} jobs · <kbd>J</kbd>/<kbd>K</kbd> navigate
          </div>
        </div>

        {checked.size > 0 && (
          <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
            <div className="glass pointer-events-auto flex max-w-[min(100%,64rem)] animate-slide-up flex-wrap items-center gap-2 rounded-2xl border border-slate-200 px-3 py-2.5 text-sm [box-shadow:var(--shadow-pop)]">
              <span className="flex items-center gap-2 pr-1">
                <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-indigo-500 px-1.5 text-xs font-bold text-white tabular-nums">{checked.size}</span>
                <span className="text-slate-500">selected · bid with{bulkAccounts.length ? "" : " (matching accounts) or pick:"}</span>
              </span>
              {accountList.map((a) => {
                const on = bulkAccounts.includes(a.id);
                return (
                  <button key={a.id} onClick={() => toggleBulkAccount(a.id)}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium ${on
                      ? "border-indigo-500 bg-indigo-500 text-white shadow-[0_2px_8px_-2px_rgb(99_102_241/0.6)]"
                      : "border-slate-200 bg-surface text-slate-600 hover:border-indigo-300"}`}>
                    {a.display_name || a.id}
                  </button>
                );
              })}
              <button className="rounded-full px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
                onClick={() => setBulkAccounts(bulkAccounts.length === accountList.length ? [] : accountList.map((a) => a.id))}>
                {bulkAccounts.length === accountList.length ? "None" : "All"}
              </button>
              <span className="mx-1 h-5 w-px bg-slate-200" />
              <Switch checked={bulkAuto} onChange={setBulkAuto} title="Queue each proposal automatically as soon as its drafts are ready"
                label={<span className="text-xs text-slate-600">Auto-send</span>} />
              {bulkAuto && (
                <select className="input !w-28 !py-1 !text-xs animate-fade" value={bulkStyle} onChange={(e) => setBulkStyle(e.target.value)}>
                  <option value="">first style</option>
                  {styleKeys.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              )}
              <span className="mx-1 h-5 w-px bg-slate-200" />
              <button className="btn-primary" disabled={bulkBusy || bulkCount === 0} onClick={queueBulk}
                title={bulkCount === 0 ? "None of the selected jobs has a matching account — pick accounts on the left"
                  : bulkAccounts.length ? "Generate for the picked accounts on every selected job"
                    : "Generate for each job's pre-selected (matching) accounts"}>
                <Icon name="spark" className="h-4 w-4" />
                Generate {bulkCount}{bulkAuto ? " & send" : ""}
              </button>
              <button className="btn-ghost" disabled={bulkBusy} onClick={skipBulk} title="Skip the selected jobs">Skip</button>
              <button className="btn-ghost !text-rose-700" disabled={bulkBusy} onClick={() => setConfirmDel(true)} title="Delete the selected jobs and their history">
                <Icon name="trash" className="h-4 w-4" /></button>
              <button className="rounded-lg px-2 py-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => setChecked(new Set())} title="Clear selection">✕</button>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="glass sticky top-0 z-10 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500 shadow-[0_1px_0_var(--s-200)]">
              <tr>
                <th className="w-8 py-2 pl-3"><input type="checkbox" checked={allVisibleChecked} onChange={toggleAllVisible}
                  title="select all visible jobs" /></th>
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Budget</th>
                <th className="px-3 py-2" title="Client trust (projects paid / published) and the client's last login on Workana">Client</th>
                {!selected && <th className="px-3 py-2">Category</th>}
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((j) => (
                <tr key={j.id} id={`job-row-${j.id}`} onClick={() => setSelected(j.id)}
                  className={`cursor-pointer border-b border-slate-100 ${selected === j.id
                    ? "bg-indigo-50 shadow-[inset_3px_0_0_#6366f1]" : checked.has(j.id) ? "bg-indigo-50/50" : "bg-surface hover:bg-slate-50"}`}>
                  <td className="py-2 pl-3" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={checked.has(j.id)} onChange={() => toggleChecked(j.id)} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">{fmtTime(j.fetched_at)}</td>
                  <td className="px-3 py-2">
                    <div className="line-clamp-1 font-medium">{j.title}</div>
                    {!selected && <div className="line-clamp-1 text-xs text-slate-500">{j.snippet}</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">{j.budget_text || "—"}</td>
                  <td className="px-3 py-2"><div className="flex flex-col items-start gap-1">
                    <TrustBadge trust={j.trust} compact /><LastSeen info={j.client_info ?? {}} compact /></div></td>
                  {!selected && <td className="px-3 py-2 text-xs text-slate-600">{j.category ?? "—"}</td>}
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    {(j.targets ?? []).length > 1 || (j.submissions ?? []).length > 0 ? <TargetChips job={j} names={names} /> : (
                      <select className="input !py-0.5 !text-xs" value={j.assigned_account_id ?? ""}
                        onChange={(e) => assign(j, e.target.value)}>
                        <option value="">— unassigned —</option>
                        {accountList.map((a) => <option key={a.id} value={a.id}>{a.display_name || a.id}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <Badge status={j.status} />
                    {j.auto_send && <span className="ml-1 text-[11px] text-indigo-600" title="auto-send">⚡</span>}
                    {(j.submissions ?? []).length > 0 && j.status !== "sent" && (
                      <span className="ml-1 text-[11px] text-slate-500">
                        {(j.submissions ?? []).filter((x) => x.status === "sent").length}/{(j.targets ?? []).length} sent
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr><td colSpan={8} className="p-8 text-center text-slate-400">
                  No jobs yet. They appear here as the fetcher finds them.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <ConfirmDanger open={confirmDel} title={`Delete ${checked.size} job(s)?`} action="Delete" busy={bulkBusy}
        onClose={() => setConfirmDel(false)} onConfirm={deleteBulk}>
        The selected jobs are deleted with their generated proposals and bids (Stats lose those bids). Jobs that are being generated,
        queued or sent are kept. Deleted jobs are not fetched again.
      </ConfirmDanger>

      {selected && (
        <section className="w-1/2 min-w-0 animate-slide-in">
          <JobDetail key={selected} jobId={selected} onClose={() => setSelected(null)} />
        </section>
      )}
    </div>
  );
}
