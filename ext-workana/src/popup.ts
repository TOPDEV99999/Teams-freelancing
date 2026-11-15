import { getLocal } from "../../ext-common/hubClient";
import { HUB_URL_DEFAULT } from "./config";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const KEYS = ["hubState", "lastResult", "hubUrl", "token", "accountId", "expectedName", "mode", "counter", "task",
  "counters", "lastConvScan", "watchInbox"];

function setIfIdle(id: string, value: string) {
  const el = $<HTMLInputElement>(id);
  if (document.activeElement !== el) el.value = value;
}

async function render() {
  const s = await getLocal(KEYS);
  const st = s.hubState?.status ?? "disconnected";
  $("dot").className = `dot ${st}`;
  $("status").textContent = st;
  $("statusErr").textContent = s.hubState?.error ?? "";
  $("acctLabel").textContent = s.accountId ? `· ${s.accountId}` : "· not configured";
  const today = new Date().toLocaleDateString("sv");
  $("today").textContent = String(s.counter?.date === today ? s.counter.count : 0);
  $<HTMLSelectElement>("mode").value = s.mode ?? "fill_only";

  if (s.task) {
    $("taskBox").style.display = "";
    $("task").textContent = `#${s.task.submission_id} · ${s.task.job_id} · stage: ${s.task.stage} · $${s.task.price} / ${s.task.days}d`;
  } else {
    $("taskBox").style.display = "none";
  }
  if (s.lastResult) {
    const r = s.lastResult;
    $("last").textContent = `Last: #${r.submission_id} ${r.status}${r.error ? ` (${r.error})` : ""}${r.detail ? ` — ${r.detail}` : ""} · ${new Date(r.at).toLocaleTimeString()}`;
  }
  const c = s.counters;
  const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "not found" : String(v));
  $("watchInfo").textContent = c
    ? `Unread messages: ${fmt(c.messages)} · notifications: ${fmt(c.notifications)}${c.title !== null && c.title !== undefined ? ` · tab title: (${c.title})` : ""} · ${new Date(c.at).toLocaleTimeString()}`
      + (s.lastConvScan ? ` · inbox: ${s.lastConvScan.count} conversations read` : "")
    : "Not checked yet - open any Workana page.";
  $<HTMLInputElement>("watchInbox").checked = s.watchInbox ?? true;
  setIfIdle("accountId", s.accountId ?? "");
  setIfIdle("expectedName", s.expectedName ?? "");
  setIfIdle("hubUrl", s.hubUrl ?? HUB_URL_DEFAULT);
  setIfIdle("token", s.token ?? "");
}

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    accountId: $<HTMLInputElement>("accountId").value.trim().toLowerCase(),
    expectedName: $<HTMLInputElement>("expectedName").value.trim(),
    hubUrl: $<HTMLInputElement>("hubUrl").value.trim() || HUB_URL_DEFAULT,
    token: $<HTMLInputElement>("token").value.trim(),
  });
});
$("mode").addEventListener("change", async () => {
  const mode = $<HTMLSelectElement>("mode").value;
  if (mode === "auto_submit" && !confirm(
    "auto_submit clicks Workana's send button for you.\n\nOnly enable this after verifying every selector in config.ts on a real job page. Continue?")) {
    $<HTMLSelectElement>("mode").value = "fill_only";
    return;
  }
  await chrome.storage.local.set({ mode });
});
$("reconnect").addEventListener("click", () => chrome.runtime.sendMessage({ kind: "reconnect" }));
$("markSent").addEventListener("click", () => {
  if (confirm("Confirm you checked Workana and the proposal WAS sent?")) chrome.runtime.sendMessage({ kind: "manual_result", status: "sent" });
});
$("markFailed").addEventListener("click", () => {
  if (confirm("Mark this submission as failed?")) chrome.runtime.sendMessage({ kind: "manual_result", status: "failed" });
});
$("watchInbox").addEventListener("change", async () => {
  await chrome.storage.local.set({ watchInbox: $<HTMLInputElement>("watchInbox").checked });
});
$("checkNow").addEventListener("click", async () => {
  $("checkResult").textContent = "Checking…";
  const r = await chrome.runtime.sendMessage({ kind: "check_now" });
  const rep = r?.report;
  $("checkResult").textContent = !r?.tabs ? "No Workana tab open - the inbox tab is being opened, try again in a few seconds."
    : rep ? `Page ${rep.page}: messages ${rep.counters.messages ?? "not found"}, notifications ${rep.counters.notifications ?? "not found"}`
      + (rep.conversations !== null ? `, ${rep.conversations} conversations` : "")
      + (rep.notifications_list ? `, ${rep.notifications_list} items in the bell list` : "")
    : "Workana tab is still loading - try again in a few seconds.";
});
chrome.storage.onChanged.addListener(() => render());
render();
