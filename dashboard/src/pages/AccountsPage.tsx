import { useEffect, useState } from "react";
import { api, ago, CURRENCY_NAME, type Account, type Currency } from "../api";
import { Countdown, Icon, Light, Modal } from "../components";
import { useStore } from "../store";

type Form = {
  display_name: string; chrome_profile: string; profile_text: string; categories: string;
  min_budget: string; default_rate: string; daily_limit: string; min_delay_seconds: string;
  active: boolean; auto_generate: boolean; currency: Currency;
};

const toForm = (a: Account): Form => ({
  display_name: a.display_name, chrome_profile: a.chrome_profile, profile_text: a.profile_text,
  categories: a.categories.join(", "), min_budget: a.min_budget?.toString() ?? "",
  default_rate: a.default_rate?.toString() ?? "", daily_limit: String(a.daily_limit),
  min_delay_seconds: String(a.min_delay_seconds), active: a.active, auto_generate: a.auto_generate,
  currency: a.currency ?? "USD",
});

const fromForm = (f: Form): Partial<Account> => ({
  display_name: f.display_name.trim(), chrome_profile: f.chrome_profile.trim(), profile_text: f.profile_text,
  categories: f.categories.split(",").map((s) => s.trim()).filter(Boolean),
  min_budget: f.min_budget ? Number(f.min_budget) : null, default_rate: f.default_rate ? Number(f.default_rate) : null,
  daily_limit: Number(f.daily_limit) || 0, min_delay_seconds: Number(f.min_delay_seconds) || 0,
  active: f.active, auto_generate: f.auto_generate, currency: f.currency,
});

function AccountCard({ a }: { a: Account }) {
  const { ext, toast, upsertAccount } = useStore();
  const [form, setForm] = useState<Form>(() => toForm(a));
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(false);
  const connected = !!ext.workana[a.id]?.connected;

  useEffect(() => { if (!dirty) setForm(toForm(a)); }, [a, dirty]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setForm((f) => ({ ...f, [k]: v })); setDirty(true); };

  const save = async () => {
    try { upsertAccount(await api.updateAccount(a.id, fromForm(form))); setDirty(false); toast("Saved", "ok"); }
    catch (e) { toast((e as Error).message); }
  };
  const [renameOpen, setRenameOpen] = useState(false);
  const [newId, setNewId] = useState(a.id);
  const [delOpen, setDelOpen] = useState(false);
  const [hist, setHist] = useState<{ submissions: number; drafts: number; notices: number } | null>(null);
  const [purge, setPurge] = useState(false);
  const [working, setWorking] = useState(false);
  const openDelete = async () => {
    setPurge(false);
    setHist(null);
    setDelOpen(true);
    try { setHist(await api.accountHistory(a.id)); } catch (e) { toast((e as Error).message); }
  };
  const remove = async () => {
    setWorking(true);
    try { await api.deleteAccountPurge(a.id, purge); toast(`Account ${a.id} deleted`, "ok"); setDelOpen(false); }
    catch (e) { toast((e as Error).message); }
    finally { setWorking(false); }
  };
  const rename = async () => {
    setWorking(true);
    try {
      const r = await api.renameAccount(a.id, newId.trim().toLowerCase());
      toast(`ID changed to ${r.id}. Now set Account ID = ${r.id} in that profile's Workana extension popup.`, "ok");
      setRenameOpen(false);
    } catch (e) { toast((e as Error).message); }
    finally { setWorking(false); }
  };
  const resume = async () => {
    try { upsertAccount(await api.resumeAccount(a.id)); } catch (e) { toast((e as Error).message); }
  };

  const used = a.today_count ?? 0;
  const pct = a.daily_limit ? Math.min(100, (used / a.daily_limit) * 100) : 100;

  return (
    <div className={`card p-4 ${!a.active ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-40">
          <div className="font-semibold">{a.display_name || a.id}</div>
          <div className="text-xs text-slate-500"><code>{a.id}</code> · {a.chrome_profile || "no profile label"}</div>
        </div>
        <Light on={connected} warn={a.paused} label={connected ? "extension online" : "extension offline"}
          title={a.last_seen_at ? `last seen ${ago(a.last_seen_at)}` : undefined} />
        <div className="w-48">
          <div className="mb-0.5 text-xs text-slate-500">today {used} / {a.daily_limit}</div>
          <div className="h-1.5 rounded bg-slate-200"><div className={`h-1.5 rounded ${pct >= 100 ? "bg-rose-500" : "bg-indigo-500"}`} style={{ width: `${pct}%` }} /></div>
        </div>
        {a.next_allowed_at && new Date(a.next_allowed_at) > new Date() && (
          <div className="text-xs text-amber-700">next send <Countdown until={a.next_allowed_at} /></div>
        )}
        {a.paused && (
          <div className="flex items-center gap-2 text-xs text-amber-800">
            ⚠️ paused: <code>{a.pause_reason}</code> <button className="btn-ghost !py-0.5" onClick={resume}>Resume</button>
          </div>
        )}
        <div className="ml-auto flex gap-2">
          <button className="btn-ghost" onClick={() => { setNewId(a.id); setRenameOpen(true); }} title="Change this account's ID">Change ID</button>
          <button className="btn-ghost" onClick={() => setOpen((o) => !o)}>{open ? "Close" : "Edit"}</button>
          <button className="btn-ghost !text-rose-700" onClick={openDelete} title="Delete this account"><Icon name="trash" className="h-4 w-4" /></button>
        </div>
      </div>

      {open && (
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4">
          <div><span className="label">Display name</span><input className="input" value={form.display_name} onChange={(e) => set("display_name", e.target.value)} /></div>
          <div><span className="label">Chrome profile (label)</span><input className="input" value={form.chrome_profile} onChange={(e) => set("chrome_profile", e.target.value)} /></div>
          <div><span className="label">Min budget (USD)</span><input className="input" type="number" value={form.min_budget} onChange={(e) => set("min_budget", e.target.value)} /></div>
          <div><span className="label">Default rate / price (USD)</span><input className="input" type="number" value={form.default_rate} onChange={(e) => set("default_rate", e.target.value)} /></div>
          <div title="The currency this Workana account bids in. Prices are decided in USD and converted with the rates in Settings when the form is filled.">
            <span className="label">Bid currency on Workana</span>
            <select className="input" value={form.currency} onChange={(e) => set("currency", e.target.value as Currency)}>
              {(Object.keys(CURRENCY_NAME) as Currency[]).map((c) => <option key={c} value={c}>{CURRENCY_NAME[c]}</option>)}
            </select></div>
          <div className="md:col-span-4"><span className="label">Categories / keywords (comma separated — used for auto-assignment)</span>
            <input className="input" value={form.categories} onChange={(e) => set("categories", e.target.value)} placeholder="wordpress, elementor, landing page" /></div>
          <div className="md:col-span-4"><span className="label">Profile text (the ONLY facts the AI may use)</span>
            <textarea className="input h-40" value={form.profile_text} onChange={(e) => set("profile_text", e.target.value)}
              placeholder="Skills, years of experience, notable projects, portfolio links, languages…" /></div>
          <div><span className="label">Daily limit</span><input className="input" type="number" min={0} value={form.daily_limit} onChange={(e) => set("daily_limit", e.target.value)} /></div>
          <div><span className="label">Min delay between sends (s)</span><input className="input" type="number" min={0} value={form.min_delay_seconds} onChange={(e) => set("min_delay_seconds", e.target.value)} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} /> Active</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.auto_generate} onChange={(e) => set("auto_generate", e.target.checked)} /> Auto-generate drafts for new jobs</label>
          <div className="flex gap-2 md:col-span-4">
            <button className="btn-primary" disabled={!dirty} onClick={save}>Save</button>
            <button className="btn-ghost" disabled={!dirty} onClick={() => { setForm(toForm(a)); setDirty(false); }}>Revert</button>
          </div>
        </div>
      )}

      <Modal open={renameOpen} onClose={() => setRenameOpen(false)} title={`Change the ID of ${a.display_name || a.id}`}
        footer={<>
          <button className="btn-ghost" onClick={() => setRenameOpen(false)}>Cancel</button>
          <button className="btn-primary" disabled={working || newId.trim().toLowerCase() === a.id || newId.trim().length < 2} onClick={rename}>Change ID</button>
        </>}>
        <div className="space-y-3">
          <div><span className="label">New ID</span>
            <input className="input" value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="e.g. maria" autoFocus /></div>
          <p className="text-slate-600">2–32 characters: lowercase letters, numbers, <code>_</code> or <code>-</code>. Jobs, drafts, bids, logs and messages move to the new ID.</p>
          <p className="rounded-md bg-amber-50 p-2 text-amber-900">Afterwards, open the Workana extension popup in <b>that</b> browser profile and set <b>Account ID</b> to the new ID, then Save. Until then it shows “unknown account id”.</p>
        </div>
      </Modal>

      <Modal open={delOpen} onClose={() => setDelOpen(false)} title={`Delete ${a.display_name || a.id}?`}
        footer={<>
          <button className="btn-ghost" onClick={() => setDelOpen(false)}>Keep</button>
          <button className="btn-danger" disabled={working || !hist || (!!hist.submissions && !purge)} onClick={remove}>Delete account</button>
        </>}>
        <div className="space-y-3">
          {!hist ? <div className="skeleton h-10" /> : hist.submissions || hist.drafts ? (
            <>
              <p>This account has <b>{hist.submissions}</b> bid(s), <b>{hist.drafts}</b> generated proposal(s) and <b>{hist.notices}</b> message(s) in its history.</p>
              <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
                <span>Also delete this history (its bids will disappear from Stats). Other accounts&apos; history stays.</span></label>
              {!purge && !!hist.submissions && <p className="text-xs text-slate-500">Tip: to keep the history, untick <b>Active</b> in Edit instead of deleting.</p>}
            </>
          ) : <p>This account has no history. It is removed from every job it was selected for.</p>}
          <p className="text-xs text-slate-500">That profile&apos;s Workana extension is disconnected; set another Account ID there if you reuse the profile.</p>
        </div>
      </Modal>
    </div>
  );
}

export default function AccountsPage() {
  const { accounts, reloadAccounts, toast } = useStore();
  const [newId, setNewId] = useState("");
  useEffect(() => { reloadAccounts().catch(() => {}); }, [reloadAccounts]);

  const create = async () => {
    try { await api.createAccount({ id: newId.trim().toLowerCase() }); setNewId(""); await reloadAccounts(); toast("Account created", "ok"); }
    catch (e) { toast((e as Error).message); }
  };

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-5xl space-y-3">
        <div className="flex items-end gap-2">
          <h1 className="mr-auto text-xl font-semibold">Accounts</h1>
          <div><span className="label">New account id</span><input className="input" value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="e.g. friend_d" /></div>
          <button className="btn-primary" disabled={newId.trim().length < 2} onClick={create}>Add</button>
        </div>
        <p className="text-sm text-slate-500">
          The <b>account id</b> must match the Account ID typed into the Workana extension popup in that Chrome profile.
        </p>
        {Object.values(accounts).sort((a, b) => a.id.localeCompare(b.id)).map((a) => <AccountCard key={a.id} a={a} />)}
      </div>
    </div>
  );
}
