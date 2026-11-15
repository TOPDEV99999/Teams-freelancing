/**
 * Workana message / notification watcher (runs inside every www.workana.com tab of this profile).
 *
 * It only READS what Workana already shows you:
 *   - the unread counters in the top bar (and the "(3) Workana" tab title),
 *   - on the inbox page (/inbox), the conversation list: who wrote, the last line, unread or not.
 * The background script forwards changes to the hub (dashboard Inbox page, alerts, Telegram).
 *
 * ⚠️ Workana's exact markup was not available while writing this: the selectors in WATCH (config.ts) are
 * tried first, then generic heuristics (links to /inbox/<project>, numeric badges next to the bell /
 * envelope icons). Use the popup's "Check now" to see what was detected.
 */
import { WATCH } from "./config";

export interface Counters { messages: number | null; notifications: number | null; title: number | null }
export interface Conversation { slug: string; url: string; name: string; snippet: string; unread: boolean; title?: string }
export interface BellItem { key: string; title: string; body: string }

const BADGE_RE = /^\s*(\d{1,3})\+?\s*$/;
const ownText = (el: Element) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();

function visible(el: Element): boolean {
  const r = (el as HTMLElement).getBoundingClientRect?.();
  if (!r) return true;
  const st = getComputedStyle(el as HTMLElement);
  return st.display !== "none" && st.visibility !== "hidden" && (r.width > 0 || r.height > 0 || !document.body?.getBoundingClientRect().width);
}

function tryAll(doc: ParentNode, sels: readonly string[]): Element[] {
  const out: Element[] = [];
  for (const sel of sels) {
    if (!sel || sel.toUpperCase().startsWith("TODO")) continue;
    try { out.push(...Array.from(doc.querySelectorAll(sel))); } catch { /* invalid selector */ }
  }
  return out;
}

/** Number shown in a badge inside (or right next to) `el`; 0 when the icon is there without a badge. */
function badgeIn(el: Element): number {
  const cands = [el, ...Array.from(el.querySelectorAll("*"))];
  for (const c of cands) {
    const t = ownText(c) || (c.children.length === 0 ? (c.textContent ?? "") : "");
    const m = t.match(BADGE_RE);
    if (m && visible(c)) return Number(m[1]);
  }
  const sib = el.nextElementSibling;
  if (sib && BADGE_RE.test(sib.textContent ?? "") && visible(sib)) return Number((sib.textContent ?? "").match(BADGE_RE)![1]);
  return 0;
}

function counterFor(doc: Document, configured: readonly string[], hints: RegExp): number | null {
  const direct = tryAll(doc, configured);
  if (direct.length) return Math.max(...direct.map(badgeIn));
  // Heuristic: elements in the top bar whose link / class / label mentions the hint.
  const bar = tryAll(doc, WATCH.topBar);
  const scope: ParentNode[] = bar.length ? bar : [doc];
  let best: number | null = null;
  for (const root of scope) {
    root.querySelectorAll("a, button, li, span, div, i").forEach((el) => {
      const sig = `${el.getAttribute("href") ?? ""} ${el.getAttribute("class") ?? ""} ${el.id} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""} ${el.getAttribute("data-original-title") ?? ""}`;
      if (!hints.test(sig)) return;
      const n = badgeIn(el);
      best = best === null ? n : Math.max(best, n);
    });
  }
  return best;
}

/** Workana's header icons: class "no-messages" = nothing unread; otherwise a number (or at least 1). */
function iconCount(doc: Document, sel: string): number | null {
  const el = doc.querySelector(sel);
  if (!el) return null;
  if (el.classList.contains("no-messages")) return 0;
  const box = el.closest("a") ?? el;
  const n = badgeIn(box) || Number(el.getAttribute("data-count") ?? box.getAttribute("data-count") ?? 0);
  return n > 0 ? n : 1;
}

export function readCounters(doc: Document = document): Counters {
  const t = doc.title.match(/^\s*\((\d+)\)/);
  return {
    messages: iconCount(doc, WATCH.messagesBadge[0]) ?? counterFor(doc, WATCH.messagesBadge, /inbox|messag|mensag|mensaj|chat/i),
    notifications: iconCount(doc, WATCH.notificationsBadge[0]) ?? counterFor(doc, WATCH.notificationsBadge, /notif|bell|campan|sino/i),
    title: t ? Number(t[1]) : null,
  };
}

const UNREAD_RE = /\b(?:unread|not-?read|is-new|new|highlight(?:ed)?|unseen)\b/i;

/**
 * Conversations from the header's messages dropdown (present on every page): /messages/index/<project>/<you>.
 * Returns them with your own profile slug (the second part), which builds the conversation address.
 */
export function readThreadList(doc: Document = document): { items: Conversation[]; own: string | null } {
  const items: Conversation[] = [];
  const owners = new Map<string, number>();
  doc.querySelectorAll<HTMLAnchorElement>(WATCH.threadLinks).forEach((a) => {
    const m = (a.getAttribute("href") ?? "").match(/\/messages\/index\/([A-Za-z0-9_\-]+)(?:\/([A-Za-z0-9_\-]+))?/);
    if (!m || items.some((x) => x.slug === m[1])) return;
    if (m[2]) owners.set(m[2], (owners.get(m[2]) ?? 0) + 1);
    const li = a.closest("li") ?? a;
    const parts = textParts(a).filter((x) => !TIME_RE.test(x) && !BADGE_RE.test(x));
    const titleEl = a.querySelector(".notification-title");
    const title = (titleEl?.textContent ?? parts[0] ?? "").replace(/\s+/g, " ").trim();
    const rest = parts.filter((x) => x !== title && !title.startsWith(x));
    const img = a.querySelector<HTMLImageElement>("img[title], img[alt]");
    const name = (img?.getAttribute("title") || img?.getAttribute("alt") || "").trim();
    const unread = UNREAD_RE.test(`${li.getAttribute("class") ?? ""} ${a.getAttribute("class") ?? ""}`)
      || !!li.querySelector('[class*="unread"], [class*="badge"], [class*="new-message"]');
    items.push({ slug: m[1], url: `https://www.workana.com/messages/index/${m[1]}${m[2] ? `/${m[2]}` : ""}`,
      name: name.slice(0, 120), title: title.slice(0, 200), snippet: rest.join(" ").slice(0, 400), unread });
  });
  const own = [...owners.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  return { items, own };
}

/** Items of the header's bell dropdown, e.g. "Tu propuesta no fue aceptada" + "En <project title>". */
export function readBell(doc: Document = document): BellItem[] {
  const out: BellItem[] = [];
  doc.querySelectorAll<HTMLElement>(WATCH.bellItems).forEach((li) => {
    const parts = textParts(li).filter((x) => !BADGE_RE.test(x));
    const titleEl = li.querySelector(".notification-title");
    const title = ((titleEl?.firstChild?.textContent ?? "").trim() || parts[0] || "").replace(/\s+/g, " ").trim();
    if (!title) return;
    const body = parts.filter((x) => x !== title && !TIME_RE.test(x)).join(" ").replace(/\s+/g, " ").trim();
    // Relative times ("Hace 2 días") change every day, so the key leaves them out.
    out.push({ key: `bell:${title}|${body}`.slice(0, 280), title: title.slice(0, 200), body: body.slice(0, 600) });
  });
  return out;
}

const TIME_RE = /^(?:\d{1,2}[:h]\d{2}(?:\s?[ap]\.?m\.?)?|ayer|hoy|ontem|hoje|yesterday|today|hace .+|há .+|\d+\s?(?:min|h|d|s)\b.*|\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?)$/i;

/** Visible text pieces of a row, in order (each text node separately: name, project, last line, time…). */
function textParts(box: Element): string[] {
  const out: string[] = [];
  const walker = box.ownerDocument.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(parent.tagName)) continue;
    const t = (n.textContent ?? "").replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  }
  return out;
}

/** Conversations listed on the inbox page (one per project). */
export function readConversations(doc: Document = document): Conversation[] {
  const items = new Map<string, Conversation>();
  let anchors = tryAll(doc, WATCH.conversationLink) as HTMLAnchorElement[];
  if (!anchors.length) anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href*="/inbox/"]'));
  for (const a of anchors) {
    const m = (a.getAttribute("href") ?? "").match(/\/inbox\/([A-Za-z0-9_\-]+)/);
    if (!m || items.has(m[1])) continue;
    const itemSel = WATCH.conversationItem.filter((x) => !x.toUpperCase().startsWith("TODO")).join(",") || "li";
    let box: Element = a;
    try { box = a.closest(itemSel) ?? a; } catch { /* invalid selector */ }
    const text = textParts(box);
    const lines = text.filter((x) => !TIME_RE.test(x) && !BADGE_RE.test(x));
    const name = lines[0] ?? m[1];
    const snippet = lines.slice(1).sort((x, y) => y.length - x.length)[0] ?? "";
    const sig = `${box.getAttribute("class") ?? ""} ${a.getAttribute("class") ?? ""}`;
    const unread = /\b(?:unread|not-?read|is-new|new-message|has-new|highlight(?:ed)?)\b/i.test(sig)
      || !!box.querySelector('[class*="unread"], [class*="badge"], [class*="new-message"], [class*="dot"]')
      || text.some((x) => BADGE_RE.test(x) && Number(x.trim().replace("+", "")) > 0)
      || (() => { try { return Number(getComputedStyle(box.querySelector("strong, b, h3, h4, span") ?? box).fontWeight) >= 650; } catch { return false; } })();
    items.set(m[1], { slug: m[1], url: `https://www.workana.com/inbox/${m[1]}`, name: name.slice(0, 120), snippet: snippet.slice(0, 400), unread });
  }
  return [...items.values()];
}

export const isInboxPage = (loc: Location = location) => /^\/inbox\/?$/.test(loc.pathname);
