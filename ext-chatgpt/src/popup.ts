import { getLocal } from "../../ext-common/hubClient";
import { HUB_URL_DEFAULT } from "./config";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

async function render() {
  const { hubState, last, hubUrl, token, assistantChats = [] } = await getLocal(["hubState", "last", "hubUrl", "token", "assistantChats"]);
  $("chats").textContent = `Assistant chats still in your ChatGPT history: ${assistantChats.length}`;
  const st = hubState?.status ?? "disconnected";
  $("dot").className = `dot ${st}`;
  $("status").textContent = st;
  $("statusErr").textContent = hubState?.error ?? "";
  if (last?.job) {
    const when = new Date(last.at).toLocaleTimeString();
    $("last").textContent = `Last job: ${last.job} — ${last.status}${last.error ? ` (${last.error})` : ""} at ${when}`;
  }
  const urlEl = $<HTMLInputElement>("hubUrl");
  const tokEl = $<HTMLInputElement>("token");
  if (document.activeElement !== urlEl) urlEl.value = hubUrl ?? HUB_URL_DEFAULT;
  if (document.activeElement !== tokEl) tokEl.value = token ?? "";
}

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    hubUrl: $<HTMLInputElement>("hubUrl").value.trim() || HUB_URL_DEFAULT,
    token: $<HTMLInputElement>("token").value.trim(),
  });
});
$("reconnect").addEventListener("click", () => chrome.runtime.sendMessage({ kind: "reconnect" }));
$("delChats").addEventListener("click", async () => {
  $("delResult").textContent = "Deleting…";
  const r = await chrome.runtime.sendMessage({ kind: "delete_saved_chats" });
  $("delResult").textContent = r?.error ? `Error: ${r.error}` : `Deleted ${r.deleted}${r.failed ? `, ${r.failed} failed` : ""}.`;
});
chrome.storage.onChanged.addListener(() => render());
render();
