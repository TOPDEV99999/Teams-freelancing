import { HubClient, getLocal, sleep, waitTabComplete } from "../../ext-common/hubClient";
import { CHATGPT_URL, HUB_URL_DEFAULT, NEW_CHAT_EACH_REQUEST, TEMPORARY_CHAT, TEMPORARY_CHAT_URL, VERSION } from "./config";

let busy = false;

const client = new HubClient({
  role: "chatgpt",
  version: VERSION,
  defaultUrl: HUB_URL_DEFAULT,
  registerExtras: async () => ({}),
  onMessage: (msg) => {
    if (msg.type === "generate") void handleGenerate(msg);
    else if (msg.type === "cancel_generate") void handleCancel();
    else if (msg.type === "delete_chats") void handleDeleteChats(msg.request_id);
  },
});
client.start();

async function setLast(patch: Record<string, unknown>) {
  const { last = {} } = await getLocal("last");
  await chrome.storage.local.set({ last: { ...last, ...patch, at: Date.now() } });
}

async function getChatTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  const { chatTabId } = await getLocal("chatTabId");
  const preferred = tabs.find((t) => t.id === chatTabId) ?? tabs[0];
  if (preferred?.id !== undefined) return preferred;
  const tab = await chrome.tabs.create({ url: CHATGPT_URL, active: false });
  await chrome.storage.local.set({ chatTabId: tab.id });
  return tab;
}

async function pingContent(tabId: number, tries = 20): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { kind: "ping" });
      if (r?.ok) return true;
    } catch { /* not ready yet */ }
    await sleep(500);
  }
  return false;
}

let currentTab: number | null = null;

async function handleCancel() {
  if (!busy || currentTab === null) return;
  try { await chrome.tabs.sendMessage(currentTab, { kind: "cancel" }); } catch { /* tab gone */ }
  client.log("generation cancelled from the dashboard (pressed ChatGPT's Stop)", "info");
}

/** Chats the assistant created that are still in your ChatGPT history (normal, non-temporary chats). */
async function getSavedChats(): Promise<string[]> {
  const { assistantChats = [] } = await getLocal("assistantChats");
  return assistantChats as string[];
}
async function setSavedChats(ids: string[]) {
  await chrome.storage.local.set({ assistantChats: [...new Set(ids)].slice(-2000) });
}

async function deleteChats(ids: string[]): Promise<{ deleted: string[]; failed: { id: string; error: string }[] }> {
  const tab = await getChatTab();
  await waitTabComplete(tab.id!, 30000).catch(() => undefined);
  if (!(await pingContent(tab.id!))) throw new Error("content script not responding on chatgpt.com (reload the tab)");
  const r = await chrome.tabs.sendMessage(tab.id!, { kind: "delete_conversations", ids });
  if (r?.error) throw new Error(r.error);
  return r;
}

async function handleDeleteChats(requestId: string) {
  const reply = (data: Record<string, unknown>) => client.send({ type: "command_result", request_id: requestId, ...data });
  if (busy) return reply({ error: "ChatGPT is busy with a proposal - try again in a moment" });
  busy = true;
  try {
    const ids = await getSavedChats();
    if (!ids.length) return reply({ deleted: 0, failed: 0, remaining: 0, note: "no saved assistant chats (temporary chats are never saved)" });
    const r = await deleteChats(ids);
    const rest = ids.filter((id) => !r.deleted.includes(id));
    await setSavedChats(rest);
    reply({ deleted: r.deleted.length, failed: r.failed.length, remaining: rest.length,
      ...(r.failed.length ? { first_error: r.failed[0].error } : {}) });
  } catch (e) {
    reply({ error: `could not delete chats: ${(e as Error).message}` });
  } finally {
    busy = false;
  }
}

async function handleGenerate(msg: { request_id: string; job_id: string; prompt: string; temporary_chat?: boolean; delete_after?: boolean }) {
  const fail = async (error: string) => {
    client.send({ type: "generate_error", request_id: msg.request_id, error });
    await setLast({ job: msg.job_id, status: "error", error });
  };
  if (busy) return fail("busy: another generation is in progress");
  busy = true;
  await setLast({ job: msg.job_id, status: "generating", error: null });
  try {
    const tab = await getChatTab();
    const tabId = tab.id!;
    currentTab = tabId;
    await chrome.storage.local.set({ chatTabId: tabId });
    const temporary = msg.temporary_chat ?? TEMPORARY_CHAT;
    if (NEW_CHAT_EACH_REQUEST) {
      await chrome.tabs.update(tabId, { url: temporary ? TEMPORARY_CHAT_URL : CHATGPT_URL });
      await sleep(500);
    }
    await waitTabComplete(tabId, 30000);
    if (!(await pingContent(tabId))) return fail("content script not responding on chatgpt.com (reload the tab)");

    const res = await chrome.tabs.sendMessage(tabId, { kind: "generate", prompt: msg.prompt, request_id: msg.request_id });
    if (res?.ok) {
      client.send({ type: "generated", request_id: msg.request_id, raw_text: res.text });
      await setLast({ job: msg.job_id, status: "ok", chars: res.text.length });
      await afterReply(tabId, msg.delete_after ?? true);
    } else {
      await fail(res?.error ?? "unknown error from content script");
    }
  } catch (e) {
    await fail(`extension error: ${(e as Error).message}`);
  } finally {
    busy = false;
    currentTab = null;
  }
}

/** Keep ChatGPT history clean: delete a normal (non-temporary) chat right after its reply was read,
 *  or remember it so "Delete assistant chats" can remove it later. */
async function afterReply(tabId: number, deleteNow: boolean) {
  try {
    let conv: { id: string | null; temporary: boolean } | null = null;
    for (let i = 0; i < 6; i++) { // the /c/<id> URL appears shortly after the first reply
      conv = await chrome.tabs.sendMessage(tabId, { kind: "conversation" });
      if (conv?.id || conv?.temporary) break;
      await sleep(500);
    }
    if (!conv?.id || conv.temporary) return;
    if (deleteNow) {
      const r = await chrome.tabs.sendMessage(tabId, { kind: "delete_conversations", ids: [conv.id] });
      if (r?.deleted?.includes(conv.id)) return;
      client.log(`could not delete the chat from ChatGPT history: ${r?.error ?? r?.failed?.[0]?.error ?? "unknown"}`, "warn");
    }
    await setSavedChats([...(await getSavedChats()), conv.id]);
  } catch { /* history clean-up is best effort */ }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === "reconnect") {
    client.reconnectNow();
    sendResponse({ ok: true });
  } else if (msg?.kind === "delete_saved_chats") {
    (async () => {
      if (busy) return sendResponse({ error: "busy with a proposal - try again in a moment" });
      busy = true;
      try {
        const ids = await getSavedChats();
        const r = await deleteChats(ids);
        await setSavedChats(ids.filter((id) => !r.deleted.includes(id)));
        sendResponse({ deleted: r.deleted.length, failed: r.failed.length });
      } catch (e) {
        sendResponse({ error: (e as Error).message });
      } finally {
        busy = false;
      }
    })();
    return true;
  }
});
