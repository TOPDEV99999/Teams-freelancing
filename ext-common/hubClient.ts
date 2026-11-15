/**
 * WebSocket client to the hub, for MV3 service workers.
 *  - registers with role/account/token
 *  - heartbeat every 20 s (keeps the service worker alive on Chrome 116+)
 *  - reconnect with backoff 1s, 2s, 5s, 10s
 *  - a chrome.alarms tick re-opens the socket if the worker was restarted
 * Connection state is mirrored into chrome.storage.local["hubState"] for the popup.
 */

export type HubStatus = "disconnected" | "connecting" | "connected" | "rejected" | "unconfigured";

export interface HubState {
  status: HubStatus;
  error?: string;
  since: number;
}

export interface HubClientOptions {
  role: "chatgpt" | "workana";
  version: string;
  defaultUrl: string;
  /** Extra fields for the register message (e.g. account). Return null if not configured yet. */
  registerExtras: () => Promise<Record<string, unknown> | null>;
  onMessage: (msg: any) => void;
  /** Called on every heartbeat tick (20 s) — handy for timeouts. */
  onTick?: () => void;
}

const BACKOFF = [1000, 2000, 5000, 10000];
const HEARTBEAT_MS = 20000;

export class HubClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private status: HubStatus = "disconnected";

  constructor(private opts: HubClientOptions) {}

  start(): void {
    chrome.alarms.create("hub-keepalive", { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((a) => {
      if (a.name === "hub-keepalive" && !this.isOpen() && this.status !== "rejected") this.connect();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.hubUrl || changes.token || changes.accountId) this.reconnectNow();
    });
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        if (this.isOpen()) this.send({ type: "ping" });
        this.opts.onTick?.();
      }, HEARTBEAT_MS);
    }
    this.connect();
  }

  isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && this.status === "connected";
  }

  send(msg: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  log(message: string, level: "info" | "warn" | "error" = "info"): void {
    console[level === "info" ? "log" : level](`[hub] ${message}`);
    this.send({ type: "log", level, message });
  }

  reconnectNow(): void {
    this.attempt = 0;
    clearTimeout(this.reconnectTimer);
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onclose = null;
      try { old.close(); } catch { /* ignore */ }
    }
    this.connect();
  }

  private async setStatus(status: HubStatus, error?: string) {
    this.status = status;
    const state: HubState = { status, error, since: Date.now() };
    await chrome.storage.local.set({ hubState: state });
  }

  private async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const { hubUrl, token } = await getLocal(["hubUrl", "token"]);
    const extras = await this.opts.registerExtras();
    if (!token || extras === null) {
      await this.setStatus("unconfigured", !token ? "Set the shared secret in the popup" : "Set the Account ID in the popup");
      return;
    }
    const url: string = hubUrl || this.opts.defaultUrl;
    await this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      await this.setStatus("disconnected", String(e));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "register", role: this.opts.role, token, version: this.opts.version, ...extras }));
    };
    ws.onmessage = async (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "registered") {
        this.attempt = 0;
        await this.setStatus("connected");
        return;
      }
      if (msg.type === "register_error") {
        await this.setStatus("rejected", msg.error);
        return;
      }
      if (msg.type === "pong") return;
      this.opts.onMessage(msg);
    };
    ws.onclose = async () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.status === "rejected") return; // wait for settings change / manual reconnect
      await this.setStatus("disconnected");
      this.scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    const delay = BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)];
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until a tab finishes loading (or timeout). */
export function waitTabComplete(tabId: number, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error("tab load timeout")); }, timeoutMs);
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    }).catch(() => { /* ignore */ });
  });
}

/** chrome.storage.local.get with loose typing (values are whatever we stored). */
export function getLocal(keys: string | string[]): Promise<Record<string, any>> {
  return chrome.storage.local.get(keys) as Promise<Record<string, any>>;
}
