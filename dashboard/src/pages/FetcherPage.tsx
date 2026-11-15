import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, fmtTime, type FetcherStatus, type SettingsValues, type WorkanaFilters } from "../api";
import { Countdown, Modal } from "../components";
import { SKILLS, SKILL_LABEL } from "../skills";
import { useStore } from "../store";

type Editable = Pick<SettingsValues, "fetch_interval_seconds" | "workana_filters" | "telegram">;

const LANGS = [
  { key: "es", label: "🇪🇸 Spanish" },
  { key: "pt", label: "🇧🇷 Portuguese" },
  { key: "en", label: "🇺🇸 English" },
];

function agoTs(ts: number | null | undefined): string {
  if (!ts) return "never";
  const d = Date.now() / 1000 - ts;
  if (d < 60) return `${Math.max(0, Math.round(d))}s ago`;
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  return `${(d / 3600).toFixed(1)}h ago`;
}

function Chip({ on, onClick, children, small }: { on: boolean; onClick: () => void; children: ReactNode; small?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-full border ${small ? "px-2.5 py-0.5 text-xs" : "px-3 py-1 text-sm"} font-medium transition select-none ${
        on ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-300 bg-surface text-slate-600 hover:border-indigo-400"}`}>
      {children}
    </button>
  );
}

function Range({ label, value, min, max, step, fmt, onChange, hint }: {
  label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string;
  onChange: (v: number) => void; hint?: string;
}) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex items-center gap-3">
        <input type="range" className="flex-1 accent-indigo-600" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(Number(e.target.value))} />
        <input type="number" className="input !w-24 text-right font-semibold" min={min} step={step} value={value}
          onChange={(e) => onChange(Number(e.target.value))} />
        <span className="w-12 text-xs text-slate-500">{fmt(value)}</span>
      </div>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm">
      <input type="checkbox" className="mt-0.5 accent-indigo-600" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

/** Parses the old bot's .env text into settings. */
function parseOldEnv(text: string, cur: Editable): { next: Editable; found: string[] } {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  const f: WorkanaFilters = { ...cur.workana_filters };
  const tg = { ...cur.telegram };
  let interval = cur.fetch_interval_seconds;
  const found: string[] = [];
  const num = (k: string) => (env[k] !== undefined && env[k] !== "" && !isNaN(Number(env[k])) ? Number(env[k]) : null);
  if (env.LANGUAGES) { f.languages = env.LANGUAGES.split(",").map((s) => s.trim()).filter((s) => ["es", "pt", "en"].includes(s)); found.push("languages"); }
  if (num("MIN_BUDGET_USD") !== null) { f.min_budget = num("MIN_BUDGET_USD")!; found.push("min budget"); }
  if (env.ALLOW_HOURLY) { f.allow_hourly = !["false", "0", "no"].includes(env.ALLOW_HOURLY.toLowerCase()); found.push("hourly"); }
  if (num("MIN_HOURLY_RATE_USD") !== null) { f.min_hourly_rate = num("MIN_HOURLY_RATE_USD")!; found.push("hourly rate"); }
  if (env.SKILLS !== undefined) { f.skills = env.SKILLS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean); found.push(`${f.skills.length} skills`); }
  if (env.MIN_CLIENT_SINCE !== undefined) { f.min_client_since = env.MIN_CLIENT_SINCE; found.push("member since"); }
  if (num("MIN_PAID_RATIO") !== null) { f.min_paid_ratio = num("MIN_PAID_RATIO")!; found.push("paid ratio"); }
  if (num("MIN_PUBLISHED") !== null) { f.min_published = num("MIN_PUBLISHED")!; found.push("min published"); }
  if (num("POLL_INTERVAL_SECONDS") !== null) { interval = Math.max(15, num("POLL_INTERVAL_SECONDS")!); found.push("interval"); }
  if (env.IMPERSONATE) f.impersonate = env.IMPERSONATE;
  if (env.TELEGRAM_BOT_TOKEN) { tg.bot_token = env.TELEGRAM_BOT_TOKEN; found.push("Telegram token"); }
  if (env.TELEGRAM_CHAT_ID) { tg.chat_ids = env.TELEGRAM_CHAT_ID; found.push("chat IDs"); }
  if (tg.bot_token && tg.chat_ids && (env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_CHAT_ID)) tg.enabled = true;
  return { next: { fetch_interval_seconds: interval, workana_filters: f, telegram: tg }, found };
}

export default function FetcherPage() {
  const { logs, toast } = useStore();
  const [st, setSt] = useState<FetcherStatus | null>(null);
  const [v, setV] = useState<Editable | null>(null);
  const [dirty, setDirty] = useState(false);
  const [skillQ, setSkillQ] = useState("");
  const [customSkill, setCustomSkill] = useState("");
  const [tgResult, setTgResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [tgBusy, setTgBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  useEffect(() => {
    api.settings().then((r) => setV({
      fetch_interval_seconds: r.values.fetch_interval_seconds,
      workana_filters: r.values.workana_filters,
      telegram: r.values.telegram,
    })).catch((e) => toast((e as Error).message));
  }, [toast]);

  useEffect(() => {
    let alive = true;
    const poll = () => api.fetcher().then((s) => alive && setSt(s)).catch(() => { /* hub offline */ });
    poll();
    const t = window.setInterval(poll, 3000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  const fetchLogs = useMemo(() => logs.filter((l) => l.kind === "fetch" || l.kind === "telegram").slice(0, 150), [logs]);
  const skillList = useMemo(() => {
    const q = skillQ.trim().toLowerCase();
    const known = new Set(SKILLS.map(([s]) => s));
    const extra = (v?.workana_filters.skills ?? []).filter((s) => !known.has(s)).map((s) => [s, s] as [string, string]);
    return [...SKILLS, ...extra].filter(([s, l]) => !q || s.includes(q) || l.toLowerCase().includes(q));
  }, [skillQ, v?.workana_filters.skills]);

  if (!v) return <div className="p-6 text-slate-400">Loading…</div>;
  const f = v.workana_filters;
  const setF = (patch: Partial<WorkanaFilters>) => { setV({ ...v, workana_filters: { ...f, ...patch } }); setDirty(true); };
  const setTg = (patch: Partial<Editable["telegram"]>) => { setV({ ...v, telegram: { ...v.telegram, ...patch } }); setDirty(true); };
  const skills = new Set(f.skills);
  const toggleSkill = (s: string) => { const n = new Set(skills); if (n.has(s)) n.delete(s); else n.add(s); setF({ skills: [...n].sort() }); };

  const save = async () => {
    try {
      const r = await api.saveSettings(v);
      setV({ fetch_interval_seconds: r.values.fetch_interval_seconds, workana_filters: r.values.workana_filters, telegram: r.values.telegram });
      setDirty(false);
      toast("Saved — applies from the next check", "ok");
    } catch (e) { toast((e as Error).message); }
  };
  const control = async (fn: () => Promise<FetcherStatus>, msg: string) => {
    try { setSt(await fn()); toast(msg, "ok"); } catch (e) { toast((e as Error).message); }
  };
  const testTelegram = async () => {
    setTgBusy(true); setTgResult(null);
    try {
      const r = await api.telegramTest(v.telegram.bot_token, v.telegram.chat_ids);
      setTgResult(r.ok ? { ok: true, text: `✓ Test message sent to ${r.sent} chat(s).` }
        : { ok: false, text: `✗ ${r.sent}/${r.total} delivered — ${r.error}` });
    } catch (e) { setTgResult({ ok: false, text: (e as Error).message }); }
    setTgBusy(false);
  };
  const doImport = () => {
    const { next, found } = parseOldEnv(importText, v);
    if (!found.length) { toast("Nothing recognised — paste the whole .env of the old bot"); return; }
    setV(next); setDirty(true); setImportOpen(false); setImportText("");
    toast(`Imported: ${found.join(", ")}. Review, then Save.`, "ok");
  };

  const h = st?.health ?? {};
  const running = !!st?.enabled;
  const status = !st ? "…" : !st.running ? "No fetcher" : st.busy ? "Checking…" : running ? "Running" : "Stopped";
  const dot = !st?.running ? "bg-slate-400" : st.busy ? "bg-sky-500 animate-pulse" : running ? "bg-emerald-500 shadow-[0_0_6px] shadow-emerald-400" : "bg-rose-500";
  const warn = (n: number | undefined, at = 1) => ((n ?? 0) >= at ? "text-amber-600 font-semibold" : "");

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-6xl space-y-4 pb-16">
        <div className="sticky top-0 z-10 -mx-4 -mt-4 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-canvas/80 px-4 py-3 backdrop-blur-md">
          <h1 className="text-xl font-semibold">Job fetcher</h1>
          <span className="flex items-center gap-2 rounded-full border border-slate-200 bg-surface px-3 py-1 text-sm font-medium">
            <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />{status}
          </span>
          <span className="text-xs text-slate-500">{st?.name}</span>
          <span className="ml-auto" />
          <button className="btn-ghost" onClick={() => setImportOpen(true)}>⇪ Import from old bot</button>
          <button className="btn-primary" disabled={!dirty} onClick={save}>💾 Save &amp; apply</button>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card space-y-3 p-4">
            <h2 className="font-semibold">⚡ Controls</h2>
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary !bg-emerald-600 hover:!bg-emerald-700" disabled={!st?.running || running}
                onClick={() => control(api.fetcherStart, "Fetcher started")}>▶ Start</button>
              <button className="btn-danger" disabled={!st?.running || !running}
                onClick={() => control(api.fetcherStop, "Fetcher stopped")}>■ Stop</button>
              <button className="btn-ghost" disabled={!st?.running || st.busy}
                onClick={() => control(api.fetcherCheck, "Checking Workana now…")}>↻ Check now</button>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-slate-500">Last check</dt><dd>{fmtTime(st?.last_run_at)}</dd>
              <dt className="text-slate-500">Next check</dt><dd>{st?.busy ? "now" : st?.next_run_at ? <Countdown until={st.next_run_at} /> : "—"}</dd>
              <dt className="text-slate-500">New jobs (last / since start)</dt><dd>{st?.last_new ?? 0} / {st?.total_new ?? 0}</dd>
              {st?.last_error && <><dt className="text-rose-600">Last error</dt><dd className="text-rose-600">{st.last_error}</dd></>}
            </dl>
            {st && !st.running && <p className="text-xs text-amber-700">FETCHER=none in .env — set FETCHER=workana and restart the app.</p>}
            {h.seeded === false && st?.running && <p className="text-xs text-slate-500">
              The first check only records what's already listed — after that, every newly posted job that passes your filters appears on the Jobs page.</p>}
          </div>

          <div className="card p-4">
            <h2 className="mb-3 font-semibold">🩺 Health</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-slate-500">Last Workana OK</dt><dd>{agoTs(h.last_ok_ts)}</dd>
              <dt className="text-slate-500">Last non-empty listing</dt><dd>{agoTs(h.last_nonempty_ts)}</dd>
              <dt className="text-slate-500">Jobs listed last check</dt><dd>{h.listed ?? "—"}</dd>
              <dt className="text-slate-500">Passed / filtered (total)</dt><dd>{h.matched_total ?? 0} / {h.filtered_total ?? 0}</dd>
              <dt className="text-slate-500">Cloudflare challenges</dt><dd className={warn(h.consecutive_cf)}>{h.consecutive_cf ?? 0}</dd>
              <dt className="text-slate-500">Empty cycles</dt><dd className={warn(h.consecutive_empty, 3)}>{h.consecutive_empty ?? 0}</dd>
              <dt className="text-slate-500">Hard failures</dt><dd className={warn(h.consecutive_failures)}>{h.consecutive_failures ?? 0}</dd>
              <dt className="text-slate-500">Session age / recreations</dt>
              <dd>{Math.floor((h.session_age_s ?? 0) / 60)}m / <span className={warn(h.recreations)}>{h.recreations ?? 0}</span></dd>
              <dt className="text-slate-500">Projects seen</dt>
              <dd className="flex items-center gap-2">{h.seen ?? 0}
                {st?.running && <button className="text-xs text-indigo-600 hover:underline" onClick={() => {
                  if (confirm("Forget all seen jobs? The next check will record the current listing again (no jobs are imported).")) control(api.fetcherResetSeen, "Seen list cleared");
                }}>reset</button>}</dd>
              <dt className="text-slate-500">Cycle #</dt><dd>{h.cycle ?? 0}</dd>
            </dl>
          </div>

          <div className="card space-y-4 p-4">
            <h2 className="font-semibold">🎯 Filters</h2>
            <div>
              <span className="label">Languages</span>
              <div className="flex flex-wrap gap-2">
                {LANGS.map((l) => (
                  <Chip key={l.key} on={f.languages.includes(l.key)}
                    onClick={() => setF({ languages: f.languages.includes(l.key) ? f.languages.filter((x) => x !== l.key) : [...f.languages, l.key] })}>
                    {l.label}
                  </Chip>
                ))}
              </div>
            </div>
            <div>
              <span className="label">Project type</span>
              <div className="flex flex-wrap gap-2">
                <Chip on={f.allow_fixed} onClick={() => setF({ allow_fixed: !f.allow_fixed })}>🔒 Fixed-price</Chip>
                <Chip on={f.allow_hourly} onClick={() => setF({ allow_hourly: !f.allow_hourly })}>⏱ Hourly</Chip>
              </div>
            </div>
            {f.allow_fixed && <Range label="Min fixed budget (USD)" value={f.min_budget} min={0} max={2000} step={10}
              fmt={(x) => `$${x}`} onChange={(x) => setF({ min_budget: x })}
              hint="The budget's lower bound must be at least this. 'USD 100 - 250' has a lower bound of 100." />}
            {f.allow_hourly && <Range label="Min hourly rate (USD/hr)" value={f.min_hourly_rate} min={0} max={150} step={1}
              fmt={(x) => `$${x}/h`} onChange={(x) => setF({ min_hourly_rate: x })} />}
            <Range label="Check interval (seconds)" value={v.fetch_interval_seconds} min={15} max={600} step={5}
              fmt={(x) => `${x}s`} onChange={(x) => { setV({ ...v, fetch_interval_seconds: x }); setDirty(true); }}
              hint="±15% random jitter is added. 60s or more draws less attention from Cloudflare." />
          </div>

          <div className="card space-y-4 p-4">
            <h2 className="font-semibold">👤 Client &amp; project filters</h2>
            <div>
              <span className="label">Client member since (before)</span>
              <input className="input !w-40 font-mono" placeholder="YYYY-MM" value={f.min_client_since}
                onChange={(e) => setF({ min_client_since: e.target.value })} />
              <p className="mt-1 text-xs text-slate-500">Only clients who joined <b>before</b> this month (e.g. 2026-09). Empty = off.</p>
            </div>
            <Range label="Min paid ratio" value={Math.round(f.min_paid_ratio * 100)} min={0} max={100} step={5}
              fmt={(x) => `${x}%`} onChange={(x) => setF({ min_paid_ratio: x / 100 })}
              hint="Share of the client's published projects that were paid. 0% = off." />
            <Range label="Min published projects (for the ratio)" value={f.min_published} min={0} max={50} step={1}
              fmt={(x) => `${x}`} onChange={(x) => setF({ min_published: x })}
              hint="The ratio filter only applies once the client has at least this many projects." />
            <div className="space-y-2 border-t border-slate-100 pt-3">
              <Toggle checked={f.skip_closed} onChange={(x) => setF({ skip_closed: x })}>
                Skip projects that no longer take bids <span className="text-slate-500">(e.g. "Waiting for escrow")</span></Toggle>
              <Toggle checked={f.check_job_page} onChange={(x) => setF({ check_job_page: x })}>
                Open each matching job page for client info <span className="text-slate-500">(needed for the filters above)</span></Toggle>
              <Toggle checked={f.include_featured} onChange={(x) => setF({ include_featured: x })}>
                Include featured / promoted posts <span className="text-slate-500">(often old)</span></Toggle>
            </div>
          </div>
        </div>

        <div className="card space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-2 font-semibold">🏷 Skill filter</h2>
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
              {f.skills.length ? `${f.skills.length} selected` : "off — all skills pass"}</span>
            <input className="input ml-auto !w-56" placeholder="Search skills…" value={skillQ} onChange={(e) => setSkillQ(e.target.value)} />
            <button className="btn-ghost" onClick={() => setF({ skills: [...new Set([...f.skills, ...skillList.map(([s]) => s)])].sort() })}>
              Select {skillQ ? "shown" : "all"}</button>
            <button className="btn-ghost" onClick={() => setF({ skills: [] })}>Clear</button>
          </div>
          <p className="text-xs text-slate-500">A job passes if it has <b>at least one</b> selected skill. Matching uses Workana's skill slugs, so it works for every language.</p>
          <div className="flex flex-wrap gap-1.5">
            {skillList.map(([s, label]) => (
              <Chip key={s} small on={skills.has(s)} onClick={() => toggleSkill(s)}>{label}</Chip>
            ))}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <input className="input !w-72 font-mono !text-xs" placeholder="other slug(s), e.g. n8n, bubble-io"
              value={customSkill} onChange={(e) => setCustomSkill(e.target.value)} />
            <button className="btn-ghost" disabled={!customSkill.trim()} onClick={() => {
              const add = customSkill.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
              setF({ skills: [...new Set([...f.skills, ...add])].sort() }); setCustomSkill("");
            }}>+ Add</button>
            <span className="text-xs text-slate-500">Slug = the part after <code>?skills=</code> in a Workana skill link.</span>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card space-y-3 p-4">
            <div className="flex items-center">
              <h2 className="mr-auto font-semibold">📨 Telegram alerts</h2>
              <Toggle checked={v.telegram.enabled} onChange={(x) => setTg({ enabled: x })}>enabled</Toggle>
            </div>
            <div><span className="label">Bot token</span>
              <input className="input font-mono" type="password" placeholder="123456789:AAF..." value={v.telegram.bot_token}
                onChange={(e) => setTg({ bot_token: e.target.value })} /></div>
            <div><span className="label">Chat ID(s)</span>
              <input className="input font-mono" placeholder="e.g. 8961977816, -1001234567890" value={v.telegram.chat_ids}
                onChange={(e) => setTg({ chat_ids: e.target.value })} />
              <p className="mt-1 text-xs text-slate-500">Comma-separated. Groups start with a minus sign.</p></div>
            <div className="flex items-center gap-2">
              <button className="btn-ghost" disabled={tgBusy || !v.telegram.bot_token || !v.telegram.chat_ids} onClick={testTelegram}>
                {tgBusy ? "⏳ Sending…" : "📨 Send test"}</button>
              {tgResult && <span className={`text-xs ${tgResult.ok ? "text-emerald-600" : "text-rose-600"}`}>{tgResult.text}</span>}
            </div>
            <p className="text-xs text-slate-500">Each new job is sent with budget, client info, the account it was assigned to and a link to open it here.</p>
          </div>

          <div className="card flex min-h-72 flex-col p-4">
            <h2 className="mb-2 flex items-center font-semibold">📋 Live fetch log
              <span className="ml-auto text-xs font-normal text-slate-400">all logs: Logs page</span></h2>
            <div className="min-h-0 flex-1 overflow-auto rounded-md bg-slate-950 p-3 font-mono text-[11px] leading-relaxed">
              {fetchLogs.length === 0 && <span className="italic text-slate-500">No fetch activity yet.</span>}
              {fetchLogs.map((l) => (
                <div key={l.id} className={l.level === "error" ? "text-rose-400" : l.level === "warn" ? "text-amber-300"
                  : /new job|started|first run/.test(l.message) ? "text-emerald-400" : "text-slate-400"}>
                  <span className="text-slate-600">{fmtTime(l.ts)} </span>{l.message}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Import settings from the old bot"
        footer={<><button className="btn-ghost" onClick={() => setImportOpen(false)}>Cancel</button>
          <button className="btn-primary" onClick={doImport}>Import</button></>}>
        <p className="mb-2 text-slate-600">Open the old bot's <code>.env</code> (in the <code>workana</code> folder) in Notepad, copy everything and paste it here.
          Languages, budgets, skills, client filters, interval and Telegram are filled in — nothing is saved until you click <b>Save &amp; apply</b>.</p>
        <textarea className="input h-48 font-mono !text-xs" placeholder={"LANGUAGES=es,pt\nMIN_BUDGET_USD=100\nSKILLS=wordpress,python\n..."}
          value={importText} onChange={(e) => setImportText(e.target.value)} />
        {f.skills.some((s) => !SKILL_LABEL[s]) && <p className="mt-1 text-xs text-slate-500">Unknown slugs are kept as custom skills.</p>}
      </Modal>
    </div>
  );
}
