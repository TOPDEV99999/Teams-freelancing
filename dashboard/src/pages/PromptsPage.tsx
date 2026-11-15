import { useEffect, useRef, useState } from "react";
import { api, type Account, type PromptPreview, type SettingsResponse, type Style } from "../api";
import { useStore } from "../store";

const CARD_COLORS = ["border-t-indigo-500", "border-t-emerald-500", "border-t-amber-500", "border-t-rose-500"];

function insertAt(el: HTMLTextAreaElement | null, value: string, text: string, set: (v: string) => void) {
  if (!el) { set(value + text); return; }
  const a = el.selectionStart ?? value.length;
  const b = el.selectionEnd ?? value.length;
  set(value.slice(0, a) + text + value.slice(b));
  requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = a + text.length; });
}

function VarChips({ vars, onPick }: { vars: string[]; onPick: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {vars.map((t) => (
        <button key={t} type="button" title="insert at cursor" onClick={() => onPick(`{${t}}`)}
          className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 hover:bg-indigo-100">{`{${t}}`}</button>
      ))}
    </div>
  );
}

function AccountPromptCard({ acc, color, vars, master, onPreview }: {
  acc: Account; color: string; vars: string[]; master: string; onPreview: (accountId: string, template: string) => void;
}) {
  const { upsertAccount, toast } = useStore();
  const [prompt, setPrompt] = useState(acc.prompt_template ?? "");
  const [profile, setProfile] = useState(acc.profile_text ?? "");
  const [showProfile, setShowProfile] = useState(!acc.profile_text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const dirty = prompt !== (acc.prompt_template ?? "") || profile !== (acc.profile_text ?? "");

  useEffect(() => { if (!dirty) { setPrompt(acc.prompt_template ?? ""); setProfile(acc.profile_text ?? ""); } },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [acc.prompt_template, acc.profile_text]);

  const save = async () => {
    try {
      upsertAccount(await api.updateAccount(acc.id, { prompt_template: prompt, profile_text: profile }));
      toast(`${acc.display_name || acc.id}: saved`, "ok");
    } catch (e) { toast((e as Error).message); }
  };
  const custom = prompt.trim().length > 0;

  return (
    <div className={`card flex flex-col gap-2 border-t-4 p-4 ${color}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{acc.display_name || acc.id}</h2>
        <code className="text-xs text-slate-400">{acc.id}</code>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${custom ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-500"}`}>
          {custom ? "own prompt" : "uses master prompt"}</span>
        {!acc.active && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-600">inactive</span>}
        <span className="ml-auto" />
        <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => setPrompt(master)} title="start from the master prompt">Copy master</button>
        <button className="btn-ghost !px-2 !py-1 text-xs" disabled={!custom} onClick={() => setPrompt("")} title="empty = use master">Clear</button>
      </div>
      <textarea ref={ref} className="input h-72 font-mono !text-xs leading-relaxed" value={prompt}
        placeholder={"Empty = this account uses the master prompt (below).\n\nWrite this freelancer's own prompt here, or click “Copy master” and edit it.\nKeep {job.description} and {json_format}."}
        onChange={(e) => setPrompt(e.target.value)} />
      <VarChips vars={vars} onPick={(t) => insertAt(ref.current, prompt, t, setPrompt)} />
      <div>
        <button className="text-xs font-medium text-indigo-600 hover:underline" onClick={() => setShowProfile(!showProfile)}>
          {showProfile ? "▾" : "▸"} Profile text <span className="font-normal text-slate-500">— fills {"{account.profile_text}"}
            {!profile.trim() && <b className="text-amber-600"> (empty!)</b>}</span>
        </button>
        {showProfile && <textarea className="input mt-1 h-28 !text-xs" value={profile} onChange={(e) => setProfile(e.target.value)}
          placeholder="Skills, experience, past projects, languages, what this freelancer does NOT do…" />}
      </div>
      <div className="flex items-center gap-2">
        <button className="btn-ghost" onClick={() => onPreview(acc.id, prompt)}>👁 Preview</button>
        <span className="ml-auto text-xs text-amber-600">{dirty ? "unsaved changes" : ""}</span>
        <button className="btn-primary" disabled={!dirty} onClick={save}>Save</button>
      </div>
    </div>
  );
}

export default function PromptsPage() {
  const { accounts, toast } = useStore();
  const [meta, setMeta] = useState<SettingsResponse | null>(null);
  const [master, setMaster] = useState("");
  const [styles, setStyles] = useState<Style[]>([]);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const masterRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.settings().then((r) => { setMeta(r); setMaster(r.values.master_prompt); setStyles(r.values.styles); })
      .catch((e) => toast((e as Error).message));
  }, [toast]);

  if (!meta) return <div className="p-6 text-slate-400">Loading…</div>;
  const accountList = Object.values(accounts).sort((a, b) => a.id.localeCompare(b.id));

  const saveMaster = async () => {
    try {
      const r = await api.saveSettings({ master_prompt: master, styles });
      setMaster(r.values.master_prompt); setStyles(r.values.styles); setDirty(false);
      toast("Master prompt & styles saved", "ok");
    } catch (e) { toast((e as Error).message); }
  };
  const openPreview = async (accountId: string, template: string) => {
    try { setPreview(await api.promptPreview(accountId, template)); } catch (e) { toast((e as Error).message); }
  };
  const setStyle = (i: number, patch: Partial<Style>) => { setStyles(styles.map((x, j) => (j === i ? { ...x, ...patch } : x))); setDirty(true); };

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-7xl space-y-4 pb-16">
        <div>
          <h1 className="text-xl font-semibold">Prompts</h1>
          <p className="text-sm text-slate-500">
            Each account (freelancer) can have its <b>own prompt</b>. When a job is assigned to an account, its prompt is filled with the job and sent to ChatGPT.
            An empty prompt falls back to the <b>master prompt</b> at the bottom. Click a <code className="text-xs">{"{variable}"}</code> to insert it.
          </p>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          {accountList.map((a, i) => (
            <AccountPromptCard key={a.id} acc={a} color={CARD_COLORS[i % CARD_COLORS.length]} vars={meta.template_variables}
              master={master} onPreview={openPreview} />
          ))}
        </div>

        <div className="card space-y-2 border-t-4 border-t-slate-500 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-lg font-semibold">Master prompt <span className="text-sm font-normal text-slate-500">— used by accounts without their own</span></h2>
            <button className="btn-ghost" onClick={() => { setMaster(meta.defaults.master_prompt); setDirty(true); }}>Reset to default</button>
            {accountList[0] && <button className="btn-ghost" onClick={() => openPreview(accountList[0].id, master)}>👁 Preview</button>}
            <button className="btn-primary" disabled={!dirty} onClick={saveMaster}>Save master &amp; styles</button>
          </div>
          <textarea ref={masterRef} className="input h-80 font-mono !text-xs leading-relaxed" value={master}
            onChange={(e) => { setMaster(e.target.value); setDirty(true); }} />
          <VarChips vars={meta.template_variables} onPick={(t) => insertAt(masterRef.current, master, t, (x) => { setMaster(x); setDirty(true); })} />

          <div className="border-t border-slate-100 pt-3">
            <div className="mb-2 flex items-center">
              <h3 className="mr-auto font-semibold">Proposal styles <span className="text-sm font-normal text-slate-500">— one draft per style, shared by all prompts via {"{styles}"}</span></h3>
              <button className="btn-ghost" onClick={() => { setStyles(meta.defaults.styles); setDirty(true); }}>Reset</button>
              <button className="btn-ghost ml-2" onClick={() => { setStyles([...styles, { key: "", instructions: "" }]); setDirty(true); }}>+ Add style</button>
            </div>
            <div className="space-y-2">
              {styles.map((s, i) => (
                <div key={i} className="flex gap-2">
                  <input className="input !w-40 font-mono" placeholder="key" value={s.key} onChange={(e) => setStyle(i, { key: e.target.value })} />
                  <input className="input" placeholder="instructions (tone, length…)" value={s.instructions}
                    onChange={(e) => setStyle(i, { instructions: e.target.value })} />
                  <button className="btn-ghost" disabled={styles.length <= 1}
                    onClick={() => { setStyles(styles.filter((_, j) => j !== i)); setDirty(true); }}>✕</button>
                </div>
              ))}
            </div>
          </div>
          <p className="text-xs text-slate-500">
            <code>{"{styles}"}</code> expands to the style list and <code>{"{json_format}"}</code> to the exact JSON the app reads back
            (style keys + price + days). Keep <code>{"{json_format}"}</code> at the end of every prompt.
          </p>
        </div>
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop p-4" onClick={() => setPreview(null)}>
          <div className="card flex max-h-[90vh] w-full max-w-4xl flex-col p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="mr-auto text-lg font-semibold">Prompt preview</h3>
              <button className="btn-ghost" onClick={() => { navigator.clipboard?.writeText(preview.prompt); toast("Copied", "ok"); }}>Copy</button>
              <button className="btn-ghost" onClick={() => setPreview(null)}>Close</button>
            </div>
            <p className="mb-2 text-xs text-slate-500">
              Using the <b>{preview.source === "account" ? "account's own" : "master"}</b> prompt with
              {preview.job.sample ? " a sample job (no jobs fetched yet)" : <> job “{preview.job.title}”</>}. This exact text is what ChatGPT receives.
            </p>
            {preview.warnings.map((w) => <p key={w} className="mb-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">⚠ {w}</p>)}
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-3 font-mono text-xs">{preview.prompt}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
