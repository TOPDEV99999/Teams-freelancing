import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ago, fmtTime, type Conversation, type ThreadView } from "../api";
import { Icon } from "../components";
import { useStore } from "../store";
import TranslatePanel from "../TranslatePanel";
import type { Provider } from "../translate";

const KIND_ICON: Record<string, string> = { message: "💬", notification: "🔔", test: "🧪" };
const convKey = (c: { account_id: string; slug: string }) => `${c.account_id}/${c.slug}`;

export default function InboxPage() {
  const { notices, accounts, counters, ext } = useStore();
  const [tab, setTab] = useState<"chats" | "notices">("chats");
  const [account, setAccount] = useState("");
  const accountList = Object.values(accounts).sort((a, b) => a.id.localeCompare(b.id));
  const unreadNotices = notices.filter((n) => !n.read).length;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [inboxMode, setInboxMode] = useState<"auto" | "manual" | "off">("auto");
  useEffect(() => { api.settings().then((r) => setInboxMode(r.values.inbox?.mode ?? "auto")).catch(() => undefined); }, []);

  return (
    <div className="flex h-full flex-col">
      {inboxMode !== "auto" && (
        <div className={`border-b px-4 py-2 text-sm ${inboxMode === "off" ? "border-slate-300 bg-slate-100 text-slate-700" : "border-indigo-200 bg-indigo-50 text-indigo-900"}`}>
          {inboxMode === "off"
            ? <>The Inbox is <b>off</b>: nothing is read and there are no message alerts. Turn it on in <a className="font-medium underline" href="#/settings">Settings → Inbox</a>.</>
            : <>Inbox mode: <b>only when you check</b>. New client messages still alert you; a conversation is read when you open it or click ↻ Refresh.
              (<a className="underline" href="#/settings">Settings → Inbox</a>)</>}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-surface p-3">
        <h1 className="mr-2 text-xl font-semibold">Inbox</h1>
        <div className="mr-4 flex rounded-lg border border-slate-200 p-0.5 text-sm">
          {([["chats", "Conversations"], ["notices", `Client messages${unreadNotices ? ` (${unreadNotices})` : ""}`]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`rounded-md px-3 py-1 ${tab === k ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{label}</button>
          ))}
        </div>
        <div><span className="label">Account</span>
          <select className="input" value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">all</option>
            {accountList.map((a) => <option key={a.id} value={a.id}>{a.display_name || a.id}</option>)}
          </select></div>
        <div className="ml-auto flex flex-wrap gap-2 text-xs">
          {accountList.map((a) => {
            const c = counters[a.id];
            const online = !!ext.workana[a.id]?.connected;
            return (
              <span key={a.id} className="flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-slate-600"
                title={!online ? "extension offline - start that browser profile" : c?.at ? `unread counters read from Workana ${ago(c.at)}` : "no Workana tab has reported yet"}>
                <span className={`h-2 w-2 rounded-full ${!online ? "bg-slate-300" : c ? "bg-emerald-500" : "bg-amber-400"}`} />
                <b className="text-slate-800">{a.display_name || a.id}</b>
                {!online ? "offline" : c ? <>💬 {c.messages ?? "?"} · 🔔 {c.notifications ?? "?"}</> : "waiting"}
              </span>
            );
          })}
        </div>
      </div>
      {tab === "chats"
        ? <Conversations account={account} openKey={openKey} setOpenKey={setOpenKey} />
        : <Notices account={account} onOpenChat={(acc, slug) => { setTab("chats"); setOpenKey(`${acc}/${slug}`); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- conversations (two-way)
function Conversations({ account, openKey, setOpenKey }: { account: string; openKey: string | null; setOpenKey: (k: string | null) => void }) {
  const { accounts, subscribe, toast, ext } = useStore();
  const [items, setItems] = useState<Conversation[]>([]);
  const [hidden, setHidden] = useState(0);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const name = (id: string) => accounts[id]?.display_name || id;

  const load = useCallback(() => {
    api.conversations().then((r) => { setItems(r.items); setHidden(r.hidden ?? 0); })
      .catch((e) => toast((e as Error).message)).finally(() => setLoading(false));
  }, [toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribe((type, data) => {
    if (type === "inbox_conversation") {
      if (!data?.has_client) return; // only projects where a client has written
      setItems((list) => {
        const rest = list.filter((c) => convKey(c) !== convKey(data));
        const old = list.find((c) => convKey(c) === convKey(data));
        return [{ ...old, ...data, last: data.last ?? old?.last ?? null }, ...rest]
          .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
      });
    }
    if (type === "reload" || type === "account_deleted") load();
  }), [subscribe, load]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((c) => (!account || c.account_id === account)
      && (!needle || `${c.name} ${c.title} ${c.snippet} ${c.last?.text ?? ""} ${c.slug}`.toLowerCase().includes(needle)));
  }, [items, account, q]);
  const open = items.find((c) => convKey(c) === openKey) ?? null;

  const checkAll = async () => {
    const online = Object.keys(ext.workana).filter((a) => ext.workana[a]?.connected && (!account || a === account));
    if (!online.length) return toast("No Workana extension is connected");
    await Promise.all(online.map((a) => api.inboxCheck(a).catch(() => undefined)));
    toast(`Reloading the Workana inbox in ${online.length} profile(s)…`, "ok");
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-80 shrink-0 flex-col border-r border-slate-200 bg-surface">
        <div className="flex gap-2 border-b border-slate-200 p-2">
          <input className="input flex-1" placeholder="Search name, project, text…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn-ghost px-2" title="Reload Workana's inbox list in every connected profile" onClick={checkAll}>↻</button>
        </div>
        <ul className="min-h-0 flex-1 divide-y divide-slate-100 overflow-auto">
          {!loading && list.length === 0 && (
            <li className="p-6 text-center text-sm text-slate-500">
              No client messages yet. Projects appear here as soon as a client writes to one of your accounts.
            </li>
          )}
          {list.map((c) => {
            const k = convKey(c);
            const last = c.last?.text || c.snippet;
            return (
              <li key={k}>
                <button onClick={() => setOpenKey(k)}
                  className={`block w-full px-3 py-2.5 text-left ${k === openKey ? "bg-indigo-50" : c.unread ? "bg-amber-50/60 hover:bg-amber-50" : "hover:bg-slate-50"}`}>
                  <div className="flex items-center gap-1.5 text-sm">
                    {c.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-indigo-500" />}
                    <b className="truncate">{c.name || c.title || c.slug}</b>
                    <span className="ml-auto shrink-0 text-[11px] text-slate-400">{ago(c.updated_at)}</span>
                  </div>
                  {c.name && c.title && <div className="truncate text-xs text-slate-500">{c.title}</div>}
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className="shrink-0 rounded bg-slate-100 px-1.5 text-[10px] text-slate-600">{name(c.account_id)}</span>
                    <span className={`truncate text-xs ${c.unread ? "font-medium text-slate-800" : "text-slate-500"}`}>
                      {c.last?.mine ? "You: " : ""}{last || (c.synced_at ? "—" : "not read yet")}
                    </span>
                    {c.last_error && <span title={c.last_error} className="shrink-0 text-rose-500">⚠</span>}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
        {hidden > 0 && (
          <div className="border-t border-slate-200 px-3 py-2 text-[11px] text-slate-400"
            title="Conversations where only your proposal is there so far. They are checked in the background and appear here when a client writes.">
            {hidden} conversation{hidden === 1 ? "" : "s"} without a client message hidden
          </div>
        )}
      </div>
      {open ? <ThreadPane key={openKey!} conv={open} /> : (
        <div className="flex flex-1 items-center justify-center p-10 text-center text-sm text-slate-500">
          <div>
            <div className="mb-2 text-3xl">💬</div>
            Pick a conversation. Messages are read in that account's own browser profile (a background tab opens and closes),
            and replies are typed and sent there too, just as you would on Workana.
          </div>
        </div>
      )}
    </div>
  );
}

function ThreadPane({ conv }: { conv: Conversation }) {
  const { accounts, subscribe, toast, ext, jobs } = useStore();
  const [view, setView] = useState<ThreadView | null>(null);
  const [busy, setBusy] = useState<"" | "read" | "send">("");
  const [text, setText] = useState("");
  const [translate, setTranslate] = useState(false);
  const [tr, setTr] = useState<{ provider: Provider; target: string }>({ provider: "auto", target: "en" });
  const bottom = useRef<HTMLDivElement>(null);
  const accName = accounts[conv.account_id]?.display_name || conv.account_id;
  const online = !!ext.workana[conv.account_id]?.connected;
  const draftKey = `inbox-draft:${convKey(conv)}`;

  const load = useCallback(() => {
    api.thread(conv.account_id, conv.slug).then(setView).catch(() => undefined);
  }, [conv.account_id, conv.slug]);
  const refresh = useCallback(async (quiet = false) => {
    setBusy("read");
    try {
      const r = await api.threadRefresh(conv.account_id, conv.slug);
      setView(r);
      if (!quiet && !r.recognised) toast("The page opened, but no messages were recognised yet - the page structure was saved so this can be tuned.");
    } catch (e) {
      if (!quiet) toast((e as Error).message);
    } finally { setBusy(""); }
  }, [conv.account_id, conv.slug, toast]);

  useEffect(() => {
    load();
    api.threadRead(conv.account_id, conv.slug).catch(() => undefined);
    try { setText(localStorage.getItem(draftKey) ?? ""); } catch { /* ignore */ }
    api.settings().then((r) => { if (r.values.translation) setTr(r.values.translation); }).catch(() => undefined);
    // Never read (or not for 10 minutes): read it now from Workana.
    const stale = !conv.synced_at || Date.now() - new Date(conv.synced_at).getTime() > 10 * 60 * 1000;
    if (stale && online) void refresh(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => subscribe((type, data) => {
    if (type === "inbox_thread" && data?.account_id === conv.account_id && data?.slug === conv.slug) load();
  }), [subscribe, conv.account_id, conv.slug, load]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [view?.messages.length]);
  useEffect(() => { try { text ? localStorage.setItem(draftKey, text) : localStorage.removeItem(draftKey); } catch { /* ignore */ } }, [text, draftKey]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy("send");
    try {
      const r = await api.threadSend(conv.account_id, conv.slug, t);
      setView(r);
      setText("");
      toast(r.verified ? `Reply sent as ${accName}` : `Reply sent as ${accName} (not verified on the page - check Workana)`, "ok");
    } catch (e) {
      toast(`Not sent: ${(e as Error).message}`);
    } finally { setBusy(""); }
  };

  const msgs = view?.messages ?? [];
  const c = view?.conversation ?? conv;
  const title = c.title || (c.job_id ? jobs[c.job_id]?.title : "") || c.slug;
  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-surface px-4 py-2.5">
          <div className="min-w-0">
            <div className="truncate font-semibold">{c.name || "Conversation"} <span className="font-normal text-slate-400">·</span> <span className="text-sm font-normal text-slate-600">{title}</span></div>
            <div className="text-xs text-slate-500">
              {accName}{c.synced_at ? ` · read from Workana ${ago(c.synced_at)}` : " · not read yet"}
              {c.job_id && <> · <a className="text-indigo-600 hover:underline" href={`#/jobs/${encodeURIComponent(c.job_id)}`}>job</a></>}
            </div>
          </div>
          <div className="ml-auto flex gap-2">
            <button className="btn-ghost" disabled={!!busy || !online} onClick={() => refresh()}
              title={online ? "Open this conversation in the account's browser (background tab) and read it" : "extension offline"}>
              {busy === "read" ? "Reading…" : "↻ Refresh"}
            </button>
            <button className="btn-ghost" disabled={!msgs.length} onClick={() => setTranslate((x) => !x)} title="Translate (for reading only)">文A</button>
            <a className="btn-ghost" href={c.url} target="_blank" rel="noopener">Workana ↗</a>
          </div>
        </div>
        {c.last_error && <div className="border-b border-rose-200 bg-rose-50 px-4 py-1.5 text-xs text-rose-800">Last attempt: {c.last_error}</div>}
        <div className="min-h-0 flex-1 space-y-2 overflow-auto bg-slate-50 px-4 py-3">
          {!msgs.length && (
            <div className="p-8 text-center text-sm text-slate-500">
              {busy === "read" ? `Opening the conversation in ${accName}'s browser…`
                : c.synced_at ? "No messages recognised on this conversation page yet."
                  : online ? "Not read yet - click Refresh." : `${accName}'s extension is offline - start that browser profile.`}
              {c.snippet && <p className="mt-3 rounded-lg bg-surface p-3 text-left text-slate-700">Last line in Workana's inbox: “{c.snippet}”</p>}
            </div>
          )}
          {msgs.map((m) => (
            <div key={m.id} className={`flex ${m.mine ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${m.mine ? "rounded-br-sm bg-indigo-600 text-white" : "rounded-bl-sm bg-surface text-slate-800"}`}>
                <div className={`mb-0.5 text-[11px] font-medium ${m.mine ? "text-white/85" : "text-slate-500"}`}>
                  {m.mine ? "You" : m.author || c.name || "Client"}{m.time ? ` · ${m.time}` : ""}
                </div>
                <div className="whitespace-pre-wrap break-words">{m.text}</div>
                {/^(?:🎤|🖼|🎬|💬 Message without text)/u.test(m.text) && (
                  <a href={c.url} target="_blank" rel="noopener"
                    className={`mt-1 inline-block text-xs font-medium underline ${m.mine ? "text-white" : "text-indigo-600"}`}>Open on Workana ↗</a>
                )}
              </div>
            </div>
          ))}
          <div ref={bottom} />
        </div>
        <div className="border-t border-slate-200 bg-surface p-3">
          <textarea className="input min-h-[80px] w-full resize-y" placeholder={`Reply as ${accName}…  (Ctrl+Enter to send)`}
            value={text} onChange={(e) => setText(e.target.value)} disabled={busy === "send"}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
            <span>{busy === "send" ? `Typing and sending in ${accName}'s browser… (a background tab opens and closes)`
              : online ? "Sent from that account's own browser profile, exactly as if you typed it on Workana." : "Extension offline - can't send now."}</span>
            <button className="btn-primary ml-auto" disabled={!text.trim() || !!busy || !online} onClick={send}>
              <Icon name="send" className="h-4 w-4" /> {busy === "send" ? "Sending…" : `Send as ${accName}`}
            </button>
          </div>
        </div>
      </div>
      {translate && msgs.length > 0 && (
        <TranslatePanel items={msgs.slice(-30).map((m) => ({ label: m.mine ? "You" : m.author || "Client", text: m.text }))}
          provider={tr.provider} defaultTarget={tr.target} onClose={() => setTranslate(false)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- notifications (the previous Inbox list)
function Notices({ account, onOpenChat }: { account: string; onOpenChat: (account: string, slug: string) => void }) {
  const { notices, setNotices, accounts, jobs, toast } = useStore();
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = (id: string | null) => (id ? accounts[id]?.display_name || id : "—");
  const list = useMemo(() => notices.filter((n) => (!account || n.account_id === account) && (!onlyUnread || !n.read)),
    [notices, account, onlyUnread]);
  const unread = notices.filter((n) => !n.read).length;

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok, "ok"); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const markRead = (ids: number[], read = true) => {
    setNotices((n) => n.map((x) => (ids.includes(x.id) ? { ...x, read } : x)));
    api.noticesRead({ ids, read }).catch((e) => toast((e as Error).message));
  };
  const slugOf = (url: string) => url.match(/workana\.com\/inbox\/([A-Za-z0-9_-]+)/)?.[1] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-surface px-3 py-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} /> unread only</label>
        <div className="ml-auto flex flex-wrap gap-2">
          <button className="btn-ghost" disabled={busy || !unread} onClick={() => run(async () => {
            setNotices((n) => n.map((x) => ({ ...x, read: true })));
            await api.noticesRead({ all: true });
          })}>Mark all read</button>
          <button className="btn-ghost" disabled={busy} title="Creates a fake message to check the toast, sound, desktop notification and Telegram forwarding"
            onClick={() => run(() => api.noticeTest(account || undefined), "Test notice sent")}>Send test notice</button>
          <button className="btn-ghost" disabled={busy || !notices.length}
            onClick={() => window.confirm("Delete all notices from this list?") && run(async () => {
              await api.noticesClear(false); setNotices(() => []);
            }, "Notifications cleared")}><Icon name="trash" className="h-4 w-4" /> Clear</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {list.length === 0 && (
          <div className="mx-auto max-w-lg p-10 text-center text-sm text-slate-500">
            <div className="mb-2 text-3xl">📭</div>
            No client messages yet. When a client writes to one of your accounts, the message appears here with a sound and a desktop
            notification. Only client messages are shown - not your own replies and not Workana's system notifications.
          </div>
        )}
        <ul className="divide-y divide-slate-100">
          {list.map((n) => {
            const slug = slugOf(n.url);
            return (
              <li key={n.id} className={`flex items-start gap-3 px-4 py-3 ${n.read ? "bg-surface" : "bg-indigo-50/60"}`}>
                <span className="mt-0.5 text-lg">{KIND_ICON[n.kind] ?? "•"}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    {!n.read && <span className="h-2 w-2 rounded-full bg-indigo-500" />}
                    <b className="truncate">{n.title}</b>
                    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{name(n.account_id)}</span>
                    <span className="text-xs text-slate-400" title={fmtTime(n.ts)}>{ago(n.ts)}</span>
                  </div>
                  {n.body && <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-700">{n.body}</p>}
                  <div className="mt-1.5 flex flex-wrap gap-3 text-xs">
                    {slug && n.account_id && n.kind === "message" && (
                      <button className="font-medium text-indigo-600 hover:underline" onClick={() => { markRead([n.id]); onOpenChat(n.account_id!, slug); }}>
                        Open conversation & reply
                      </button>
                    )}
                    {n.url && <a className="font-medium text-indigo-600 hover:underline" href={n.url} target="_blank" rel="noopener" onClick={() => markRead([n.id])}>Workana ↗</a>}
                    {n.job_id && (
                      <a className="font-medium text-indigo-600 hover:underline" href={`#/jobs/${encodeURIComponent(n.job_id)}`} onClick={() => markRead([n.id])}>
                        Job: {jobs[n.job_id]?.title ?? n.job_id}
                      </a>
                    )}
                    <button className="text-slate-500 hover:text-slate-800" onClick={() => markRead([n.id], !n.read)}>{n.read ? "Mark unread" : "Mark read"}</button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
