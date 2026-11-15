import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Activity } from "./api";
import { Badge, ConfirmDanger, Countdown, Icon, money } from "./components";
import { useStore } from "./store";

/** Header button (always visible) + drawer listing everything running, each with its own Cancel. */
export default function ActivityButton({ busyCount }: { busyCount: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} title="Everything that is running — cancel any of it"
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors
          ${busyCount ? "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100" : "border-slate-200 bg-surface text-slate-600 hover:bg-slate-100"}`}>
        <Icon name="stop" className="h-3.5 w-3.5" />
        Cancel{busyCount ? <span className="rounded-full bg-rose-500 px-1.5 text-[10px] leading-4 text-white tabular-nums">{busyCount}</span> : null}
      </button>
      {open && <ActivityDrawer onClose={() => setOpen(false)} />}
    </>
  );
}

function ActivityDrawer({ onClose }: { onClose: () => void }) {
  const { accounts, subscribe, toast } = useStore();
  const [act, setAct] = useState<Activity | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const name = (a: string) => accounts[a]?.display_name || a;

  const load = useCallback(() => { api.activity().then(setAct).catch((e) => toast((e as Error).message)); }, [toast]);
  useEffect(() => { load(); const t = window.setInterval(load, 2000); return () => window.clearInterval(t); }, [load]);
  useEffect(() => subscribe((type) => {
    if (type === "submission_updated" || type === "submission_deleted" || type === "job_updated") load();
  }), [subscribe, load]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !confirmAll) onClose(); };
    window.addEventListener("keydown", h);
    window.addEventListener("hashchange", onClose);
    return () => { window.removeEventListener("keydown", h); window.removeEventListener("hashchange", onClose); };
  }, [onClose, confirmAll]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok, "ok"); load(); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const cancelAll = () => run(async () => {
    const r = await api.cancelAll();
    setConfirmAll(false);
    setAct(r.activity);
    toast(`Cancelled ${r.generations} generation(s), ${r.submissions} submission(s); auto-send off on ${r.auto_send_off} job(s)`, "ok");
  });

  const gen = act?.generation;
  const nothing = act && !gen?.current && !gen?.queued.length && !act.submissions.length && !act.auto_jobs.length;
  const openJob = (id: string) => { location.hash = `#/jobs/${encodeURIComponent(id)}`; onClose(); };

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="flex h-full w-[28rem] max-w-full animate-slide-in flex-col bg-surface [box-shadow:var(--shadow-pop)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
          <Icon name="activity" className="h-5 w-5 text-indigo-600" />
          <h3 className="font-semibold">Running now</h3>
          <button className="ml-auto rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onClose}><Icon name="x" className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4 text-sm">
          {!act && <div className="text-slate-400">Loading…</div>}
          {nothing && <div className="rounded-lg bg-slate-50 p-4 text-center text-slate-500">Nothing is running. ✓</div>}

          {(gen?.current || !!gen?.queued.length) && (
            <section>
              <div className="label">ChatGPT</div>
              <div className="space-y-1.5">
                {gen?.current && (
                  <Row title={gen.current.job_title} sub={<>writing for <b>{name(gen.current.account_id)}</b></>} live
                    onOpen={() => openJob(gen.current!.job_id)}
                    action={<button className="btn-ghost !px-2 !py-1 text-xs" disabled={busy}
                      onClick={() => run(() => api.stopGeneration(gen.current!.job_id), "Generation stopped")}>Stop</button>} />
                )}
                {gen?.queued.map((g, i) => (
                  <Row key={`${g.job_id}:${g.account_id}:${i}`} title={g.job_title} sub={<>waiting · {name(g.account_id)}</>}
                    onOpen={() => openJob(g.job_id)}
                    action={<button className="btn-ghost !px-2 !py-1 text-xs" disabled={busy}
                      onClick={() => run(() => api.stopGeneration(g.job_id), "Removed from the queue")}>Cancel</button>} />
                ))}
                {gen?.next_at && <div className="text-xs text-slate-500">next prompt <Countdown until={gen.next_at} /></div>}
              </div>
            </section>
          )}

          {!!act?.submissions.length && (
            <section>
              <div className="label">Proposals to send</div>
              <div className="space-y-1.5">
                {act.submissions.map((s) => (
                  <Row key={s.id} title={s.job_title ?? s.job_id} onOpen={() => openJob(s.job_id)}
                    live={s.status === "sending"}
                    sub={<span className="flex flex-wrap items-center gap-1.5">
                      <Badge status={s.status} /> {name(s.account_id)} · {money(s.price, s.currency)}
                      {s.auto && <span className="text-indigo-600" title="queued by auto-send">⚡ auto</span>}
                      {s.status === "queued" && (s.review_until
                        ? <span className="text-amber-700">review <Countdown until={s.review_until} prefix="" /></span>
                        : s.blocked ? <span className="text-amber-700">{s.blocked}</span>
                          : <span className="text-slate-500">dispatch <Countdown until={s.not_before ?? null} /></span>)}
                    </span>}
                    action={<div className="flex gap-1">
                      {s.review_until && <button className="btn-ghost !px-2 !py-1 text-xs" disabled={busy} title="End the review window and send when the queue allows"
                        onClick={() => run(() => api.release(s.id), "Released")}>Send now</button>}
                      <button className="btn-ghost !px-2 !py-1 text-xs" disabled={busy}
                        onClick={() => run(() => api.cancel(s.id), s.status === "sending" ? "Stopped — nothing more is clicked" : "Cancelled")}>
                        {s.status === "sending" ? "Stop" : "Cancel"}
                      </button>
                    </div>} />
                ))}
              </div>
            </section>
          )}

          {!!act?.auto_jobs.length && (
            <section>
              <div className="label">Jobs with auto-send on</div>
              <div className="space-y-1">
                {act.auto_jobs.map((j) => (
                  <button key={j.job_id} onClick={() => openJob(j.job_id)} className="block w-full truncate rounded-md px-2 py-1 text-left text-xs text-slate-600 hover:bg-slate-100">⚡ {j.job_title}</button>
                ))}
              </div>
            </section>
          )}
        </div>
        <div className="border-t border-slate-200 p-4">
          <button className="btn-danger w-full justify-center" disabled={busy || !!nothing} onClick={() => setConfirmAll(true)}>
            <Icon name="stop" className="h-4 w-4" /> Cancel everything
          </button>
          <p className="mt-2 text-xs text-slate-500">Stops ChatGPT, removes every queued proposal, stops the ones being filled in and switches auto-send off. Proposals already sent on Workana stay sent.</p>
        </div>
      </div>
      <ConfirmDanger open={confirmAll} title="Cancel everything?" action="Cancel everything" busy={busy}
        onClose={() => setConfirmAll(false)} onConfirm={cancelAll}>
        All generations and all queued or in-progress proposals are cancelled, and auto-send is switched off on every job.
        If you already clicked Workana&apos;s Send on a page, check it there.
      </ConfirmDanger>
    </div>
  );
}

function Row({ title, sub, action, live, onOpen }: { title: string; sub: ReactNode; action: ReactNode; live?: boolean; onOpen: () => void }) {
  return (
    <div className="card flex items-center gap-2 px-3 py-2">
      {live && <span className="relative flex h-2 w-2 shrink-0"><span className="ping-soft absolute h-full w-full rounded-full bg-indigo-400" /><span className="relative h-2 w-2 rounded-full bg-indigo-500" /></span>}
      <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <div className="truncate font-medium">{title}</div>
        <div className="text-xs text-slate-500">{sub}</div>
      </button>
      {action}
    </div>
  );
}
