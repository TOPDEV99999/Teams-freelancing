/**
 * Page helpers that are robust against Workana's pop-ups.
 *
 * When an account has unread messages, Workana slides a chat preview up from the bottom of every page.
 * That preview has its own text box and links, which earlier versions mistook for the proposal form or
 * the bid button ("amount field not found" / "bid button not found"). Everything here skips elements
 * that live inside such floating overlays.
 */
import { isVisible, usable, type SelectorList } from "../../ext-common/dom";

/** Inside a fixed/sticky layer that does not cover the middle of the screen (chat preview, top bar, toasts…)? */
export function inOverlay(el: Element): boolean {
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  for (let e: Element | null = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    let pos = "";
    try { pos = getComputedStyle(e).position; } catch { /* detached */ }
    if (pos === "fixed" || pos === "sticky") {
      const r = e.getBoundingClientRect();
      // A centred modal (e.g. a proposal form opened in a dialog) covers the centre: that one is allowed.
      const coversCentre = r.left <= cx && r.right >= cx && r.top <= cy && r.bottom >= cy;
      if (!coversCentre) return true;
    }
  }
  return false;
}

/** Usable on the page: visible and not part of a floating overlay. */
export const onPage = (el: Element | null): el is HTMLElement => !!el && isVisible(el) && !inOverlay(el);

/** Every element matched by any selector of the list (in list order, de-duplicated). */
export function all<T extends Element = HTMLElement>(list: SelectorList, root: ParentNode = document): T[] {
  const out: T[] = [];
  const seen = new Set<Element>();
  for (const sel of usable(list)) {
    try {
      root.querySelectorAll<T>(sel).forEach((e) => { if (!seen.has(e)) { seen.add(e); out.push(e); } });
    } catch { /* invalid selector */ }
  }
  return out;
}

/** First element of the list that is really on the page (visible, not in an overlay). */
export function pick<T extends HTMLElement = HTMLElement>(list: SelectorList, root: ParentNode = document,
  ok: (el: T) => boolean = () => true): T | null {
  return (all<T>(list, root).find((e) => onPage(e) && ok(e)) as T | undefined) ?? null;
}

/** Visible text boxes on the page (textarea or contenteditable), biggest first. */
export function textBoxes(root: ParentNode = document): HTMLElement[] {
  const els = Array.from(root.querySelectorAll<HTMLElement>('textarea, [contenteditable="true"], [contenteditable=""]'))
    .filter((e) => onPage(e) && !(e as HTMLTextAreaElement).disabled && !(e as HTMLTextAreaElement).readOnly);
  const area = (e: HTMLElement) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
  return els.sort((a, b) => area(b) - area(a));
}

// ---------------------------------------------------------------- page-structure capture
/**
 * A compact outline of the page structure (tags, ids, classes, link targets, form fields) so the selectors
 * can be tuned to Workana's real markup. Long texts are replaced by their length; nothing is sent anywhere
 * except to YOUR local hub (saved in data/snapshots/).
 */
export function outline(root: Element = document.body, maxNodes = 2500): string {
  const lines: string[] = [];
  let count = 0;
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|SVG|PATH|META|LINK|IFRAME|TEMPLATE)$/;
  const walk = (el: Element, depth: number) => {
    if (count >= maxNodes || depth > 30 || SKIP.test(el.tagName)) return;
    const he = el as HTMLElement;
    let vis = true;
    try { vis = isVisible(el); } catch { /* ignore */ }
    if (!vis && el.children.length === 0) return;
    count++;
    const cls = (el.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 6).join(".");
    let line = `${"  ".repeat(Math.min(depth, 20))}${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""}`;
    const attrs: string[] = [];
    for (const a of ["href", "name", "type", "role", "aria-label", "placeholder", "title", "data-qa", "data-testid", "contenteditable"]) {
      const v = el.getAttribute(a);
      if (v) attrs.push(`${a}=${a === "href" ? v.replace(/\?.*$/, "") : v.slice(0, 40)}`);
    }
    if (attrs.length) line += ` [${attrs.join(" ")}]`;
    let pos = "";
    try { pos = getComputedStyle(el).position; } catch { /* ignore */ }
    if (pos === "fixed" || pos === "sticky") line += ` {${pos}${inOverlay(el) ? " overlay" : ""}}`;
    if (!vis) line += " {hidden}";
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
    if (own) {
      const shortOk = own.length <= 30 && /^(BUTTON|A|LABEL|H[1-6]|OPTION|TH|LEGEND|SPAN|STRONG|B|SMALL|TIME)$/.test(el.tagName);
      line += shortOk ? ` "${own}"` : ` (text ${own.length})`;
    }
    if (he.tagName === "TEXTAREA" || he.tagName === "INPUT") line += " <field>";
    lines.push(line);
    for (const c of Array.from(el.children)) walk(c, depth + 1);
  };
  walk(root, 0);
  if (count >= maxNodes) lines.push(`… cut at ${maxNodes} elements`);
  return lines.join("\n");
}

export function pageKind(loc: Location = location): string {
  const p = loc.pathname;
  if (/^\/inbox\/?$/.test(p)) return "inbox";
  if (/^\/inbox\/./.test(p)) return "thread";
  if (/\/bid\//.test(p)) return "bidform";
  if (/^\/job\//.test(p)) return "job";
  return "other";
}
