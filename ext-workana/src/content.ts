/**
 * Runs on every www.workana.com page. Does nothing unless the background says this tab belongs
 * to the current submission task. Never interacts with captchas or verification checks.
 */
import { isVisible, matchesAny, q, rand, setNativeValue, sleep, textOf, usable } from "../../ext-common/dom";
import { getLocal } from "../../ext-common/hubClient";
import { SELECTORS, TEXT, TIMINGS, URLS } from "./config";
import type { ErrorCode, Stage, Task } from "./types";
import { isInboxPage, readBell, readConversations, readCounters, readThreadList } from "./watch";
import { THREAD, WATCH } from "./config";
import { onPage, outline, pageKind, pick, textBoxes } from "./page";
import { bidFormUrl, errorPageTitle, findBidButton, findForm, noConnects } from "./bid";
import { readThread, sendReply } from "./inbox";

const bodyText = () => document.body?.innerText ?? "";

function send(msg: Record<string, unknown>) {
  return chrome.runtime.sendMessage(msg).catch(() => undefined);
}

let finished = false;
async function fail(task: Task, error: ErrorCode, detail?: string) {
  if (finished) return;
  finished = true;
  banner(`❌ ${error}${detail ? ` — ${detail}` : ""}`, "#be123c");
  if (error === "form_not_found") snapshot(`bid-failure: ${detail ?? ""}`);
  await send({ kind: "result", submission_id: task.submission_id, status: "failed", error, detail });
}
async function succeed(task: Task, how: string) {
  if (finished) return;
  finished = true;
  banner("✅ Proposal sent and verified", "#047857");
  await send({ kind: "result", submission_id: task.submission_id, status: "sent", detail: how });
}
// Cancelled from the dashboard: stop everything on this page (nothing is clicked or submitted after this).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.kind === "cancelled") {
    finished = true;
    banner(`submission #${msg.submission_id} cancelled from the dashboard — nothing more will be done on this page`, "#475569");
  }
});
const stage = (task: Task, s: Stage) => send({ kind: "stage", submission_id: task.submission_id, stage: s });
const progress = (task: Task, text: string) => send({ kind: "progress", submission_id: task.submission_id, text });

function banner(text: string, color = "#4338ca") {
  let el = document.getElementById("wa-assistant-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "wa-assistant-banner";
    Object.assign(el.style, {
      position: "fixed", top: "0", left: "0", right: "0", zIndex: "2147483647", padding: "10px 16px",
      font: "600 14px system-ui, sans-serif", color: "#fff", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,.25)",
    });
    document.documentElement.appendChild(el);
  }
  el.style.background = color;
  el.textContent = `Workana Assistant: ${text}`;
}

// ---------------------------------------------------------------- checks
function captchaPresent(): boolean {
  return !!q(SELECTORS.captcha) || matchesAny(bodyText(), TEXT.captcha);
}

function isLoggedIn(): boolean | null {
  if (q(SELECTORS.loggedIn)) return true;
  const login = q(SELECTORS.loginLink);
  if (login && isVisible(login)) return false;
  return null; // unknown — selectors not configured
}

async function wrongAccount(): Promise<string | null> {
  const { expectedName } = await getLocal("expectedName");
  if (!expectedName) return null;
  // First match in the top bar only — never the client's name card on the job page.
  const el = usable(SELECTORS.accountName)
    .flatMap((sel) => { try { return Array.from(document.querySelectorAll<HTMLElement>(sel)); } catch { return []; } })
    .find((e) => isVisible(e) && !SELECTORS.accountNameExclude.some((x) => e.closest(x)));
  if (!el) return null; // can't check — name not found in the top bar
  const shown = (el.innerText || el.textContent || "").trim();
  return shown.toLowerCase().includes(String(expectedName).toLowerCase()) ? null : shown || "(empty)";
}

function successVisible(): boolean {
  const el = q(SELECTORS.success);
  if (el && isVisible(el)) return true;
  return matchesAny(bodyText(), TEXT.success);
}

// ---------------------------------------------------------------- main
async function main() {
  const res = await send({ kind: "hello", page: pageKind() });
  if (res?.inboxJob) return runInboxJob(res.inboxJob);
  if (res?.snapshot) setTimeout(() => snapshot("first visit of this page type"), 6000);
  const task: Task | null = res?.task ?? null;
  if (!task) return;

  banner(`working on submission #${task.submission_id} (${task.mode})…`);
  await sleep(rand(800, 1600));

  if (captchaPresent()) return fail(task, "captcha", "verification challenge on page — solve it manually, then resume the account");
  const logged = isLoggedIn();
  if (logged === false) return fail(task, "not_logged_in", "log in to Workana in this Chrome profile");
  const wrong = await wrongAccount();
  if (wrong) return fail(task, "wrong_account", `logged in as "${wrong}"`);
  if (logged === null) void progress(task, "warning: could not confirm login (configure SELECTORS.loggedIn)");

  // After a submit (human or auto) the page may have navigated: verify.
  if (task.stage === "filled" || task.stage === "submitted") {
    return verifyAfterSubmit(task);
  }

  if (matchesAny(bodyText(), TEXT.noCredits)) return fail(task, "no_credits", "out of bids/connects");

  // Already on a page with the form (direct bid URL, or after clicking the bid button)?
  const onBidUrl = URLS.bidForm.some((r) => r.test(location.href));
  const formNow = findForm() ?? (onBidUrl ? await waitForBidForm() : null);
  if (formNow) return fillForm(task);
  const denied = errorPageTitle();
  if (onBidUrl && task.stage === "opening") {
    // Opened the proposal form directly, but no form here ("Access Denied" = usually no Connects left):
    // the job page tells why (closed? already bid? plan wall?).
    if (matchesAny(bodyText(), TEXT.alreadyBid)) return fail(task, "already_bid");
    await stage(task, "job_page");
    await progress(task, "no form on the direct proposal page - trying through the job page");
    location.assign(task.url);
    return;
  }

  if (onBidUrl && denied) {
    return fail(task, "form_not_found", `Workana answered "${denied}" on the proposal form - this account may not be allowed to bid on this project`);
  }

  // Job page checks
  if (noConnects(task)) {
    return fail(task, "no_credits", "no Connects left - Workana shows 'Improve your plan' instead of the proposal form");
  }
  if (matchesAny(bodyText(), TEXT.alreadyBid)) return fail(task, "already_bid");
  if (matchesAny(bodyText(), TEXT.jobClosed)) return fail(task, "job_closed");
  const statusEl = q<HTMLElement>(SELECTORS.jobStatus);
  if (statusEl && !statusEl.classList.contains("open")) {
    return fail(task, "job_closed", `job status: ${statusEl.innerText.trim() || statusEl.className}`);
  }

  if (task.stage === "clicked_bid") {
    // We clicked before and landed somewhere without a form: give the page a moment (slow load / pop-ups).
    const late = await waitForForm(10000);
    if (late) return fillForm(task);
    return fail(task, "form_not_found", `no proposal form found at ${location.pathname}`);
  }

  // The page (and Workana's chat preview) may still be rendering: look for the button for a few seconds.
  let btn = findBidButton(task);
  for (let i = 0; !btn && i < 16; i++) { await sleep(500); btn = findBidButton(task); }
  if (!btn) {
    const href = bidFormUrl(task);
    if (href) {
      await stage(task, "clicked_bid");
      await progress(task, "bid button hidden behind a pop-up - opening the proposal form directly");
      location.assign(href);
      return;
    }
    return fail(task, "form_not_found", "bid button not found on the job page");
  }
  await stage(task, "clicked_bid");
  await progress(task, "opening proposal form");
  btn.scrollIntoView({ block: "center" });
  await sleep(rand(500, 1200));
  btn.click();

  // The form may open inline (modal) instead of navigating.
  const inline = await waitForForm(8000);
  if (inline) return fillForm({ ...task, stage: "clicked_bid" });
  // otherwise the page navigates and main() runs again on the new page
}

/** On /messages/bid/<slug>: wait for the form; if it hides behind the "Realizar propuesta" tab, click that tab once. */
async function waitForBidForm(timeout = TIMINGS.formWaitMs) {
  const end = Date.now() + timeout;
  let clickedTab = false;
  const start = Date.now();
  while (Date.now() < end) {
    const f = findForm();
    if (f) return f;
    if (captchaPresent()) return null;
    if (!clickedTab && Date.now() - start > 3000) {
      clickedTab = true;
      const tab = Array.from(document.querySelectorAll<HTMLElement>("button, [role='tab'], li, a, span, div"))
        .find((e) => onPage(e) && e.children.length <= 2 && matchesAny((e.innerText || "").trim(), TEXT.bidButton)
          && !(e instanceof HTMLAnchorElement && e.getAttribute("href") && !/^#|^javascript:/i.test(e.getAttribute("href")!)));
      tab?.click();
    }
    await sleep(300);
  }
  return null;
}

async function waitForForm(timeout = TIMINGS.formWaitMs) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const f = findForm();
    if (f) return f;
    if (captchaPresent()) return null;
    await sleep(300);
  }
  return null;
}

async function fillForm(task: Task) {
  await stage(task, "form");
  await progress(task, "filling proposal form");
  if (captchaPresent()) return fail(task, "captcha", "verification challenge on the form");
  if (matchesAny(bodyText(), TEXT.noCredits)) return fail(task, "no_credits", "out of bids/connects");

  let parts = findForm();
  for (let i = 0; (!parts || !parts.amount) && i < 20; i++) { await sleep(250); parts = findForm() ?? parts; }
  const textEl = parts?.text ?? null;
  const scope = parts?.scope ?? document.body;
  const amountEl = parts?.amount ?? pick<HTMLInputElement>(SELECTORS.amountField, scope) ?? pick<HTMLInputElement>(SELECTORS.amountField);
  const daysEl = pick<HTMLInputElement>(SELECTORS.daysField, scope) ?? pick<HTMLInputElement>(SELECTORS.daysField);
  if (!textEl) return fail(task, "form_not_found", "proposal textarea not found");
  if (!amountEl) return fail(task, "form_not_found", "amount field not found next to the proposal text");

  textEl.scrollIntoView({ block: "center" });
  await sleep(rand(...TIMINGS.fieldDelay));
  setNativeValue(textEl, task.text);
  await sleep(rand(...TIMINGS.fieldDelay));
  setNativeValue(amountEl, String(task.price));
  if (daysEl) {
    await sleep(rand(...TIMINGS.fieldDelay));
    setNativeValue(daysEl, String(task.days));
  } else {
    void progress(task, "warning: delivery-time field not found (SELECTORS.daysField) — set it manually");
  }
  await sleep(rand(400, 900));

  // Sanity check: values really landed.
  if (textEl.value.trim().length < Math.min(20, task.text.trim().length)) {
    return fail(task, "form_not_found", "text did not stick in the textarea");
  }

  const form = textEl.closest("form");
  form?.addEventListener("submit", () => { void stage(task, "submitted"); }, { capture: true });

  if (task.mode === "auto_submit") {
    const submit = pick<HTMLElement>(SELECTORS.submitButton) ?? (form?.querySelector<HTMLElement>('button[type="submit"], input[type="submit"]') ?? null);
    if (!submit) return fail(task, "form_not_found", "submit button not found — update SELECTORS.submitButton");
    await stage(task, "submitted");
    await progress(task, "form filled — submitting");
    await sleep(rand(800, 1800));
    if (finished) return; // cancelled from the dashboard while filling
    submit.click();
  } else {
    await stage(task, "filled");
    await progress(task, "form filled — waiting for you to review and click Workana's send button");
    banner("form filled ✔ — review it and click Workana's send button yourself. Success is detected automatically.", "#b45309");
  }
  // If the submit is handled via AJAX (no navigation), watch this page for the success message.
  watchForSuccess(task);
}

function watchForSuccess(task: Task) {
  const start = Date.now();
  const limit = task.mode === "auto_submit" ? TIMINGS.successWatchMs : TIMINGS.fillOnlyDeadlineMs;
  const timer = setInterval(async () => {
    if (finished) return clearInterval(timer);
    if (captchaPresent()) { clearInterval(timer); return fail(task, "captcha", "verification challenge after submit"); }
    if (successVisible()) { clearInterval(timer); return succeed(task, "success message on page"); }
    if (task.mode === "auto_submit" && Date.now() - start > limit) {
      clearInterval(timer);
      const errs = textOf(SELECTORS.formError).trim();
      return fail(task, errs ? "form_not_found" : "timeout", errs ? `form error: ${errs.slice(0, 200)}` : "no success message after submitting");
    }
  }, 700);
}

async function verifyAfterSubmit(task: Task) {
  // Workana redirects to the job's chat (/inbox/...) once the bid is placed - that IS the confirmation.
  if (URLS.afterSubmit.some((r) => r.test(location.href)) && !URLS.bidForm.some((r) => r.test(location.href))) {
    return succeed(task, `redirected to ${location.pathname} after submitting`);
  }
  // Give the page a moment to render flash messages.
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (captchaPresent()) return fail(task, "captcha", "verification challenge after submit");
    if (successVisible()) return succeed(task, "success message after navigation");
    if (matchesAny(bodyText(), TEXT.alreadyBid)) return succeed(task, "job page now shows our existing proposal");
    await sleep(500);
  }
  // Still on the form (validation error, or the human hasn't clicked yet) → keep watching.
  if (findForm()) {
    const errs = textOf(SELECTORS.formError).trim();
    if (errs) void progress(task, `form shows an error: ${errs.slice(0, 150)}`);
    if (task.mode === "auto_submit" && errs) return fail(task, "form_not_found", `form error: ${errs.slice(0, 200)}`);
    banner("waiting for you to click Workana's send button…", "#b45309");
    return watchForSuccess(task);
  }
  void progress(task, "submitted, but success could not be verified on this page — confirm in the extension popup");
  banner("could not verify success automatically — open the extension popup and confirm (Mark sent / Mark failed).", "#b45309");
}

void main();

// ---------------------------------------------------------------- message / notification watcher
let lastSig = "";
let lastConvSig = "";
let lastBellSig = "";
function scan(force = false) {
  try {
    const c = readCounters();
    const sig = JSON.stringify(c);
    if (force || sig !== lastSig) {
      lastSig = sig;
      void send({ kind: "counters", ...c });
    }
    // Every page carries the conversation list and the notifications in its header menus.
    const tl = readThreadList();
    const items = tl.items.length ? tl.items : (isInboxPage() ? readConversations() : []);
    const csig = JSON.stringify(items);
    if (items.length && (force || csig !== lastConvSig)) {
      lastConvSig = csig;
      void send({ kind: "conversations", items, own: tl.own });
    }
    const bell = readBell();
    const bsig = JSON.stringify(bell);
    if (bell.length && (force || bsig !== lastBellSig)) {
      lastBellSig = bsig;
      void send({ kind: "bell", items: bell });
    }
  } catch { /* never break the page */ }
}
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.kind === "scan_now") {
    scan(true);
    sendResponse({ counters: readCounters(), conversations: readThreadList().items.length || (isInboxPage() ? readConversations().length : null),
      notifications_list: readBell().length, page: location.pathname });
  }
});
setTimeout(() => scan(true), 2500); // let Workana render its top bar / inbox first
setInterval(() => scan(false), WATCH.scanMs);
new MutationObserver(() => scan(false)).observe(document.querySelector("title") ?? document.head, { childList: true, subtree: true, characterData: true });


// ---------------------------------------------------------------- dashboard inbox: read a conversation / send a reply
interface InboxJob { id: string; op: "read" | "send"; slug: string; text?: string }

async function runInboxJob(job: InboxJob) {
  banner(job.op === "send" ? "sending your reply from the dashboard..." : "reading this conversation for the dashboard...", "#0f766e");
  // /inbox/<project> without the second part: jump to the full address from the header's conversation list.
  const segs = location.pathname.split("/").filter(Boolean);
  if (segs[0] === "inbox" && segs.length === 2) {
    await sleep(2500);
    if (!document.querySelector(THREAD.message[0])) {
      const link = document.querySelector<HTMLAnchorElement>(`a[href*="/messages/index/${job.slug}/"], a[href*="/inbox/${job.slug}/"]`);
      if (link) { location.assign(link.href); return; }
    }
  }
  // Let Workana render the conversation.
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (captchaPresent()) break;
    if (readThread(job.slug).messages.length || textBoxes().length) break;
    await sleep(500);
  }
  await sleep(1200);
  if (captchaPresent()) {
    await send({ kind: "inbox_result", id: job.id, ok: false, error: "verification challenge on the page - open Workana in this profile" });
    return;
  }
  if (isLoggedIn() === false) {
    await send({ kind: "inbox_result", id: job.id, ok: false, error: "not logged in to Workana in this profile" });
    return;
  }
  let sent: { ok: boolean; error?: string; verified?: boolean } | null = null;
  if (job.op === "send" && job.text) {
    sent = await sendReply(job.text);
    await sleep(1500);
  }
  const thread = readThread(job.slug);
  if (!thread.messages.length || (sent && !sent.ok)) snapshot(`conversation: ${sent?.error ?? "no messages recognised"}`);
  else if (thread.media) snapshot("media message"); // voice note / image: lets the exact markup be matched later
  await send({ kind: "inbox_result", id: job.id, ok: sent ? sent.ok : true, error: sent?.error, verified: sent?.verified, thread });
  banner(sent ? (sent.ok ? "reply sent" : `reply NOT sent: ${sent.error}`) : `read ${thread.messages.length} message(s)`,
    sent && !sent.ok ? "#be123c" : "#047857");
}

/** Page structure (no long texts) to your local hub, so selectors can be matched to Workana's real markup. */
function snapshot(reason: string) {
  try {
    void send({ kind: "snapshot", page: pageKind(), path: location.pathname, reason, outline: outline() });
  } catch { /* never break the page */ }
}
