/**
 * Runs on chatgpt.com. Inserts the prompt, sends it, waits until the reply is complete,
 * returns the reply text. Detects (and reports, never bypasses) login / limit / verification issues.
 */
import { isVisible, matchesAny, q, sleep, textOf, waitFor } from "../../ext-common/dom";
import { SELECTORS, TEXT_PATTERNS, TIMINGS } from "./config";

type Result = { ok: true; text: string } | { ok: false; error: string };
let running = false;
let cancelled = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === "ping") {
    sendResponse({ ok: true });
    return;
  }
  if (msg?.kind === "cancel") {
    // Dashboard "Stop": abort waiting and press ChatGPT's own Stop button.
    cancelled = true;
    allMatching(SELECTORS.stopButton)[0]?.click();
    sendResponse({ ok: true });
    return;
  }
  if (msg?.kind === "conversation") {
    sendResponse(currentConversation());
    return;
  }
  if (msg?.kind === "delete_conversations") {
    deleteConversations((msg.ids ?? []) as string[])
      .then(sendResponse)
      .catch((e) => sendResponse({ deleted: [], failed: [], error: String(e?.message ?? e) }));
    return true;
  }
  if (msg?.kind === "generate") {
    if (running) {
      sendResponse({ ok: false, error: "busy" });
      return;
    }
    running = true;
    cancelled = false;
    generate(String(msg.prompt))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: `content error: ${e?.message ?? e}` }))
      .finally(() => { running = false; });
    return true; // async response
  }
});

function detectProblem(): string | null {
  if (q(SELECTORS.captcha)) return "captcha: ChatGPT is showing a verification challenge — solve it manually";
  const notices = textOf(SELECTORS.notices);
  if (notices) {
    if (matchesAny(notices, TEXT_PATTERNS.unusual)) return "captcha: ChatGPT reports unusual activity — check the tab";
    if (matchesAny(notices, TEXT_PATTERNS.rateLimit)) return `rate_limited: ${notices.trim().slice(0, 200)}`;
    if (matchesAny(notices, TEXT_PATTERNS.sessionExpired)) return "not_logged_in: session expired — log in again";
  }
  const login = q(SELECTORS.loginButton);
  if (login && isVisible(login)) return "not_logged_in: log in to chatgpt.com in this Chrome profile";
  return null;
}

const norm = (t: string) => t.replace(/\s+/g, " ").trim();

/** Document roots to search: the page, every shadow root (open or closed) and same-origin iframes. */
function allRoots(): (Document | ShadowRoot)[] {
  const roots: (Document | ShadowRoot)[] = [];
  const visit = (root: Document | ShadowRoot, depth: number) => {
    roots.push(root);
    if (depth > 6) return;
    root.querySelectorAll("*").forEach((el) => {
      let sr: ShadowRoot | null = null;
      try { sr = chrome.dom?.openOrClosedShadowRoot(el as HTMLElement) ?? (el as HTMLElement).shadowRoot; } catch { sr = (el as HTMLElement).shadowRoot; }
      if (sr) visit(sr, depth + 1);
      if (el instanceof HTMLIFrameElement) {
        try { if (el.contentDocument) visit(el.contentDocument, depth + 1); } catch { /* cross-origin */ }
      }
    });
  };
  visit(document, 0);
  return roots;
}

/** Elements matching ANY of the selectors, in every root, in document order. */
function allMatching(list: readonly string[], roots = allRoots()): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const root of roots) {
    const found = new Set<HTMLElement>();
    for (const sel of list) {
      try { root.querySelectorAll<HTMLElement>(sel).forEach((e) => found.add(e)); } catch { /* invalid selector */ }
    }
    out.push(...[...found].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)));
  }
  return out;
}

const generatingNow = () => allMatching(SELECTORS.stopButton).length > 0;

const elText = (e: HTMLElement) => (e.innerText || e.textContent || "").trim();

/** Full visible text of every root (the conversation may live in a shadow root / iframe). */
function deepText(roots = allRoots()): string {
  return roots.map((r) => (r instanceof Document ? r.body?.innerText ?? "" : (r.host as HTMLElement)?.innerText || r.textContent || "")).join("\n");
}

/** Last balanced {...} block in `text` that has "price" + "days" and isn't the placeholder from {json_format}. */
function lastJsonBlock(text: string): string {
  let found = "";
  for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        const block = text.slice(i, j + 1);
        if (/"price"\s*:/.test(block) && /"days"\s*:/.test(block) && !block.includes('"..."')) found = block;
        break;
      }
    }
  }
  return found;
}

/** Text of the newest assistant reply: assistant selectors, then the last non-prompt turn, then the last JSON on the page. */
function lastReplyText(promptHead: string): string {
  const roots = allRoots();
  const msgs = allMatching(SELECTORS.assistantMessage, roots);
  if (msgs.length) return elText(msgs[msgs.length - 1]);
  const turns = allMatching(SELECTORS.turnFallback, roots).filter((e) => !norm(elText(e)).includes(promptHead));
  if (turns.length) return elText(turns[turns.length - 1]);
  return lastJsonBlock(deepText(roots));
}

/** The reply holds a complete JSON object with price + days (what the hub parses). */
function looksComplete(text: string): boolean {
  return /"price"\s*:/.test(text) && /"days"\s*:/.test(text) && /\}\s*(```)?\s*$/.test(text);
}

function diagnostics(promptHead = ""): string {
  const roots = allRoots();
  const counts = [...SELECTORS.assistantMessage, ...SELECTORS.turnFallback, ...SELECTORS.stopButton]
    .map((sel) => `${sel}=${allMatching([sel], roots).length}`);
  const text = deepText(roots);
  const iframes = document.querySelectorAll("iframe").length;
  return `[page ${location.pathname}; roots=${roots.length} iframes=${iframes} text=${text.length} ` +
    `promptVisible=${promptHead ? norm(text).includes(promptHead.slice(0, 40)) : "?"} json=${lastJsonBlock(text).length}; ${counts.join(", ")}]`;
}

async function insertPrompt(el: HTMLElement, text: string): Promise<boolean> {
  el.focus();
  if (el instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value.length > 0;
  }
  // contenteditable (ProseMirror): clear, then paste — ProseMirror handles paste events natively.
  document.execCommand("selectAll", false);
  document.execCommand("delete", false);
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  await sleep(300);
  const got = () => (el.innerText || "").replace(/\s+/g, " ").trim().length;
  const want = text.replace(/\s+/g, " ").trim().length;
  if (got() >= want * 0.9) return true;

  // Fallback 1: execCommand insertText
  document.execCommand("selectAll", false);
  document.execCommand("insertText", false, text);
  await sleep(300);
  if (got() >= want * 0.9) return true;

  // Fallback 2: write paragraphs directly and notify the editor
  el.innerHTML = "";
  for (const line of text.split("\n")) {
    const p = document.createElement("p");
    p.textContent = line;
    if (!line) p.appendChild(document.createElement("br"));
    el.appendChild(p);
  }
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  await sleep(300);
  return got() >= want * 0.9;
}

async function generate(prompt: string): Promise<Result> {
  const pre = detectProblem();
  if (pre) return { ok: false, error: pre };

  const composer = await waitFor<HTMLElement>(SELECTORS.composer, TIMINGS.composerWaitMs);
  if (!composer) return { ok: false, error: detectProblem() ?? "composer_not_found: update SELECTORS.composer in config.ts" };

  const promptHead = norm(prompt).slice(0, 80);
  const baseline = lastReplyText(promptHead);
  if (!(await insertPrompt(composer, prompt))) return { ok: false, error: "could not insert the prompt into the composer" };

  // Click send (wait for it to become enabled)
  let sendBtn: HTMLButtonElement | null = null;
  const sendDeadline = Date.now() + 8000;
  while (Date.now() < sendDeadline) {
    sendBtn = q<HTMLButtonElement>(SELECTORS.sendButton);
    if (sendBtn && !sendBtn.disabled && isVisible(sendBtn)) break;
    await sleep(200);
  }
  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
  }

  // Wait for the reply to start
  const startDeadline = Date.now() + TIMINGS.startWaitMs;
  while (Date.now() < startDeadline) {
    if (cancelled) return { ok: false, error: "cancelled from the dashboard" };
    const p = detectProblem();
    if (p) return { ok: false, error: p };
    const cur = lastReplyText(promptHead);
    if ((cur && cur !== baseline) || generatingNow()) break;
    await sleep(500);
  }
  const started = lastReplyText(promptHead);
  if ((!started || started === baseline) && !generatingNow()) {
    return { ok: false, error: detectProblem() ?? `no_response: ChatGPT did not start replying ${diagnostics(promptHead)}` };
  }

  // Wait for completion: stop button gone AND text stable for completionStableMs
  const end = Date.now() + TIMINGS.maxWaitMs;
  let last = "";
  let stableSince = Date.now();
  while (Date.now() < end) {
    await sleep(500);
    if (cancelled) return { ok: false, error: "cancelled from the dashboard" };
    const p = detectProblem();
    if (p) return { ok: false, error: p };
    const cur = lastReplyText(promptHead);
    const text = cur !== baseline ? cur : "";
    if (text !== last) {
      last = text;
      stableSince = Date.now();
    }
    const generating = generatingNow();
    const stable = Date.now() - stableSince;
    if (last && ((!generating && stable >= TIMINGS.completionStableMs) || (looksComplete(last) && stable >= TIMINGS.completionStableMs) ||
      (stable >= TIMINGS.stuckStableMs && /\}\s*(```)?\s*$/.test(last)))) {
      return { ok: true, text: last };
    }
  }
  return last ? { ok: true, text: last } : { ok: false, error: `timeout waiting for ChatGPT reply ${diagnostics(promptHead)}` };
}

// ---------------------------------------------------------------- ChatGPT history (delete the assistant's chats)

/** The open conversation: /c/<id> (normal chat) or a temporary chat (never saved to history). */
function currentConversation(): { id: string | null; temporary: boolean } {
  const m = location.pathname.match(/\/c\/([0-9a-f-]{20,})/i);
  const temporary = /[?&]temporary-chat=true/.test(location.search);
  return { id: m ? m[1] : null, temporary };
}

async function accessToken(): Promise<string> {
  const r = await fetch("/api/auth/session", { credentials: "include" });
  if (!r.ok) throw new Error(`session HTTP ${r.status}`);
  const j = await r.json();
  if (!j?.accessToken) throw new Error("not logged in to ChatGPT");
  return j.accessToken as string;
}

/** Same request ChatGPT's own "Delete chat" menu makes (hides the conversation from your history). */
async function deleteConversations(ids: string[]): Promise<{ deleted: string[]; failed: { id: string; error: string }[] }> {
  const deleted: string[] = [];
  const failed: { id: string; error: string }[] = [];
  if (!ids.length) return { deleted, failed };
  const token = await accessToken();
  for (const id of ids) {
    try {
      const r = await fetch(`/backend-api/conversation/${encodeURIComponent(id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ is_visible: false }),
      });
      if (r.ok || r.status === 404) deleted.push(id); // 404 = already gone
      else failed.push({ id, error: `HTTP ${r.status}` });
    } catch (e) {
      failed.push({ id, error: String((e as Error).message ?? e) });
    }
    await sleep(400 + Math.random() * 400);
  }
  return { deleted, failed };
}
