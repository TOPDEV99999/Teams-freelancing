import { useEffect, useState } from "react";
import { Icon } from "./components";
import { LANGUAGES, readTarget, saveTarget, translateTexts, type Provider } from "./translate";

export interface TranslateItem { label: string; text: string }

/**
 * Small sidebar on the right with the translated text. View only: nothing here is sent to Workana.
 */
export default function TranslatePanel({ items, sourceLang, provider, defaultTarget, onClose }: {
  items: TranslateItem[]; sourceLang?: string; provider: Provider; defaultTarget: string; onClose: () => void;
}) {
  const [target, setTarget] = useState(() => readTarget(defaultTarget));
  const [out, setOut] = useState<string[] | null>(null);
  const [used, setUsed] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = items.map((i) => i.text).join("\u0001");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    translateTexts(items.map((i) => i.text), target, provider, sourceLang)
      .then((r) => { if (alive) { setOut(r.texts); if (r.provider !== "none") setUsed(r.provider); } })
      .catch((e) => { if (alive) setErr((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, target, provider, sourceLang]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);

  return (
    <aside className="flex h-full w-[22rem] max-w-[45%] shrink-0 animate-slide-in flex-col border-l border-slate-200 bg-surface">
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5">
        <Icon name="translate" className="h-4 w-4 text-indigo-600" />
        <span className="text-sm font-semibold">Translation</span>
        <select className="input ml-auto !w-auto !py-1 !text-xs" value={target}
          onChange={(e) => { setTarget(e.target.value); saveTarget(e.target.value); }}>
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
        <button className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onClose} title="Close (Esc)">
          <Icon name="x" className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3 text-sm">
        {err && <div className="rounded-md bg-rose-50 p-2 text-rose-800">{err}</div>}
        {items.map((it, i) => (
          <section key={i}>
            <div className="label">{it.label}</div>
            {loading && !out
              ? <div className="space-y-1.5"><div className="skeleton h-3 w-full" /><div className="skeleton h-3 w-5/6" /><div className="skeleton h-3 w-2/3" /></div>
              : <p className={`whitespace-pre-wrap leading-relaxed text-slate-700 ${loading ? "opacity-50" : ""}`}>{out?.[i] ?? ""}</p>}
          </section>
        ))}
      </div>
      <div className="border-t border-slate-200 px-3 py-2 text-[11px] text-slate-500">
        For reading only — nothing here is sent to Workana.
        {used && <> · {used === "browser" ? "on-device (Chrome)" : "Google Translate"}</>}
      </div>
    </aside>
  );
}
