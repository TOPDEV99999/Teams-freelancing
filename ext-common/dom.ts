/** DOM helpers shared by content scripts. Selector lists: first match wins; entries starting with "TODO" are skipped. */

export type SelectorList = readonly string[];

export function usable(list: SelectorList): string[] {
  return list.filter((s) => s && !s.trim().toUpperCase().startsWith("TODO"));
}

export function q<T extends Element = HTMLElement>(list: SelectorList, root: ParentNode = document): T | null {
  for (const sel of usable(list)) {
    try {
      const el = root.querySelector<T>(sel as string);
      if (el) return el;
    } catch { /* invalid selector — ignore */ }
  }
  return null;
}

export function qAll<T extends Element = HTMLElement>(list: SelectorList, root: ParentNode = document): T[] {
  for (const sel of usable(list)) {
    try {
      const els = Array.from(root.querySelectorAll<T>(sel as string));
      if (els.length) return els;
    } catch { /* ignore */ }
  }
  return [];
}

export function isVisible(el: Element | null): boolean {
  if (!el) return false;
  const r = (el as HTMLElement).getBoundingClientRect();
  const st = getComputedStyle(el as HTMLElement);
  return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const rand = (min: number, max: number) => Math.round(min + Math.random() * (max - min));

export async function waitFor<T extends Element = HTMLElement>(list: SelectorList, timeoutMs: number, visible = true): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const el = q<T>(list);
    if (el && (!visible || isVisible(el))) return el;
    await sleep(250);
  }
  return null;
}

export function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/** Text of the elements matched by `list` (or "" if none). */
export function textOf(list: SelectorList): string {
  return qAll(list).map((e) => (e as HTMLElement).innerText || e.textContent || "").join("\n");
}

/** Set a value on an input/textarea/select the way frameworks (React/Vue/jQuery) notice. */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  el.focus();
  el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
  if (el instanceof HTMLSelectElement) {
    const opts = Array.from(el.options);
    const exact = opts.find((o) => o.value === value || o.text.trim() === value);
    const num = Number(value);
    const nearest = !exact && !Number.isNaN(num)
      ? opts.filter((o) => !Number.isNaN(parseFloat(o.value)))
          .sort((a, b) => Math.abs(parseFloat(a.value) - num) - Math.abs(parseFloat(b.value) - num))[0]
      : undefined;
    el.value = (exact ?? nearest ?? opts[0])?.value ?? value;
  } else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter ? setter.call(el, value) : (el.value = value);
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "End" }));
  el.blur();
  el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
}
