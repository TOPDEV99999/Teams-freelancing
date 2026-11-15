import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ago, CURRENCY_SYMBOL, toLocal, toUsd, type Draft, type Job, type Submission } from "../api";
import { Badge, ConfirmDanger, Countdown, Icon, LastSeen, Modal, Switch, TrustBadge, isTypingTarget, money } from "../components";
import { useStore } from "../store";
import TranslatePanel, { type TranslateItem } from "../TranslatePanel";
import type { Provider } from "../translate";

const JOB_EVENTS = new Set(["job_updated", "drafts_ready", "submission_updated", "submission_deleted"]);

/** One account's state on this job, for the tab badges. */
function accountState(job: Job, accId: string): { label: string; tone: string } {
  const sub = job.submissions?.find((x) => x.account_id === accId);
  if (sub) return { label: sub.status, tone: sub.status };
  if (job.generating_accounts?.includes(accId)) return { label: "generating…", tone: "generating" };
  if ((job.drafts_by_account?.[accId] ?? []).length) return { label: "drafts ready", tone: "drafted" };
  return { label: "no drafts", tone: "new" };
}

export default function JobDetail({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const { accounts, ext, subscribe, toast, upsertJob } = useStore();
  const [job, setJob] = useState<Job | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [style, setStyle] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<number, string>>({});
  const [price, setPrice] = useState("");
  const [days, setDays] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [styleKeys, setStyleKeys] = useState<string[]>([]);
  const [tr, setTr] = useState<{ provider: Provider; target: string }>({ provider: "auto", target: "en" });
  const [rates, setRates] = useState<{ BRL: number; MXN: number } | undefined>(undefined);
  const [translate, setTranslate] = useState<"job" | "proposal" | "all" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const draftSetKey = useRef("");

  const load = useCallback(async () => {
    try { setJob(await api.job(jobId)); }
    catch (e) { toast((e as Error).message); }
  }, [jobId, toast]);

  useEffect(() => { load(); }, [load]);
  // Opened in the dashboard: refresh this client's last login first (and every few minutes while open).
  useEffect(() => {
    api.watchPresence(jobId).catch(() => undefined);
    const t = window.setInterval(() => api.watchPresence(jobId).catch(() => undefined), 4 * 60 * 1000);
    return () => window.clearInterval(t);
  }, [jobId]);
  useEffect(() => subscribe((type, data) => {
    if (JOB_EVENTS.has(type) && (data?.job_id ?? data?.id) === jobId) load();
  }), [subscribe, jobId, load]);
  useEffect(() => {
    api.settings().then((r) => {
      setStyleKeys(r.values.styles.map((x) => x.key));
      if (r.values.translation) setTr(r.values.translation);
      if (r.values.currency_rates) setRates(r.values.currency_rates);
    }).catch(() => undefined);
  }, []);

  const accountList = useMemo(() => Object.values(accounts).sort((a, b) => a.id.localeCompare(b.id)), [accounts]);
  const targets = job?.targets ?? [];
  // Focus = the account whose drafts / send form are shown. Keep it on a selected account.
  useEffect(() => {
    if (!job) return;
    if (!focus || !targets.includes(focus)) setFocus(job.assigned_account_id && targets.includes(job.assigned_account_id) ? job.assigned_account_id : targets[0] ?? null);
  }, [job, targets, focus]);

  const drafts: Draft[] = (focus && job?.drafts_by_account?.[focus]) || [];
  const acc = focus ? accounts[focus] : undefined;
  const sub: Submission | undefined = job?.submissions?.find((x) => x.account_id === focus);

  // A new set of drafts arrived (or another account was focused) -> reset editor state.
  useEffect(() => {
    const key = `${focus}:` + drafts.map((d) => d.id).join(",");
    if (key === draftSetKey.current) return;
    draftSetKey.current = key;
    setTexts(Object.fromEntries(drafts.map((d) => [d.id, d.text])));
    if (drafts.length) {
      const first = drafts.find((d) => d.style === style) ?? drafts[0];
      setStyle(first.style);
      // Suggestions and budgets are USD; the form takes the account's currency (what is typed into Workana).
      const usd = first.suggested_price ?? acc?.default_rate ?? job?.budget_min;
      setPrice(usd == null ? "" : String(toLocal(usd, acc?.currency, rates)));
      setDays(String(first.suggested_days ?? ""));
    } else {
      setStyle(null);
    }
  }, [drafts, focus, style, acc?.default_rate, acc?.currency, rates, job?.budget_min]);

  const selected: Draft | undefined = drafts.find((d) => d.style === style);
  const finalText = selected ? texts[selected.id] ?? selected.text : "";
  const connected = !!(focus && ext.workana[focus]?.connected);
  const generatingFocus = !!(focus && job?.generating_accounts?.includes(focus));

  const blockReason = !job ? "loading"
    : job.status === "skipped" ? "job is skipped"
    : !focus ? "select an account"
    : sub ? "this account already has a proposal for this job"
    : !acc?.active ? "account inactive"
    : acc?.paused ? `account paused (${acc.pause_reason})`
    : !connected ? "account's Workana extension is offline"
    : (acc.today_count ?? 0) >= acc.daily_limit ? "daily limit reached"
    : !selected ? "generate or pick a draft"
    : finalText.trim().length < 20 ? "text too short"
    : !(Number(price) > 0) ? "set a price"
    : !(Number(days) >= 1) ? "set delivery days"
    : null;

  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    try { await fn(); if (okMsg) toast(okMsg, "ok"); await load(); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };

  const pending = targets.filter((a) => !job?.submissions?.some((x) => x.account_id === a));
  const generateAll = () => run(async () => {
    const r = await api.generate(jobId);
    toast(`Generating for ${r.accounts.join(", ")} — one after another`, "ok");
  });
  const generateOne = (a: string) => run(() => api.generate(jobId, [a]), `Generating for ${accounts[a]?.display_name ?? a}`);
  const skip = () => run(async () => upsertJob(job?.status === "skipped" ? await api.unskip(jobId) : await api.skip(jobId)));
  const setTargets = (list: string[]) => run(async () => upsertJob(await api.updateJob(jobId, { target_accounts: list })));
  const toggleTarget = (a: string) => setTargets(targets.includes(a) ? targets.filter((x) => x !== a) : [...targets, a]);
  const setAuto = (patch: { auto_send?: boolean; auto_style?: string }) => run(async () => upsertJob(await api.updateJob(jobId, patch)));
  const saveDraftText = (d: Draft) => {
    const t = texts[d.id];
    if (t !== undefined && t !== d.text && !sub) {
      api.editDraft(d.id, t).catch((e) => toast((e as Error).message));
    }
  };
  const doSend = () => {
    if (!job || !selected || !focus || blockReason) return;
    setConfirm(false);
    saveDraftText(selected);
    run(() => api.send(jobId, {
      account_id: focus, draft_id: selected.id, final_text: finalText.trim(),
      price: Number(price), days: Number(days),
    }), "Queued for sending");
  };

  const deleteJob = () => run(async () => {
    await api.deleteJob(jobId);
    setConfirmDelete(false);
    toast("Job deleted", "ok");
    onClose();
  });

  // Keyboard: 1–9 style, G generate (all selected accounts), S send, X skip, T translate, Esc close
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (confirm) { if (e.key === "Enter") { e.preventDefault(); doSend(); } return; }
      if (isTypingTarget(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (/^[1-9]$/.test(k) && drafts[Number(k) - 1]) { setStyle(drafts[Number(k) - 1].style); e.preventDefault(); }
      else if (k === "g" && !busy && job && pending.length) { e.preventDefault(); generateAll(); }
      else if (k === "s" && !blockReason) { e.preventDefault(); setConfirm(true); }
      else if (k === "x" && job) { e.preventDefault(); skip(); }
      else if (k === "t" && job) { e.preventDefault(); setTranslate((t) => (t ? null : "job")); }
      else if (k === "escape" && !translate) onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  if (!job) return <div className="p-6 text-slate-400">Loading…</div>;
  const hasSub = (a: string) => !!job.submissions?.some((x) => x.account_id === a);
  const allSelected = accountList.length > 0 && accountList.every((a) => targets.includes(a.id));
  const accName = acc?.display_name ?? focus ?? "";
  const trItems: TranslateItem[] = translate === "job"
    ? [{ label: "Title", text: job.title }, { label: "Description", text: job.description || "" }]
    : translate === "proposal" && selected
      ? [{ label: `Proposal — ${selected.style} (${accName})`, text: finalText }]
      : translate === "all"
        ? drafts.map((d) => ({ label: `Proposal — ${d.style} (${accName})`, text: texts[d.id] ?? d.text }))
        : [];
  const lang = typeof job.client_info?.language === "string" ? (job.client_info.language as string) : undefined;

  return (
    <div className="flex h-full">
    <div className="flex h-full min-w-0 flex-1 animate-fade flex-col overflow-auto bg-canvas">
      <div className="glass sticky top-0 z-10 border-b border-slate-200 p-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-tight">{job.title}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <Badge status={job.status} />
              <TrustBadge trust={job.trust} />
              <LastSeen info={job.client_info ?? {}} />
              <span>{job.budget_text || "no budget"}</span>
              {job.category && <span>· {job.category}</span>}
              <span>· fetched {ago(job.fetched_at)}</span>
              <a className="text-indigo-600 hover:underline" href={job.url} target="_blank" rel="noreferrer">open on Workana ↗</a>
            </div>
          </div>
          <button className={`btn-ghost !px-2 ${translate === "job" ? "!border-indigo-400 !text-indigo-700" : ""}`} title="Translate the job for reading (T)"
            onClick={() => setTranslate(translate === "job" ? null : "job")}><Icon name="translate" className="h-4 w-4" /></button>
          <button className="btn-ghost !px-2 !text-rose-700" title="Delete this job and its history" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" className="h-4 w-4" /></button>
          <button className="btn-ghost" onClick={onClose} title="Close (Esc)">✕</button>
        </div>
      </div>

      <div className="space-y-4 p-4">
        {job.last_error && <div className="rounded-md bg-rose-50 p-2 text-sm text-rose-800">{job.last_error}</div>}

        {/* Which accounts bid on this job */}
        <div className="card space-y-3 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label !mb-0 mr-1">Accounts bidding</span>
            {accountList.map((a) => {
              const on = targets.includes(a.id);
              const lockedOn = on && hasSub(a.id);
              return (
                <button key={a.id} disabled={busy || lockedOn} onClick={() => toggleTarget(a.id)}
                  title={lockedOn ? "already has a proposal for this job" : on ? "remove" : "add"}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${on
                    ? "border-indigo-500 bg-indigo-500 text-white shadow-[0_2px_8px_-2px_rgb(99_102_241/0.6)]"
                    : "border-slate-200 bg-surface text-slate-600 hover:border-indigo-300 hover:text-slate-900"}`}>
                  {a.display_name || a.id}
                  {job.scores?.[a.id] !== undefined && job.scores[a.id] > 0 && (
                    <span className={`rounded-full px-1 text-[10px] tabular-nums ${on ? "bg-white/25" : "bg-slate-100 text-slate-500"}`}
                      title="keyword match score">{job.scores[a.id]}</span>
                  )}
                </button>
              );
            })}
            <button className="btn-ghost !px-2 !py-1 text-xs" disabled={busy || allSelected}
              onClick={() => setTargets(accountList.map((a) => a.id))}>Select all</button>
            <button className="btn-ghost !px-2 !py-1 text-xs" disabled={busy || !targets.length}
              onClick={() => setTargets([])}>Clear</button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Switch checked={job.auto_send} disabled={busy} onChange={(v) => setAuto({ auto_send: v })} label="Auto-send after generating"
              title="Queue each account's proposal automatically as soon as its drafts are ready" />
            {job.auto_send && (
              <select className="input !w-40 !py-1 text-xs" value={job.auto_style} disabled={busy}
                onChange={(e) => setAuto({ auto_style: e.target.value })}>
                <option value="">first style</option>
                {styleKeys.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            )}
            <div className="ml-auto flex gap-2">
              {!!job.generating_accounts?.length && (
                <button className="btn-ghost animate-fade" disabled={busy} title="Cancel this job's generations: the accounts still waiting and the one ChatGPT is writing now"
                  onClick={() => run(async () => { const r = await api.stopGeneration(jobId); toast(`${r.dropped} generation(s) cancelled`, "ok"); })}>
                  <span className="h-2.5 w-2.5 rounded-[3px] bg-rose-500" /> Stop
                </button>
              )}
              <button className="btn-primary" disabled={busy || !pending.length || job.status === "skipped"} onClick={generateAll}
                title="Each selected account gets its own prompt; they run one after another">
                {!job.generating_accounts?.length && <Icon name="spark" className="h-4 w-4" />}
                {job.generating_accounts?.length ? `Generating… (${job.generating_accounts.length})`
                  : `Generate for ${pending.length} account${pending.length === 1 ? "" : "s"}`} <kbd className="!bg-indigo-500 !text-white">G</kbd>
              </button>
              <button className="btn-ghost" disabled={busy} onClick={skip}>
                {job.status === "skipped" ? "Un-skip" : "Skip"} <kbd>X</kbd>
              </button>
            </div>
          </div>
          {job.auto_send && (
            <p className="text-xs text-slate-500">
              Each account's proposal is queued as soon as its drafts are ready (style: {job.auto_style || "first"}, suggested price & days).
              The queue still applies daily limits, the delay between sends and quiet hours.
            </p>
          )}
        </div>

        {/* One tab per selected account */}
        {targets.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {targets.map((a) => {
              const st = accountState(job, a);
              return (
                <button key={a} onClick={() => setFocus(a)}
                  className={`card flex items-center gap-2 px-3 py-2 text-sm ${focus === a ? "ring-2 ring-indigo-500" : "hover:border-indigo-300"}`}>
                  <b>{accounts[a]?.display_name ?? a}</b>
                  <Badge status={st.tone}>{st.label}</Badge>
                  <span className={`h-2 w-2 rounded-full ${ext.workana[a]?.connected ? "bg-emerald-500" : "bg-slate-300"}`}
                    title={ext.workana[a]?.connected ? "extension online" : "extension offline"} />
                </button>
              );
            })}
          </div>
        )}

        {focus && (
          <div className="space-y-3">
            {acc && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span><b className="text-slate-700">{acc.display_name || acc.id}</b> · today {acc.today_count ?? 0}/{acc.daily_limit}</span>
                <span>· {connected ? "🟢 extension online" : "⚪ extension offline"}</span>
                {!sub && (
                  <button className="btn-ghost ml-auto !px-2 !py-1 text-xs" disabled={busy || generatingFocus || job.status === "skipped"}
                    onClick={() => generateOne(focus)}>
                    {generatingFocus ? "Generating…" : drafts.length ? "Regenerate this account" : "Generate this account"}
                  </button>
                )}
              </div>
            )}

            {sub && (
              <div className="card p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <b>Submission #{sub.id}</b> <Badge status={sub.status} />
                  {sub.auto && <span className="rounded bg-indigo-50 px-1.5 text-[11px] font-medium text-indigo-700" title="queued by auto-send">⚡ auto</span>}
                  <span className="text-slate-500">{money(sub.price, sub.currency)} · {sub.days}d · {sub.style ?? "custom"}</span>
                  {sub.status === "queued" && (
                    <span className="text-amber-700">
                      {sub.review_until ? <>review window <Countdown until={sub.review_until} prefix="" /> — cancel now if you don&apos;t want it</>
                        : sub.blocked ? `waiting: ${sub.blocked}` : <>dispatch <Countdown until={sub.not_before ?? null} /></>}
                    </span>
                  )}
                </div>
                {sub.progress && <div className="mt-1 text-slate-600">↳ {sub.progress}</div>}
                {sub.error && <div className="mt-1 text-rose-700">Error: {sub.error}</div>}
                {sub.status !== "sent" && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {sub.status === "failed" && (
                      <button className="btn-ghost" disabled={busy} onClick={() => run(() => api.retry(sub.id), "Re-queued")}>Retry</button>
                    )}
                    {sub.review_until && (
                      <button className="btn-ghost" disabled={busy} title="End the review window now" onClick={() => run(() => api.release(sub.id), "Released")}>Send now</button>
                    )}
                    <button className="btn-ghost" disabled={busy}
                      onClick={() => window.confirm(sub.status === "sending"
                        ? "Stop this submission? The extension stops working on the page (nothing more is clicked). If you already clicked Send on Workana, use \"Mark as sent\" instead."
                        : "Cancel this submission so it can be redone? Make sure nothing was actually posted on Workana.")
                        && run(() => api.cancel(sub.id), "Cancelled")}>
                      {sub.status === "sending" ? "■ Cancel sending" : sub.status === "queued" ? "■ Cancel" : "Cancel & unlock"}
                    </button>
                    {(sub.status === "failed" || sub.status === "sending") && (
                      <button className="btn-ghost" disabled={busy}
                        onClick={() => window.confirm("Mark as sent? Only do this if the proposal really is on Workana.")
                          && run(() => api.markSent(sub.id), "Marked as sent")}>✓ Mark as sent</button>
                    )}
                  </div>
                )}
              </div>
            )}

            {drafts.length > 0 && (
              <div>
                <div className="grid grid-cols-2 gap-2">
                  {drafts.map((d, i) => (
                    <button key={d.id} onClick={() => setStyle(d.style)}
                      className={`card p-2 text-left text-xs transition ${style === d.style ? "ring-2 ring-indigo-500" : "hover:border-indigo-300"}`}>
                      <div className="mb-1 flex items-center justify-between">
                        <b className="capitalize">{d.style}</b><kbd>{i + 1}</kbd>
                      </div>
                      <div className="line-clamp-3 text-slate-600">{texts[d.id] ?? d.text}</div>
                    </button>
                  ))}
                </div>
                {selected && !sub && (
                  <div className="mt-3">
                    <div className="flex items-center gap-2">
                      <span className="label">Proposal text ({selected.style}) — {finalText.trim().split(/\s+/).filter(Boolean).length} words</span>
                      <span className="ml-auto flex gap-1">
                        <button className="rounded-md px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50" onClick={() => setTranslate("proposal")}>
                          Translate this</button>
                        <button className="rounded-md px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50" onClick={() => setTranslate("all")}>
                          Translate all {drafts.length}</button>
                      </span>
                    </div>
                    <textarea className="input h-56 font-[inherit] leading-relaxed" value={finalText}
                      onChange={(e) => setTexts((t) => ({ ...t, [selected.id]: e.target.value }))}
                      onBlur={() => saveDraftText(selected)} />
                    <div className="mt-2 flex flex-wrap items-end gap-3">
                      <div className="w-36"><span className="label">Price ({CURRENCY_SYMBOL[acc?.currency ?? "USD"]})</span>
                        <input className="input" type="number" min={1} value={price} onChange={(e) => setPrice(e.target.value)} /></div>
                      <div className="w-32"><span className="label">Delivery (days)</span>
                        <input className="input" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} /></div>
                      {acc?.currency && acc.currency !== "USD" && (
                        <div className="pb-2 text-xs text-slate-500">
                          ≈ US$ {Math.round(toUsd(Number(price) || 0, acc.currency, rates))}
                          {job?.budget_max ? <> · client budget US$ {job.budget_min ?? "?"}–{job.budget_max} ≈ {CURRENCY_SYMBOL[acc.currency]} {toLocal(job.budget_min ?? 0, acc.currency, rates)}–{toLocal(job.budget_max, acc.currency, rates)}</> : null}
                        </div>
                      )}
                      <div className="ml-auto text-right">
                        <button className="btn-primary" disabled={!!blockReason || busy} onClick={() => setConfirm(true)}>
                          Send as {acc?.display_name ?? focus} <kbd className="!bg-indigo-500 !text-white">S</kbd>
                        </button>
                        {blockReason && <div className="mt-1 text-xs text-slate-500">{blockReason}</div>}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
            {!drafts.length && !sub && (
              <p className="text-sm text-slate-500">
                {generatingFocus ? "ChatGPT is writing this account's proposals…" : "No drafts for this account yet — click Generate."}
              </p>
            )}
          </div>
        )}
        {!targets.length && <p className="text-sm text-slate-500">Select one or more accounts above to generate proposals.</p>}

        <div className="card p-3 text-sm">
          <span className="label">Description</span>
          <p className="whitespace-pre-wrap text-slate-700">{job.description || "—"}</p>
          {job.skills.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {job.skills.map((s) => <span key={s} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{s}</span>)}
            </div>
          )}
          {job.trust && job.trust.tier !== "unknown" && (
            <div className="mt-3">
              <span className="label">Client trust</span>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <TrustBadge trust={job.trust} /> {job.trust.reasons.join(" · ")}
              </div>
            </div>
          )}
          {Object.keys(job.client_info ?? {}).length > 0 && (
            <div className="mt-3">
              <span className="label">Client</span>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                {Object.entries(job.client_info).map(([k, v]) => <span key={k}><b>{k}:</b> {String(v)}</span>)}
              </div>
            </div>
          )}
        </div>
      </div>

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Send this proposal?"
        footer={<>
          <button className="btn-ghost" onClick={() => setConfirm(false)}>Cancel</button>
          <button className="btn-primary" onClick={doSend}>Confirm send (Enter)</button>
        </>}>
        <div className="space-y-2">
          <div><b>Account:</b> {acc?.display_name ?? focus} <span className="text-slate-500">({acc?.chrome_profile})</span></div>
          <div><b>Price:</b> {money(Number(price), acc?.currency)}
            {acc?.currency && acc.currency !== "USD" ? <span className="text-slate-500"> (≈ US$ {Math.round(toUsd(Number(price) || 0, acc.currency, rates))})</span> : null}
            {" "}· <b>Delivery:</b> {days} days · <b>Style:</b> {style}</div>
          <div className="rounded bg-slate-50 p-2 text-slate-600 whitespace-pre-wrap">
            {finalText.split("\n").slice(0, 4).join("\n").slice(0, 300)}{finalText.length > 300 ? "…" : ""}
          </div>
          <div className="text-xs text-slate-500">
            The command goes only to this account's browser profile. Limits, delay and jitter are applied before dispatch.
          </div>
        </div>
      </Modal>
      <ConfirmDanger open={confirmDelete} title="Delete this job?" action="Delete job" busy={busy}
        onClose={() => setConfirmDelete(false)} onConfirm={deleteJob}>
        The job is deleted with all accounts&apos; generated proposals and bids. It will not be fetched again.
        {!!job.submissions?.some((x) => x.status === "queued" || x.status === "sending") && (
          <p className="mt-2 font-medium text-rose-700">A proposal is queued or being sent — cancel it first.</p>
        )}
      </ConfirmDanger>
    </div>
    {translate && trItems.length > 0 && (
      <TranslatePanel items={trItems} sourceLang={lang} provider={tr.provider} defaultTarget={tr.target} onClose={() => setTranslate(null)} />
    )}
    </div>
  );
}
