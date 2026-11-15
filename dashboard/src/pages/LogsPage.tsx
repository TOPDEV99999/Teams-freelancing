import { useState } from "react";
import { api, fmtTime } from "../api";
import { ConfirmDanger, Icon } from "../components";
import { useStore } from "../store";

const LEVEL = { info: "text-slate-600", warn: "text-amber-700", error: "text-rose-700 font-medium" } as const;

export default function LogsPage() {
  const { logs, accounts, toast } = useStore();
  const [confirm, setConfirm] = useState(false);
  const [days, setDays] = useState(0);
  const clear = async () => {
    try { const r = await api.clearLogs(days); toast(`${r.deleted} log line(s) deleted`, "ok"); setConfirm(false); }
    catch (e) { toast((e as Error).message); }
  };
  const [kind, setKind] = useState("");
  const [level, setLevel] = useState("");
  const [q, setQ] = useState("");
  const list = logs.filter((l) => (!kind || l.kind === kind) && (!level || l.level === level)
    && (!q || l.message.toLowerCase().includes(q.toLowerCase())));

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-surface p-3">
        <h1 className="mr-4 text-xl font-semibold">Logs</h1>
        <div><span className="label">Kind</span>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {["", "fetch", "telegram", "generate", "submit", "ext", "system"].map((k) => <option key={k} value={k}>{k || "all"}</option>)}
          </select></div>
        <div><span className="label">Level</span>
          <select className="input" value={level} onChange={(e) => setLevel(e.target.value)}>
            {["", "info", "warn", "error"].map((k) => <option key={k} value={k}>{k || "all"}</option>)}
          </select></div>
        <div className="w-64"><span className="label">Search</span><input className="input" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <span className="ml-auto text-xs text-slate-500">last {logs.length} events (live)</span>
        <button className="btn-ghost" onClick={() => setConfirm(true)}><Icon name="trash" className="h-4 w-4" /> Delete logs</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-surface">
        <table className="w-full font-mono text-xs">
          <tbody>
            {list.map((l) => (
              <tr key={l.id} className="border-b border-slate-100 align-top">
                <td className="whitespace-nowrap px-3 py-1 text-slate-400">{fmtTime(l.ts)}</td>
                <td className="px-2 py-1 text-slate-500">{l.kind}</td>
                <td className="px-2 py-1 text-slate-500">{l.account_id ? accounts[l.account_id]?.display_name ?? l.account_id : ""}</td>
                <td className={`px-2 py-1 ${LEVEL[l.level] ?? ""}`}>{l.message}{l.job_id && <span className="ml-2 text-slate-400">[{l.job_id}]</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmDanger open={confirm} title="Delete logs?" action="Delete" onClose={() => setConfirm(false)} onConfirm={clear}>
        <div className="space-y-2">
          <p>Which log lines?</p>
          <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={0}>All of them</option>
            <option value={1}>Older than 1 day</option>
            <option value={7}>Older than 7 days</option>
            <option value={30}>Older than 30 days</option>
          </select>
          <p className="text-xs text-slate-500">Automatic clean-up can be set on the Data page.</p>
        </div>
      </ConfirmDanger>
    </div>
  );
}
