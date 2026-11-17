import { useEffect, useState } from "react";
import { api, type AutoSend, type SettingsResponse, type SettingsValues } from "../api";
import { Icon, Switch, TRUST_STYLE } from "../components";
import { useStore } from "../store";
import { LANGUAGES } from "../translate";

export default function SettingsPage() {
  const { toast, accounts } = useStore();
  const [meta, setMeta] = useState<SettingsResponse | null>(null);
  const [v, setV] = useState<SettingsValues | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    api.settings().then((r) => { setMeta(r); setV(r.values); }).catch((e) => toast((e as Error).message));
  }, [toast]);

  if (!v || !meta) return <div className="p-6 text-slate-400">Loading…</div>;
  const set = <K extends keyof SettingsValues>(k: K, val: SettingsValues[K]) => { setV({ ...v, [k]: val }); setDirty(true); };

  const save = async () => {
    // Only this page's keys, so it never overwrites edits made on the Prompts / Fetcher pages.
    const { generation_provider, assign_threshold, jitter_min_seconds, jitter_max_seconds, quiet_hours,
      generation_pause_min_seconds, generation_pause_max_seconds, auto_send, translation, notifications, presence, currency_rates, inbox } = v;
    try {
      const r = await api.saveSettings({ generation_provider, assign_threshold, jitter_min_seconds, jitter_max_seconds, quiet_hours,
        generation_pause_min_seconds, generation_pause_max_seconds, auto_send, translation, notifications, presence, currency_rates, inbox });
      setV(r.values); setDirty(false); toast("Settings saved", "ok");
    }
    catch (e) { toast((e as Error).message); }
  };

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-4xl space-y-4 pb-16">
        <div className="flex items-center gap-2">
          <h1 className="mr-auto text-xl font-semibold">Settings</h1>
          <button className="btn-primary" disabled={!dirty} onClick={save}>Save settings</button>
        </div>

        <p className="text-sm text-slate-500">
          Prompts and proposal styles are on the <a className="text-indigo-600 hover:underline" href="#/prompts">Prompts</a> page;
          job filters, check interval and Telegram on the <a className="text-indigo-600 hover:underline" href="#/fetcher">Fetcher</a> page.
        </p>

        <div className="card grid grid-cols-1 gap-4 p-4 md:grid-cols-3">
          <div><span className="label">Generation provider</span>
            <select className="input" value={v.generation_provider} onChange={(e) => set("generation_provider", e.target.value as SettingsValues["generation_provider"])}>
              <option value="chatgpt_web">ChatGPT web (extension)</option>
              <option value="openai_api">OpenAI API</option>
            </select>
            {v.generation_provider === "openai_api" && !meta.env.openai_configured &&
              <p className="mt-1 text-xs text-rose-600">OPENAI_API_KEY is not set in .env</p>}</div>
          <div><span className="label">Auto-assign threshold (score)</span>
            <input className="input" type="number" step="0.5" value={v.assign_threshold} onChange={(e) => set("assign_threshold", Number(e.target.value))} /></div>
          <div><span className="label">Global jitter min (s)</span>
            <input className="input" type="number" min={0} value={v.jitter_min_seconds} onChange={(e) => set("jitter_min_seconds", Number(e.target.value))} /></div>
          <div><span className="label">Global jitter max (s)</span>
            <input className="input" type="number" min={0} value={v.jitter_max_seconds} onChange={(e) => set("jitter_max_seconds", Number(e.target.value))} /></div>
          <div><span className="label">ChatGPT pause min (s)</span>
            <input className="input" type="number" min={0} value={v.generation_pause_min_seconds}
              onChange={(e) => set("generation_pause_min_seconds", Number(e.target.value))} /></div>
          <div><span className="label">ChatGPT pause max (s)</span>
            <input className="input" type="number" min={0} value={v.generation_pause_max_seconds}
              onChange={(e) => set("generation_pause_max_seconds", Number(e.target.value))} /></div>
          <div><span className="label">Job fetcher</span>
            <p className="pt-1.5 text-sm"><code>{meta.env.fetcher}</code> <span className="text-xs text-slate-500">(FETCHER in .env)</span></p></div>
          <div><span className="label">Quiet hours (no sending)</span>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={v.quiet_hours.enabled} onChange={(e) => set("quiet_hours", { ...v.quiet_hours, enabled: e.target.checked })} /> enabled
            </label></div>
          <div><span className="label">From</span>
            <input className="input" type="time" value={v.quiet_hours.start} onChange={(e) => set("quiet_hours", { ...v.quiet_hours, start: e.target.value })} /></div>
          <div><span className="label">To</span>
            <input className="input" type="time" value={v.quiet_hours.end} onChange={(e) => set("quiet_hours", { ...v.quiet_hours, end: e.target.value })} /></div>
        </div>
        <p className="text-xs text-slate-500">
          Timeouts (from .env): generation {meta.env.generation_timeout_seconds}s · submission {meta.env.submit_timeout_seconds}s.
        </p>

        <AutomationCard a={v.auto_send} accounts={Object.values(accounts).map((x) => ({ id: x.id, name: x.display_name || x.id }))}
          onChange={(a) => set("auto_send", a)} />

        <div className="card space-y-3 p-4">
          <div className="flex items-center gap-2"><Icon name="inbox" className="h-5 w-5 text-indigo-600" /><h2 className="font-semibold">Inbox</h2></div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {([
              ["auto", "Automatic", "Workana is checked every few minutes and conversations where a client wrote are read in the background (a tab opens and closes)."],
              ["manual", "Only when I check", "Nothing is opened by itself. A conversation is read when you open it or click ↻. New client messages still alert you in real time (from Workana's conversation list), and the project appears in the Inbox."],
              ["off", "Off", "No inbox tab, nothing is read, no message alerts. The Workana extensions only send proposals."],
            ] as const).map(([key, label, help]) => (
              <label key={key} className={`cursor-pointer rounded-lg border p-3 text-sm ${v.inbox?.mode === key ? "border-indigo-500 bg-indigo-50" : "border-slate-200"}`}>
                <input type="radio" name="inbox-mode" className="mr-2" checked={v.inbox?.mode === key}
                  onChange={() => set("inbox", { ...(v.inbox ?? { interval_minutes: 3 }), mode: key })} />
                <b>{label}</b>
                <p className="mt-1 text-xs text-slate-500">{help}</p>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-56"><span className="label">Check interval (minutes)</span>
              <input className="input" type="number" min={1} max={60} disabled={v.inbox?.mode === "off"} value={v.inbox?.interval_minutes ?? 3}
                onChange={(e) => set("inbox", { ...(v.inbox ?? { mode: "auto" }), interval_minutes: Number(e.target.value) })} /></div>
            <p className="pb-2 text-xs text-slate-500">How often the Workana inbox tab refreshes (new-message alerts) and, in Automatic mode,
              how often one conversation per account is read. Longer = fewer requests to Workana.</p>
          </div>
        </div>

        <div className="card space-y-3 p-4">
          <div className="flex items-center gap-2"><span className="text-lg">💱</span><h2 className="font-semibold">Currencies</h2></div>
          <p className="text-sm text-slate-500">
            Each account bids in its own currency (Accounts page → <b>Bid currency on Workana</b>). Prices are always decided in US dollars —
            ChatGPT's suggestion, the client's budget, the auto-send price rule and its minimum/maximum — and only the amount typed into Workana's
            form is converted with these rates.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40"><span className="label">R$ per 1 US$</span>
              <input className="input" type="number" step="0.01" min={0.01} value={v.currency_rates?.BRL ?? 5.4}
                onChange={(e) => set("currency_rates", { ...v.currency_rates, BRL: Number(e.target.value), source: "manual" })} /></div>
            <div className="w-40"><span className="label">MX$ per 1 US$</span>
              <input className="input" type="number" step="0.01" min={0.01} value={v.currency_rates?.MXN ?? 18.5}
                onChange={(e) => set("currency_rates", { ...v.currency_rates, MXN: Number(e.target.value), source: "manual" })} /></div>
            <button className="btn-ghost" onClick={async () => {
              try { const r = await api.refreshRates(); setV({ ...v, currency_rates: r.currency_rates }); toast("Today's rates loaded and saved", "ok"); }
              catch (e) { toast((e as Error).message); }
            }}>Get today's rates</button>
            <span className="pb-2 text-xs text-slate-400">
              {v.currency_rates?.updated_at ? `updated ${v.currency_rates.updated_at} (${v.currency_rates.source})` : v.currency_rates?.source === "manual" ? "entered manually" : "default rates - check them"}
            </span>
          </div>
        </div>

        <div className="card space-y-3 p-4">
          <div className="flex items-center gap-2"><Icon name="translate" className="h-5 w-5 text-indigo-600" /><h2 className="font-semibold">Translation (view only)</h2></div>
          <p className="text-sm text-slate-500">The <b>Translate</b> buttons on a job open a sidebar with the job and proposals in your language. Nothing sent to Workana is translated.</p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div><span className="label">Your language</span>
              <select className="input" value={v.translation.target} onChange={(e) => set("translation", { ...v.translation, target: e.target.value })}>
                {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
              </select></div>
            <div><span className="label">Translator</span>
              <select className="input" value={v.translation.provider} onChange={(e) => set("translation", { ...v.translation, provider: e.target.value as SettingsValues["translation"]["provider"] })}>
                <option value="auto">Auto — Chrome on-device first, Google as fallback</option>
                <option value="browser">Chrome on-device only (private, Chrome 138+)</option>
                <option value="google">Google Translate (online)</option>
              </select></div>
          </div>
        </div>

        <div className="card space-y-3 p-4">
          <div className="flex items-center gap-2"><Icon name="accounts" className="h-5 w-5 text-indigo-600" /><h2 className="font-semibold">Client last seen</h2></div>
          <p className="text-sm text-slate-500">
            Shows when each client last logged in to Workana (from the client&apos;s <b>public</b> profile — read by this app without any
            login, never through your accounts&apos; browsers). Workana doesn&apos;t publish a live online/offline status; a login a few minutes
            ago means the client is probably around. Requests are spaced 8–15 s apart and stop for 30 minutes if Workana pushes back.
          </p>
          <Switch checked={v.presence.enabled} onChange={(x) => set("presence", { ...v.presence, enabled: x })}
            label={<span className="text-sm">Enabled</span>} />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div><span className="label">Refresh each client every (minutes)</span>
              <input className="input" type="number" min={5} max={240} value={v.presence.interval_minutes}
                onChange={(e) => set("presence", { ...v.presence, interval_minutes: Number(e.target.value) })} /></div>
            <div><span className="label">Only jobs fetched in the last (hours)</span>
              <input className="input" type="number" min={1} max={168} value={v.presence.max_age_hours}
                onChange={(e) => set("presence", { ...v.presence, max_age_hours: Number(e.target.value) })} /></div>
          </div>
          <p className="text-xs text-slate-500">Only open jobs (new / drafted / error) are refreshed; a job you open is refreshed first.</p>
        </div>

        <div className="card space-y-3 p-4">
          <div className="flex items-center gap-2"><Icon name="inbox" className="h-5 w-5 text-indigo-600" /><h2 className="font-semibold">Workana messages &amp; notifications</h2></div>
          <Switch checked={v.notifications.telegram} onChange={(x) => set("notifications", { ...v.notifications, telegram: x })}
            label={<span className="text-sm">Also forward them to Telegram (uses the bot set up on the Fetcher page)</span>} />
          <Switch checked={v.notifications.auto_outcome} onChange={(x) => set("notifications", { ...v.notifications, auto_outcome: x })}
            label={<span className="text-sm">When a client writes on a job you bid on, mark that bid as <b>replied</b> (Stats)</span>} />
          <p className="text-xs text-slate-500">Sound and desktop pop-ups: switch “Notify Workana messages” in the sidebar. Test it on the Inbox page.</p>
        </div>
      </div>
    </div>
  );
}


function AutomationCard({ a, accounts, onChange }: { a: AutoSend; accounts: { id: string; name: string }[]; onChange: (a: AutoSend) => void }) {
  const set = <K extends keyof AutoSend>(k: K, val: AutoSend[K]) => onChange({ ...a, [k]: val });
  return (
    <div className="card space-y-4 p-4">
      <div className="flex items-center gap-2"><Icon name="bolt" className="h-5 w-5 text-indigo-600" /><h2 className="font-semibold">Automatic sending</h2></div>
      <p className="text-sm text-slate-500">
        Rules for proposals queued by <b>Auto-send</b> (a job&apos;s switch, the bulk bar, or the auto-pilot below). Daily limits, delays, jitter and quiet hours still apply.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div><span className="label">Review window (seconds)</span>
          <input className="input" type="number" min={0} max={3600} value={a.review_seconds} onChange={(e) => set("review_seconds", Number(e.target.value))} />
          <p className="mt-1 text-xs text-slate-500">Time to read or cancel an auto-queued proposal before it goes out. 0 = no wait.</p></div>
        <div><span className="label">Which proposal</span>
          <select className="input" value={a.style_mode} onChange={(e) => set("style_mode", e.target.value as AutoSend["style_mode"])}>
            <option value="fixed">The job&apos;s chosen style (or the first)</option>
            <option value="rotate">Rotate styles per account</option>
            <option value="random">Random style</option>
          </select></div>
        <div><span className="label">Price</span>
          <select className="input" value={a.price_mode} onChange={(e) => set("price_mode", e.target.value as AutoSend["price_mode"])}>
            <option value="suggested">ChatGPT&apos;s suggested price</option>
            <option value="budget_min">Client budget — minimum</option>
            <option value="budget_mid">Client budget — middle</option>
            <option value="budget_max_pct">% of the client&apos;s maximum budget</option>
          </select>
          {a.price_mode === "budget_max_pct" && (
            <div className="mt-1 flex items-center gap-2 text-xs"><input className="input !w-20 !py-1" type="number" min={10} max={100}
              value={a.price_pct} onChange={(e) => set("price_pct", Number(e.target.value))} /> % of the maximum</div>
          )}</div>
        <div><span className="label">Never below (USD, 0 = off)</span>
          <input className="input" type="number" min={0} value={a.min_price} onChange={(e) => set("min_price", Number(e.target.value))} /></div>
        <div><span className="label">Skip if above (USD, 0 = off)</span>
          <input className="input" type="number" min={0} value={a.max_price} onChange={(e) => set("max_price", Number(e.target.value))} /></div>
        <div><span className="label">Max auto-sends per day (all accounts, 0 = off)</span>
          <input className="input" type="number" min={0} value={a.daily_cap} onChange={(e) => set("daily_cap", Number(e.target.value))} /></div>
        <div><span className="label">Minimum client trust</span>
          <select className="input" value={a.min_trust} onChange={(e) => set("min_trust", e.target.value as AutoSend["min_trust"])}>
            <option value="any">Any client</option>
            <option value="new">New clients and better (skip risky)</option>
            <option value="fair">{TRUST_STYLE.fair.name} and better</option>
            <option value="good">{TRUST_STYLE.good.name} and better</option>
            <option value="high">{TRUST_STYLE.high.name} only</option>
          </select></div>
        <div><span className="label">Skip if more bids than (0 = off)</span>
          <input className="input" type="number" min={0} value={a.max_bids} onChange={(e) => set("max_bids", Number(e.target.value))} /></div>
      </div>
      <div className="space-y-2 rounded-lg border border-slate-200 p-3">
        <Switch checked={a.autopilot} onChange={(x) => set("autopilot", x)}
          label={<span className="text-sm"><b>Auto-pilot</b> — new jobs that match an account (keywords) are generated and auto-sent without a click</span>} />
        {a.autopilot && (
          <div className="flex flex-wrap items-center gap-1.5 pl-11 text-xs">
            <span className="text-slate-500">Accounts:</span>
            {accounts.map((x) => {
              const on = a.autopilot_accounts.includes(x.id);
              return (
                <button key={x.id} onClick={() => set("autopilot_accounts", on ? a.autopilot_accounts.filter((y) => y !== x.id) : [...a.autopilot_accounts, x.id])}
                  className={`rounded-full border px-2.5 py-1 font-medium ${on ? "border-indigo-500 bg-indigo-500 text-white" : "border-slate-200 text-slate-600"}`}>{x.name}</button>
              );
            })}
            <span className="text-slate-500">{a.autopilot_accounts.length ? "" : "(none picked = every matching account)"}</span>
          </div>
        )}
        <p className="pl-11 text-xs text-slate-500">Uses the rules above (trust, bids, price, review window). The Cancel button at the top stops everything at any time.</p>
      </div>
    </div>
  );
}
