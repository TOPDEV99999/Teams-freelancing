/**
 * One Workana conversation page (/inbox/<project-slug>): read the messages and send a reply.
 *
 * Runs inside the account's own browser profile, exactly like a person reading and typing. The selectors in
 * THREAD (config.ts) are tried first; when they find nothing, generic heuristics are used (the message list is
 * the block with the most similar children; the reply box is the biggest text box on the page).
 */
import { setNativeValue, sleep, usable } from "../../ext-common/dom";
import { THREAD } from "./config";
import { all, inOverlay, onPage, pick, textBoxes } from "./page";

export interface ThreadMessage { author: string; mine: boolean; text: string; time: string }
export interface Thread { slug: string; title: string; name: string; messages: ThreadMessage[]; can_reply: boolean; method: string }

const TIME_RE = /^(?:\d{1,2}[:h]\d{2}(?:\s?[ap]\.?m\.?)?|ayer|hoy|ontem|hoje|yesterday|today|hace .+|há .+|\d+\s?(?:min|h|d|s)\b.*|\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?(?:,? \d{1,2}:\d{2})?|\d{1,2} (?:de )?[a-zç]{3,10}\.?(?: (?:de )?\d{4})?(?:,? \d{1,2}:\d{2})?)$/i;
const MINE_RE = /\b(?:own|mine|self|me|sent|outgoing|outbound|right|is-?author|from-?me|my-?message)\b/i;
const THEIRS_RE = /\b(?:their|other|received|incoming|inbound|left|from-?them|client)\b/i;

const norm = (t: string) => t.normalize("NFKC").replace(/\s+/g, " ").trim();

function parts(box: Element): { el: HTMLElement; text: string }[] {
  const out: { el: HTMLElement; text: string }[] = [];
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (!p || /^(SCRIPT|STYLE|NOSCRIPT|BUTTON)$/.test(p.tagName)) continue;
    const t = norm(n.textContent ?? "");
    if (t) out.push({ el: p, text: t });
  }
  return out;
}

/** The reply box of the conversation (null when the conversation is closed / read-only). */
export function findComposer(): HTMLElement | null {
  const configured = pick<HTMLElement>(THREAD.composer);
  if (configured) return configured;
  return textBoxes()[0] ?? null;
}

/** Same kind of row: tag + main (first) class. "message message-own" and "message" are both messages. */
function sig(el: Element): string {
  const main = (el.getAttribute("class") ?? "").trim().split(/\s+/).filter((c) => c && !/^(?:ng-|is-|active|ui-|js-)/.test(c))[0] ?? "";
  return `${el.tagName}.${main}`;
}

/** The element whose children are the messages. */
function findList(composer: HTMLElement | null): { list: HTMLElement; items: HTMLElement[]; method: string } | null {
  const configured = all<HTMLElement>(THREAD.message).filter((e) => !inOverlay(e));
  if (configured.length) return { list: configured[0].parentElement ?? document.body, items: configured, method: "selectors" };

  let best: { list: HTMLElement; items: HTMLElement[]; score: number } | null = null;
  const scope = document.querySelector("main") ?? document.body;
  scope.querySelectorAll<HTMLElement>("div, ul, ol, section").forEach((el) => {
    if (el.children.length < 2 || inOverlay(el) || !onPage(el)) return;
    if (composer && el.contains(composer)) return;
    // Workana's conversation list (left column) and header menus are never the messages.
    if (el.closest(THREAD.roster) || el.querySelector(THREAD.roster) || el.closest("nav, header")) return;
    // The conversation list (links to other conversations) is not the message list.
    if (el.querySelectorAll('a[href*="/inbox/"]').length >= Math.max(3, el.children.length / 2)) return;
    const groups = new Map<string, HTMLElement[]>();
    for (const c of Array.from(el.children) as HTMLElement[]) {
      if (!onPage(c)) continue;
      const t = norm(c.innerText || "");
      if (!t) continue;
      const k = sig(c);
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    for (const items of groups.values()) {
      if (items.length < 2) continue;
      const text = items.reduce((n, c) => n + Math.min(600, (c.innerText || "").length), 0);
      const hint = /messag|mensaj|mensag|chat|bubble|comment|conversation|thread/i.test(`${el.className} ${items[0].className}`) ? 2 : 1;
      // Messages sit above the reply box.
      const near = composer && el.getBoundingClientRect().top < composer.getBoundingClientRect().top ? 1.3 : 1;
      const score = items.length * Math.log(10 + text) * hint * near;
      if (!best || score > best.score) best = { list: el, items, score };
    }
  });
  return best ? { list: (best as any).list, items: (best as any).items, method: "heuristic" } : null;
}

function isMine(item: HTMLElement, list: HTMLElement): boolean {
  const cls = [item, ...Array.from(item.querySelectorAll("*")).slice(0, 6)].map((e) => e.getAttribute("class") ?? "").join(" ");
  if (MINE_RE.test(cls) && !THEIRS_RE.test(cls)) return true;
  if (THEIRS_RE.test(cls) && !MINE_RE.test(cls)) return false;
  // Right-aligned bubble = mine (chat convention).
  const bubble = (Array.from(item.querySelectorAll<HTMLElement>("*")).find((e) => {
    try { const bg = getComputedStyle(e).backgroundColor; return bg && !/rgba?\(0, 0, 0, 0\)|transparent/.test(bg) && (e.innerText || "").trim().length > 0; } catch { return false; }
  }) ?? item).getBoundingClientRect();
  const box = list.getBoundingClientRect();
  return bubble.left - box.left > (box.right - bubble.right) + 24;
}

function readItem(item: HTMLElement, list: HTMLElement): ThreadMessage | null {
  const ps = parts(item);
  if (!ps.length) return null;
  const pickText = (sels: readonly string[]) => {
    for (const s of usable(sels)) { try { const e = item.querySelector<HTMLElement>(s); if (e?.innerText?.trim()) return norm(e.innerText); } catch { /* ignore */ } }
    return "";
  };
  let author = pickText(THREAD.author);
  let time = pickText(THREAD.time);
  let text = pickText(THREAD.text);
  if (!time) time = ps.find((p) => TIME_RE.test(p.text))?.text ?? "";
  if (!author) {
    const a = ps.find((p) => /name|author|user|sender/i.test(p.el.className) && p.text.length <= 60);
    author = a?.text ?? "";
  }
  if (!text) {
    text = ps.filter((p) => p.text !== author && p.text !== time && !TIME_RE.test(p.text)).map((p) => p.text).join("\n");
  }
  text = text.trim();
  if (!text) return null;
  return { author: author.slice(0, 120), mine: isMine(item, list), text: text.slice(0, 8000), time: time.slice(0, 60) };
}

/** Workana's own markup (verified with page captures, Nov 2026). */
function readWorkana(): { messages: ThreadMessage[]; name: string } | null {
  const items = Array.from(document.querySelectorAll<HTMLElement>(THREAD.message[0]));
  if (!items.length) return null;
  const name = norm(pick<HTMLElement>(THREAD.clientName)?.innerText ?? document.querySelector(THREAD.clientName[0])?.textContent ?? "");
  const messages: ThreadMessage[] = [];
  for (const li of items) {
    const mine = li.classList.contains("self");
    const content = Array.from(li.querySelectorAll<HTMLElement>("article p.content, article .content"))
      .map((p) => (p.innerText || p.textContent || "").trim()).filter(Boolean).join("\n");
    const files = Array.from(li.querySelectorAll<HTMLAnchorElement>("a[href*='attachment'], a[href*='/download'], a[download]"))
      .map((a) => norm(a.textContent ?? "")).filter(Boolean);
    let text = content;
    if (li.classList.contains("bid-proposal")) {
      const amount = norm(li.querySelector(".bid-proposal-header .monetary-amount")?.textContent ?? "");
      const cur = norm(li.querySelector(".bid-proposal-header span")?.textContent ?? "USD");
      text = `📝 Proposal${amount ? ` · ${cur} ${amount}` : ""}\n${content}`.trim();
    }
    if (files.length) text = `${text}${text ? "\n" : ""}📎 ${files.join(", ")}`;
    if (!text) continue;
    const t = li.querySelector("time");
    const time = norm(t?.getAttribute("title") || t?.textContent || "");
    messages.push({ author: mine ? "" : name, mine, text: text.slice(0, 8000), time: time.slice(0, 60) });
  }
  return { messages, name };
}

export function readThread(slug: string): Thread {
  const title = norm((pick<HTMLElement>(THREAD.title)?.innerText) ?? document.querySelector(THREAD.title[0])?.textContent ?? "").slice(0, 200);
  const wk = readWorkana();
  if (wk) {
    return { slug, title, name: wk.name, messages: wk.messages.slice(-200), can_reply: !!findComposer(), method: "workana" };
  }
  const composer = findComposer();
  const found = findList(composer);
  const messages: ThreadMessage[] = [];
  if (found) {
    for (const it of found.items) {
      const m = readItem(it, found.list);
      if (m) messages.push(m);
    }
  }
  const theirs = messages.find((m) => !m.mine && m.author)?.author ?? "";
  return { slug, title, name: theirs, messages: messages.slice(-200), can_reply: !!composer, method: found?.method ?? "none" };
}

function findSendButton(composer: HTMLElement): HTMLElement | null {
  const form = composer.closest("form");
  const configured = pick<HTMLElement>(THREAD.sendButton, form ?? document);
  if (configured) return configured;
  if (form) {
    const b = Array.from(form.querySelectorAll<HTMLElement>('button[type="submit"], input[type="submit"]')).find((e) => onPage(e));
    if (b) return b;
  }
  const WORD = /enviar|send|responder|reply|submit|paper-?plane|plane|arrow/i;
  for (let box: HTMLElement | null = composer.parentElement, i = 0; box && i < 6; box = box.parentElement, i++) {
    const btns = Array.from(box.querySelectorAll<HTMLElement>("button, [role='button'], input[type='submit'], a.btn"))
      .filter((b) => onPage(b) && !b.hasAttribute("disabled"));
    const named = btns.find((b) => WORD.test(`${b.innerText} ${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""} ${b.className} ${b.querySelector("i,svg,span")?.getAttribute("class") ?? ""}`));
    if (named) return named;
    if (btns.length === 1) return btns[0];
  }
  return null;
}

function setText(el: HTMLElement, text: string) {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    setNativeValue(el, text);
    el.focus();
    return;
  }
  el.focus();
  document.execCommand("selectAll", false);
  document.execCommand("insertText", false, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const valueOf = (el: HTMLElement) => (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.innerText);

/** Type the reply and click send; verified when the box empties and the text shows up in the conversation. */
export async function sendReply(text: string): Promise<{ ok: boolean; error?: string; verified?: boolean }> {
  const composer = findComposer();
  if (!composer) return { ok: false, error: "no reply box on this conversation (closed, or Workana changed the page)" };
  composer.scrollIntoView({ block: "center" });
  await sleep(400 + Math.random() * 600);
  setText(composer, text);
  await sleep(500 + Math.random() * 700);
  if (norm(valueOf(composer)).length < Math.min(10, norm(text).length)) return { ok: false, error: "the text did not stick in the reply box" };
  const btn = findSendButton(composer);
  if (!btn) return { ok: false, error: "send button not found next to the reply box" };
  btn.click();
  const probe = norm(text).slice(0, 60);
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    await sleep(700);
    const cleared = norm(valueOf(composer)).length === 0 || !document.contains(composer);
    const shown = norm(document.body.innerText).includes(probe);
    if (cleared && shown) return { ok: true, verified: true };
  }
  const cleared = norm(valueOf(composer)).length === 0;
  return cleared ? { ok: true, verified: false } : { ok: false, error: "clicked send, but the message did not leave the reply box" };
}
