import { useEffect, useState, type ReactNode } from "react";
import { parseDate, type Trust } from "./api";
import { useStore } from "./store";

const STATUS_COLORS: Record<string, string> = {
  new: "bg-sky-100 text-sky-800",
  generating: "bg-amber-100 text-amber-800",
  drafted: "bg-violet-100 text-violet-800",
  sent: "bg-emerald-100 text-emerald-800",
  skipped: "bg-slate-100 text-slate-500",
  error: "bg-rose-100 text-rose-800",
  queued: "bg-amber-100 text-amber-800",
  sending: "bg-indigo-100 text-indigo-800",
  failed: "bg-rose-100 text-rose-800",
};
const LIVE = new Set(["generating", "sending", "generating…"]);

/** Status pill with a small dot; "live" states get a breathing dot instead of a blinking pill. */
export function Badge({ status, children }: { status: string; children?: ReactNode }) {
  const live = LIVE.has(status);
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_COLORS[status] ?? "bg-slate-100 text-slate-600"}`}>
      <span className="relative flex h-1.5 w-1.5">
        {live && <span className="ping-soft absolute inline-flex h-full w-full rounded-full bg-current" />}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      </span>
      {children ?? status}
    </span>
  );
}

/** Connection chip for the header (extension online / offline / paused / outdated). */
export function Light({ on, warn, label, title, outdated }: {
  on: boolean; warn?: boolean; label: string; title?: string; outdated?: boolean;
}) {
  const color = !on ? "bg-slate-300" : warn ? "bg-amber-400" : "bg-emerald-500";
  return (
    <span title={title} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors
      ${on ? "border-slate-200 bg-surface text-slate-700" : "border-dashed border-slate-300 text-slate-400"}`}>
      <span className="relative flex h-2 w-2">
        {on && !warn && <span className="ping-soft absolute inline-flex h-full w-full rounded-full bg-emerald-400" />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
      </span>
      {label}
      {outdated && <span className="rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-800">update</span>}
    </span>
  );
}

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function Countdown({ until, prefix = "in " }: { until: string | null | undefined; prefix?: string }) {
  const now = useNow();
  const d = parseDate(until);
  if (!d) return null;
  const sec = Math.round((d.getTime() - now) / 1000);
  if (sec <= 0) return <span>now</span>;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return <span className="tabular-nums">{prefix}{m > 0 ? `${m}m ` : ""}{s}s</span>;
}

export function Modal({ open, onClose, title, children, footer }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card w-full max-w-lg animate-pop p-5 [box-shadow:var(--shadow-pop)]" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-lg font-semibold tracking-tight">{title}</h3>
        <div className="mb-5 text-sm">{children}</div>
        <div className="flex justify-end gap-2">{footer}</div>
      </div>
    </div>
  );
}

export function Toasts() {
  const { toasts } = useStore();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="card pointer-events-auto flex animate-slide-up items-start gap-2.5 px-3.5 py-2.5 text-sm [box-shadow:var(--shadow-lift)]">
          <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white
            ${t.kind === "error" ? "bg-rose-500" : "bg-emerald-500"}`}>{t.kind === "error" ? "!" : "✓"}</span>
          <span className="text-slate-700">{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

/** On/off switch with a springy knob. */
export function Switch({ checked, onChange, label, disabled, title }: {
  checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; title?: string;
}) {
  return (
    <label title={title} className={`inline-flex select-none items-center gap-2 text-sm ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors
          ${checked ? "border-indigo-500 bg-indigo-500" : "border-slate-300 bg-slate-200"}`}>
        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.3)] transition-transform duration-200 [transition-timing-function:var(--ease-spring)]
          ${checked ? "translate-x-[17px]" : "translate-x-[1px]"}`} />
      </button>
      {label}
    </label>
  );
}

// ---------------------------------------------------------------- icons (24px line icons)
const ICONS: Record<string, ReactNode> = {
  jobs: <><rect x="3" y="7" width="18" height="13" rx="2.5" /><path d="M8.5 7V5.5A2.5 2.5 0 0 1 11 3h2a2.5 2.5 0 0 1 2.5 2.5V7M3 12.5h18" /></>,
  fetcher: <><circle cx="12" cy="12" r="2" /><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5" /></>,
  prompts: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />,
  accounts: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-4-6" /></>,
  stats: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  settings: <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1.5 14h5M9.5 8h5M17.5 16h5" />,
  logs: <path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />,
  auto: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  bell: <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0" />,
  spark: <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" />,
  refresh: <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12.2A2 2 0 0 0 8.5 21h7a2 2 0 0 0 2-1.8L18.5 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />,
  database: <><ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  send: <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />,
  inbox: <path d="M3 13h5l1.5 3h5L16 13h5M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z" />,
  translate: <path d="M4 5h9M8.5 3v2M11 5c-1 4-3.5 7-7 9M6.5 9c1.2 2 3 3.6 5 4.5M13 21l4-10 4 10M14.4 17.5h5.2" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2.5" />,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  shield: <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.4-7.5 9.5-4.3-1.1-7.5-4.9-7.5-9.5V6Z" />,
  bolt: <path d="M13 2 4.5 13.5H12L11 22l8.5-11.5H12Z" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
};

export function Icon({ name, className = "h-[18px] w-[18px]" }: { name: keyof typeof ICONS | string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true">{ICONS[name]}</svg>
  );
}

// ---------------------------------------------------------------- theme (auto / light / dark)
export type Theme = "auto" | "light" | "dark";

export function readTheme(): Theme {
  try {
    const t = localStorage.getItem("theme");
    return t === "light" || t === "dark" ? t : "auto";
  } catch { return "auto"; }
}

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "auto") delete root.dataset.theme; else root.dataset.theme = t;
  try { localStorage.setItem("theme", t); } catch { /* storage blocked */ }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const opts: { key: Theme; icon: string; label: string }[] = [
    { key: "auto", icon: "auto", label: "System" }, { key: "light", icon: "sun", label: "Light" }, { key: "dark", icon: "moon", label: "Dark" },
  ];
  return (
    <div className="relative grid grid-cols-3 rounded-lg border border-slate-200 bg-slate-100 p-0.5">
      <span className="absolute inset-y-0.5 left-0.5 w-[calc((100%-4px)/3)] rounded-md bg-surface shadow-[var(--shadow-card)] transition-transform duration-300 [transition-timing-function:var(--ease-spring)]"
        style={{ transform: `translateX(${opts.findIndex((o) => o.key === theme) * 100}%)` }} />
      {opts.map((o) => (
        <button key={o.key} title={o.label} onClick={() => { setTheme(o.key); applyTheme(o.key); }}
          className={`relative z-10 flex items-center justify-center rounded-md py-1 ${theme === o.key ? "text-slate-900" : "text-slate-400 hover:text-slate-600"}`}>
          <Icon name={o.icon} className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}

export function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function money(n: number | null | undefined, cur: "USD" | "BRL" | "MXN" = "USD"): string {
  const sym = { USD: "US$", BRL: "R$", MXN: "MX$" }[cur] ?? "US$";
  return n == null ? "—" : `${sym} ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}


// ---------------------------------------------------------------- client last seen (public last login)
function ageText(sec: number): string {
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  return `${Math.floor(sec / 86400)} d ago`;
}

/** Client's last login on Workana (public profile), ticking live. Not a true online state. */
export function LastSeen({ info, compact }: { info: Record<string, unknown>; compact?: boolean }) {
  const now = useNow(30000);
  const at = parseDate(typeof info.last_login === "string" ? info.last_login : null);
  const checked = parseDate(typeof info.presence_checked_at === "string" ? info.presence_checked_at : null);
  if (!at) {
    return compact ? <span className="text-[11px] text-slate-400" title={checked ? "no last-login on the client's profile" : "not checked yet"}>—</span> : null;
  }
  const sec = Math.max(0, (now - at.getTime()) / 1000);
  const tone = sec <= 900 ? { dot: "bg-emerald-500", txt: "text-emerald-700", live: true }
    : sec <= 7200 ? { dot: "bg-emerald-400", txt: "text-emerald-700", live: false }
      : sec <= 86400 ? { dot: "bg-amber-400", txt: "text-amber-700", live: false }
        : { dot: "bg-slate-300", txt: "text-slate-500", live: false };
  const tip = `Client's last login on Workana: ${at.toLocaleString()} (public profile${checked ? `, checked ${ageText((now - checked.getTime()) / 1000)}` : ""}). `
    + "Workana doesn't publish a live online status; a recent login means the client is probably around.";
  return (
    <span title={tip} className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium ${tone.txt}`}>
      <span className="relative flex h-2 w-2">
        {tone.live && <span className="ping-soft absolute h-full w-full rounded-full bg-emerald-400" />}
        <span className={`relative h-2 w-2 rounded-full ${tone.dot}`} />
      </span>
      {compact ? ageText(sec).replace(" ago", "") : `last login ${ageText(sec)}`}
    </span>
  );
}

// ---------------------------------------------------------------- client trust
export const TRUST_STYLE: Record<string, { pill: string; dot: string; name: string }> = {
  high: { pill: "bg-emerald-100 text-emerald-800", dot: "bg-emerald-500", name: "Very reliable" },
  good: { pill: "bg-emerald-50 text-emerald-700", dot: "bg-lime-500", name: "Reliable" },
  fair: { pill: "bg-amber-100 text-amber-800", dot: "bg-amber-400", name: "Pays sometimes" },
  new: { pill: "bg-sky-100 text-sky-800", dot: "bg-sky-400", name: "New client" },
  low: { pill: "bg-rose-100 text-rose-800", dot: "bg-rose-500", name: "Risky" },
  unknown: { pill: "bg-slate-100 text-slate-500", dot: "bg-slate-300", name: "No data" },
};

/** Colour-coded client trust (payment history). compact = dot + "paid x/y" for table rows. */
export function TrustBadge({ trust, compact }: { trust?: Trust; compact?: boolean }) {
  const t = trust ?? { tier: "unknown", score: 0, label: "no client data", reasons: [] };
  const st = TRUST_STYLE[t.tier] ?? TRUST_STYLE.unknown;
  const tip = `${st.name} — ${t.reasons.join(" · ")}`;
  const ratio = t.published ? `${t.paid ?? 0}/${t.published}` : "—";
  if (compact) {
    return (
      <span title={tip} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${st.pill}`}>
        <span className={`h-2 w-2 rounded-full ${st.dot}`} />{t.tier === "unknown" ? "?" : ratio}
      </span>
    );
  }
  return (
    <span title={tip} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${st.pill}`}>
      <span className={`h-2 w-2 rounded-full ${st.dot}`} />{st.name}{t.published ? ` · paid ${ratio}` : ""}
    </span>
  );
}

/** Promise-free confirm modal with a red action button. */
export function ConfirmDanger({ open, title, children, action, onConfirm, onClose, busy }: {
  open: boolean; title: string; children: ReactNode; action: string; onConfirm: () => void; onClose: () => void; busy?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} footer={<>
      <button className="btn-ghost" onClick={onClose}>Keep</button>
      <button className="btn-danger" disabled={busy} onClick={onConfirm}>{action}</button>
    </>}>{children}</Modal>
  );
}
