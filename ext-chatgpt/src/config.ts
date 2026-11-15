/**
 * ALL ChatGPT DOM selectors live here. When chatgpt.com changes its markup, fix them here
 * (right-click the element → Inspect, then try `document.querySelector("...")` in the console).
 * Each entry is a list: the first selector that matches wins. Entries starting with "TODO" are ignored.
 */

export const VERSION = "1.2.0";
export const HUB_URL_DEFAULT = "ws://127.0.0.1:8766/ws/ext";
export const CHATGPT_URL = "https://chatgpt.com/";

/** Open a fresh chat for every job (recommended: keeps context from leaking between jobs). */
export const NEW_CHAT_EACH_REQUEST = true;

/** Default for "temporary chats" (not saved to your history). The hub's Data page setting overrides it per prompt. */
export const TEMPORARY_CHAT = true;
export const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";

export const SELECTORS = {
  /** The message composer (a ProseMirror contenteditable div today; older UI used a <textarea>). */
  composer: [
    "#prompt-textarea",
    'div[contenteditable="true"].ProseMirror',
    'textarea[data-id="root"]',
  ],
  sendButton: [
    'button[data-testid="send-button"]',
    "#composer-submit-button",
    'button[aria-label="Send prompt"]',
    'button[aria-label*="Send"]',
  ],
  stopButton: [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]',
  ],
  /** Every assistant turn; we read the LAST one. */
  assistantMessage: [
    '[data-message-author-role="assistant"]',
    '[data-turn="assistant"]',
    '[data-testid="assistant-message"]',
    ".agent-turn",
  ],
  /** Used only when none of the above match: the last turn whose text isn't our own prompt. */
  turnFallback: ['article[data-testid^="conversation-turn"]', "article", ".markdown"],
  /** Present when logged out. */
  loginButton: ['button[data-testid="login-button"]', 'a[href*="/auth/login"]', 'button[data-testid="welcome-login-button"]'],
  /** Bot / human verification widgets. */
  captcha: [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="arkoselabs"]',
    'iframe[title*="challenge"]',
    "#challenge-form",
    "#cf-challenge-running",
  ],
  /** Containers where ChatGPT shows limit / error notices (NOT the chat messages themselves). */
  notices: ['[role="alert"]', '[role="dialog"]', '[data-testid*="error"]', ".text-token-text-error", '[class*="text-red"]'],
} as const;

/** Matched only against the text of `SELECTORS.notices` (never against the chat, which contains the job text). */
export const TEXT_PATTERNS = {
  rateLimit: [
    /you['’]ve (?:hit|reached) (?:the|your) .{0,40}limit/i,
    /usage (?:cap|limit)/i,
    /too many requests/i,
    /rate limit/i,
    /try again (?:later|after)/i,
  ],
  unusual: [/unusual activity/i, /verify you are (?:a )?human/i, /suspicious activity/i, /are you a robot/i],
  sessionExpired: [/session (?:has )?expired/i, /please log ?in/i],
} as const;

export const TIMINGS = {
  composerWaitMs: 20000,
  /** Reply must stay unchanged this long (and the stop button be gone) to count as finished. */
  completionStableMs: 2000,
  /** If the stop button never disappears, accept the reply once its text has been unchanged this long. */
  stuckStableMs: 20000,
  /** Max time to wait for the full reply (hub GENERATION_TIMEOUT_SECONDS defaults to 300 s). */
  maxWaitMs: 200000,
  /** Max time for the reply to start (thinking models can take a while). */
  startWaitMs: 60000,
} as const;
