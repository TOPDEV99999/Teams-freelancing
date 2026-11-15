import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, fmtTime, OUTCOMES, type StatsResponse, type Submission } from "../api";
import { Badge, money } from "../components";
import { useStore } from "../store";

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

export default function StatsPage() {
  const { accounts, subscribe, toast } = useStore();
  const [days, setDays] = useState(90);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [subs, setSubs] = useState<Submission[]>([]);

  const load = useCallback(async () => {
    try {
      const [st, sl] = await Promise.all([api.stats(days), api.submissions()]);
      setStats(st);
      setSubs(sl);
    } catch (e) { toast((e as Error).message); }
  }, [days, toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribe((t) => { if (t === "submission_updated" || t === "submission_deleted") load(); }), [subscribe, load]);

  const setOutcome = async (s: Submission, outcome: string) => {
    try { await api.setOutcome(s.id, outcome); await load(); } catch (e) { toast((e as Error).message); }
  };

  const name = (id: string) => accounts[id]?.display_name || id;
  // NB: no `style` key in chart rows - Recharts spreads row fields onto SVG elements.
  const styleData = (stats?.by_style ?? []).map((r) => ({
    styleName: r.style, sent: r.sent, reply: +(r.reply_rate * 100).toFixed(1), hire: +(r.hire_rate * 100).toFixed(1),
  }));
  const accData = (stats?.by_account ?? []).map((r) => ({ ...r, name: name(r.account_id), reply: +(r.reply_rate * 100).toFixed(1) }));

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex items-center gap-3">
          <h1 className="mr-auto text-xl font-semibold">Stats</h1>
          <select className="input !w-40" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 90, 365].map((d) => <option key={d} value={d}>last {d} days</option>)}
          </select>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="card p-4">
            <h2 className="mb-2 font-semibold">By style — reply &amp; hire rate (%)</h2>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={styleData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="styleName" /><YAxis unit="%" /><Tooltip /><Legend />
                <Bar dataKey="reply" name="reply rate" fill="#6366f1" />
                <Bar dataKey="hire" name="hire rate" fill="#10b981" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="card p-4">
            <h2 className="mb-2 font-semibold">By account — proposals sent</h2>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={accData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" /><YAxis allowDecimals={false} /><Tooltip /><Legend />
                <Bar dataKey="sent" name="sent" fill="#6366f1" />
                <Bar dataKey="replied" name="replied" fill="#f59e0b" />
                <Bar dataKey="hired" name="hired" fill="#10b981" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card overflow-x-auto p-4">
          <h2 className="mb-2 font-semibold">Account × style</h2>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr><th className="py-1">Account</th><th>Style</th><th>Sent</th><th>Replied</th><th>Interview</th><th>Hired</th><th>Rejected</th><th>Failed</th><th>Reply rate</th><th>Hire rate</th></tr>
            </thead>
            <tbody>
              {(stats?.by_account_style ?? []).map((r) => (
                <tr key={r.account_id + r.style} className="border-t border-slate-100">
                  <td className="py-1">{name(r.account_id)}</td><td className="capitalize">{r.style}</td><td>{r.sent}</td><td>{r.replied}</td>
                  <td>{r.interview}</td><td>{r.hired}</td><td>{r.rejected}</td><td>{r.failed}</td><td>{pct(r.reply_rate)}</td><td>{pct(r.hire_rate)}</td>
                </tr>
              ))}
              {!stats?.by_account_style.length && <tr><td colSpan={10} className="py-4 text-center text-slate-400">No submissions yet.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card overflow-x-auto p-4">
          <h2 className="mb-2 font-semibold">Submissions — set outcomes here</h2>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr><th className="py-1">Requested</th><th>Job</th><th>Account</th><th>Style</th><th>Price</th><th>Status</th><th>Outcome</th></tr>
            </thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="whitespace-nowrap py-1 text-xs text-slate-500">{fmtTime(s.requested_at)}</td>
                  <td className="max-w-xs truncate"><a className="hover:underline" href={s.job_url} target="_blank" rel="noreferrer">{s.job_title}</a></td>
                  <td>{name(s.account_id)}</td><td className="capitalize">{s.style ?? "—"}</td><td>{money(s.price, s.currency)}</td>
                  <td><Badge status={s.status} /></td>
                  <td>
                    <select className="input !w-32 !py-0.5 !text-xs" value={s.outcome} disabled={s.status !== "sent"}
                      onChange={(e) => setOutcome(s, e.target.value)}>
                      {OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
