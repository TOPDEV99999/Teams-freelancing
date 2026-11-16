export type Currency = "USD" | "BRL" | "MXN";
export const CURRENCY_SYMBOL: Record<Currency, string> = { USD: "US$", BRL: "R$", MXN: "MX$" };
export const CURRENCY_NAME: Record<Currency, string> = { USD: "US dollars (US$)", BRL: "Brazilian reais (R$)", MXN: "Mexican pesos (MX$)" };
/** USD -> the account's currency, rounded like the hub does (what is typed into Workana). */
export function toLocal(usd: number, cur: Currency | undefined, rates?: { BRL: number; MXN: number }): number {
  const c = cur ?? "USD";
  if (c === "USD" || !rates) return Math.round(usd);
  return Math.round(usd * rates[c]);
}
export function toUsd(amount: number, cur: Currency | undefined, rates?: { BRL: number; MXN: number }): number {
  const c = cur ?? "USD";
  return c === "USD" || !rates ? amount : amount / rates[c];
}

export type JobStatus = "new" | "generating" | "drafted" | "sent" | "skipped" | "error";
export type SubStatus = "queued" | "sending" | "sent" | "failed";
export const OUTCOMES = ["none", "replied", "interview", "hired", "rejected"] as const;

export interface Submission {
  id: number;
  job_id: string;
  account_id: string;
  draft_id: number | null;
  style: string | null;
  final_text: string;
  price: number;
  currency?: Currency;
  days: number;
  status: SubStatus;
  error: string | null;
  progress: string | null;
  requested_at: string;
  dispatched_at: string | null;
  sent_at: string | null;
  outcome: string;
  auto?: boolean;
  hold_until?: string | null;
  not_before?: string | null;
  blocked?: string | null;
  /** Auto-send review window: not dispatched before this time (cancel / "Send now"). */
  review_until?: string | null;
  job_title?: string;
  job_url?: string;
}

export interface Draft {
  id: number;
  job_id: string;
  account_id: string;
  style: string;
  text: string;
  suggested_price: number | null;
  suggested_days: number | null;
  created_at: string;
  edited: boolean;
}

export interface Job {
  id: string;
  url: string;
  title: string;
  snippet?: string;
  description?: string;
  budget_text: string;
  budget_min: number | null;
  budget_max: number | null;
  category: string | null;
  skills: string[];
  client_info: Record<string, unknown>;
  posted_at: string | null;
  fetched_at: string;
  status: JobStatus;
  assigned_account_id: string | null;
  locked: boolean;
  last_error: string | null;
  submission: Submission | null;
  /** Accounts that bid on this job (empty list from old data = just the assigned account). */
  targets: string[];
  /** Every account's submission for this job. */
  submissions: Submission[];
  /** Accounts that have drafts. */
  draft_accounts: string[];
  auto_send: boolean;
  auto_style: string;
  draft_count?: number;
  drafts?: Draft[];
  drafts_by_account?: Record<string, Draft[]>;
  generating_accounts?: string[];
  scores?: Record<string, number>;
  trust?: Trust;
}

export type TrustTier = "high" | "good" | "fair" | "new" | "low" | "unknown";
export interface Trust {
  tier: TrustTier; score: number; label: string; reasons: string[];
  paid?: number; published?: number; months?: number | null;
}

export interface Notice {
  id: number;
  ts: string;
  account_id: string | null;
  kind: "message" | "notification" | "test";
  key: string;
  title: string;
  body: string;
  url: string;
  job_id: string | null;
  read: boolean;
}
export interface InboxMessage { id: number; pos: number; author: string; mine: boolean; text: string; time: string; first_seen: string }
export interface Conversation {
  id: number; account_id: string; slug: string; name: string; title: string; snippet: string; unread: boolean; has_client?: boolean;
  updated_at: string; synced_at: string | null; last_error: string; job_id: string | null; url: string; last: InboxMessage | null;
}
export interface ThreadView { conversation: Conversation; messages: InboxMessage[]; verified?: boolean; recognised?: number }
export interface WatchCounters { messages: number | null; notifications: number | null; source?: string; at?: string }

export interface ActivityItem { job_id: string; account_id: string; job_title: string }
export interface Activity {
  generation: { current: ActivityItem | null; queued: ActivityItem[]; next_at: string | null };
  submissions: Submission[];
  auto_jobs: { job_id: string; job_title: string }[];
}

export interface MaintStats {
  db_bytes: number; jobs: number; jobs_by_status: Record<string, number>; drafts: number; submissions: number;
  submissions_by_status: Record<string, number>; logs: number; notices: number; notices_unread: number;
  oldest_job: string | null; oldest_log: string | null; retention_last_run: string | null;
}

export interface Account {
  id: string;
  display_name: string;
  chrome_profile: string;
  profile_text: string;
  prompt_template: string;
  categories: string[];
  min_budget: number | null;
  default_rate: number | null;
  /** Currency of this account's bids on Workana. */
  currency?: Currency;
  daily_limit: number;
  min_delay_seconds: number;
  active: boolean;
  auto_generate: boolean;
  paused: boolean;
  pause_reason: string | null;
  ext_connected: boolean;
  last_seen_at: string | null;
  today_count?: number;
  last_dispatch_at?: string | null;
  next_allowed_at?: string | null;
}

export interface ConnInfo { connected: boolean; version?: string; last_seen_at?: string }
export interface ExtStatus { chatgpt: ConnInfo; workana: Record<string, ConnInfo> }

export interface UrgentStatus { job_id: string; title: string; started_at: string; ends_at: string }
export interface HubStatus {
  build: string;
  urgent?: UrgentStatus | null;
  expected_ext_version: string;
  expected_chatgpt_version?: string;
  extensions: ExtStatus;
  generation: { current: string | null; current_account: string | null; queued: string[]; next_at: string | null };
  next_global_dispatch_at: string | null;
  secret_configured: boolean;
  quiet_hours_active: boolean;
  counters?: Record<string, WatchCounters>;
  active_submissions?: number;
  presence?: { paused_s: number; checked: number; last_error: string | null };
  fetcher?: { running: boolean; enabled: boolean; busy: boolean; last_run_at: string | null; last_error: string | null;
    total_new: number; restarts: number };
}

export interface LogEvent {
  id: number;
  ts: string;
  kind: string;
  level: "info" | "warn" | "error";
  message: string;
  job_id: string | null;
  account_id: string | null;
}

export interface Style { key: string; instructions: string }
export interface SettingsValues {
  master_prompt: string;
  styles: Style[];
  fetch_interval_seconds: number;
  generation_provider: "chatgpt_web" | "openai_api";
  jitter_min_seconds: number;
  jitter_max_seconds: number;
  generation_pause_min_seconds: number;
  generation_pause_max_seconds: number;
  quiet_hours: { enabled: boolean; start: string; end: string };
  assign_threshold: number;
  fetcher_enabled: boolean;
  workana_filters: WorkanaFilters;
  telegram: { enabled: boolean; bot_token: string; chat_ids: string };
  auto_send: AutoSend;
  retention: Retention;
  translation: { provider: "auto" | "browser" | "google"; target: string };
  notifications: { telegram: boolean; auto_outcome: boolean };
  chatgpt: { temporary_chat: boolean; delete_after_reply: boolean };
  presence: { enabled: boolean; interval_minutes: number; max_age_hours: number };
  currency_rates: { BRL: number; MXN: number; updated_at?: string; source?: string };
}
export interface AutoSend {
  review_seconds: number;
  style_mode: "fixed" | "rotate" | "random";
  price_mode: "suggested" | "budget_min" | "budget_mid" | "budget_max_pct";
  price_pct: number;
  min_price: number;
  max_price: number;
  min_trust: "any" | "new" | "fair" | "good" | "high";
  max_bids: number;
  daily_cap: number;
  autopilot: boolean;
  autopilot_accounts: string[];
}
export interface Retention {
  enabled: boolean; logs_days: number; jobs_days: number; job_statuses: string[]; keep_sent: boolean; notices_days: number;
}
export interface WorkanaFilters {
  languages: string[];
  allow_fixed: boolean;
  min_budget: number;
  allow_hourly: boolean;
  min_hourly_rate: number;
  skills: string[];
  min_client_since: string;
  min_paid_ratio: number;
  min_published: number;
  skip_closed: boolean;
  check_job_page: boolean;
  include_featured: boolean;
  impersonate: string;
}
export interface FetcherHealth {
  cycle?: number; recreations?: number; consecutive_cf?: number; consecutive_failures?: number; consecutive_empty?: number;
  last_ok_ts?: number | null; last_nonempty_ts?: number | null; last_cycle_ts?: number | null; last_error?: string | null;
  listed?: number; matched_total?: number; filtered_total?: number; seen?: number; seeded?: boolean; session_age_s?: number;
}
export interface FetcherStatus {
  name: string; enabled: boolean; running: boolean; busy: boolean;
  last_run_at: string | null; next_run_at: string | null; last_error: string | null;
  last_new: number; total_new: number; health: FetcherHealth;
}
export interface PromptPreview {
  prompt: string; source: "account" | "master"; job: { id: string; title: string; sample: boolean }; warnings: string[];
}
export interface SettingsResponse {
  values: SettingsValues;
  template_variables: string[];
  defaults: { master_prompt: string; styles: Style[] };
  env: { fetcher: string; openai_configured: boolean; generation_timeout_seconds: number; submit_timeout_seconds: number };
}

export interface StatRow {
  sent: number; replied: number; interview: number; hired: number; rejected: number; failed: number;
  reply_rate: number; hire_rate: number;
}
export interface StatsResponse {
  days: number;
  by_account: (StatRow & { account_id: string })[];
  by_style: (StatRow & { style: string })[];
  by_account_style: (StatRow & { account_id: string; style: string })[];
  daily_sent: { date: string; sent: number }[];
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const j = await r.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch { /* not json */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export const api = {
  jobs: () => req<Job[]>("GET", "/api/jobs?limit=1000"),
  job: (id: string) => req<Job>("GET", `/api/jobs/${encodeURIComponent(id)}`),
  assign: (id: string, account: string | null) =>
    req<Job>("PATCH", `/api/jobs/${encodeURIComponent(id)}`, { assigned_account_id: account }),
  generate: (id: string, accountIds?: string[]) =>
    req<{ accounts: string[] }>("POST", `/api/jobs/${encodeURIComponent(id)}/generate`, accountIds ? { account_ids: accountIds } : undefined),
  updateJob: (id: string, body: { assigned_account_id?: string | null; target_accounts?: string[]; auto_send?: boolean; auto_style?: string }) =>
    req<Job>("PATCH", `/api/jobs/${encodeURIComponent(id)}`, body),
  batch: (body: { job_ids: string[]; account_ids: string[]; auto_send: boolean; auto_style: string; generate?: boolean }) => // [] = matching accounts
    req<{ jobs: string[]; skipped: string[]; generations_queued: number }>("POST", "/api/jobs/batch", body),
  send: (id: string, body: { account_id: string; draft_id: number | null; final_text: string; price: number; days: number }) =>
    req<Submission>("POST", `/api/jobs/${encodeURIComponent(id)}/send`, body),
  skip: (id: string) => req<Job>("POST", `/api/jobs/${encodeURIComponent(id)}/skip`),
  unskip: (id: string) => req<Job>("POST", `/api/jobs/${encodeURIComponent(id)}/unskip`),
  editDraft: (id: number, text: string) => req<Draft>("PATCH", `/api/drafts/${id}`, { text }),
  accounts: () => req<Account[]>("GET", "/api/accounts"),
  createAccount: (a: Partial<Account> & { id: string }) => req<Account>("POST", "/api/accounts", a),
  updateAccount: (id: string, a: Partial<Account>) => req<Account>("PATCH", `/api/accounts/${id}`, a),
  deleteAccount: (id: string) => req<unknown>("DELETE", `/api/accounts/${id}`),
  resumeAccount: (id: string) => req<Account>("POST", `/api/accounts/${id}/resume`),
  submissions: () => req<Submission[]>("GET", "/api/submissions?limit=2000"),
  setOutcome: (id: number, outcome: string) => req<Submission>("PATCH", `/api/submissions/${id}`, { outcome }),
  retry: (id: number) => req<Submission>("POST", `/api/submissions/${id}/retry`),
  cancel: (id: number) => req<unknown>("POST", `/api/submissions/${id}/cancel`),
  markSent: (id: number) => req<Submission>("POST", `/api/submissions/${id}/mark-sent`),
  stats: (days: number) => req<StatsResponse>("GET", `/api/stats?days=${days}`),
  settings: () => req<SettingsResponse>("GET", "/api/settings"),
  saveSettings: (v: Partial<SettingsValues>) => req<{ values: SettingsValues }>("PUT", "/api/settings", v),
  fetcher: () => req<FetcherStatus>("GET", "/api/fetcher"),
  fetcherStart: () => req<FetcherStatus>("POST", "/api/fetcher/start"),
  fetcherStop: () => req<FetcherStatus>("POST", "/api/fetcher/stop"),
  fetcherCheck: () => req<FetcherStatus>("POST", "/api/fetcher/check"),
  fetcherResetSeen: () => req<FetcherStatus>("POST", "/api/fetcher/reset-seen"),
  telegramTest: (bot_token: string, chat_ids: string) =>
    req<{ ok: boolean; sent: number; total: number; error: string | null }>("POST", "/api/telegram/test", { bot_token, chat_ids }),
  promptPreview: (account_id: string, template: string | null, job_id?: string) =>
    req<PromptPreview>("POST", "/api/prompts/preview", { account_id, template, job_id }),
  logs: () => req<LogEvent[]>("GET", "/api/logs?limit=500"),
  status: () => req<HubStatus>("GET", "/api/status"),
  stopGeneration: (id: string) => req<{ dropped: number; current: number }>("POST", `/api/jobs/${encodeURIComponent(id)}/stop-generation`),
  watchPresence: (id: string) => req<unknown>("POST", `/api/jobs/${encodeURIComponent(id)}/presence`),
  deleteJob: (id: string) => req<unknown>("DELETE", `/api/jobs/${encodeURIComponent(id)}`),
  deleteJobs: (ids: string[]) => req<{ deleted: string[]; kept: Record<string, string> }>("POST", "/api/jobs/delete", { job_ids: ids }),
  release: (id: number) => req<Submission>("POST", `/api/submissions/${id}/release`),
  renameAccount: (id: string, newId: string) => req<Account>("POST", `/api/accounts/${id}/rename`, { new_id: newId }),
  deleteAccountPurge: (id: string, purge: boolean) => req<unknown>("DELETE", `/api/accounts/${id}?purge=${purge}`),
  accountHistory: (id: string) => req<{ submissions: number; drafts: number; notices: number }>("GET", `/api/accounts/${id}/history`),
  notices: () => req<{ items: Notice[]; counters: Record<string, WatchCounters> }>("GET", "/api/notices?limit=500"),
  noticesRead: (body: { ids?: number[]; all?: boolean; read?: boolean }) => req<{ updated: number }>("POST", "/api/notices/read", body),
  noticeTest: (account_id?: string) => req<{ created: number }>("POST", "/api/notices/test", { account_id: account_id ?? null }),
  conversations: (account?: string) =>
    req<{ items: Conversation[]; hidden: number }>("GET", `/api/inbox/conversations${account ? `?account=${encodeURIComponent(account)}` : ""}`),
  thread: (account: string, slug: string) => req<ThreadView>("GET", `/api/inbox/${encodeURIComponent(account)}/${encodeURIComponent(slug)}`),
  threadRefresh: (account: string, slug: string) =>
    req<ThreadView>("POST", `/api/inbox/${encodeURIComponent(account)}/${encodeURIComponent(slug)}/refresh`),
  threadSend: (account: string, slug: string, text: string) =>
    req<ThreadView>("POST", `/api/inbox/${encodeURIComponent(account)}/${encodeURIComponent(slug)}/send`, { text }),
  threadRead: (account: string, slug: string) =>
    req<{ ok: boolean }>("POST", `/api/inbox/${encodeURIComponent(account)}/${encodeURIComponent(slug)}/read`),
  inboxCheck: (account: string) => req<{ ok: boolean }>("POST", `/api/inbox/${encodeURIComponent(account)}/check`),
  makeUrgent: (jobId: string) => req<{ queued_now: string[]; generating: string[]; not_queued: string[]; urgent: UrgentStatus }>(
    "POST", `/api/jobs/${encodeURIComponent(jobId)}/urgent`),
  endUrgent: () => req<{ ended: string | null }>("DELETE", "/api/urgent"),
  refreshRates: () => req<{ currency_rates: SettingsValues["currency_rates"] }>("POST", "/api/settings/currency-rates/refresh"),
  noticesClear: (onlyRead = false) => req<{ deleted: number }>("DELETE", `/api/notices?only_read=${onlyRead}`),
  maintStats: () => req<MaintStats>("GET", "/api/maintenance/stats"),
  clearLogs: (older_than_days = 0) => req<{ deleted: number }>("POST", "/api/maintenance/logs/clear", { older_than_days }),
  purgeJobs: (body: { older_than_days: number; statuses: string[]; keep_sent: boolean }) =>
    req<{ deleted: number; kept: number }>("POST", "/api/maintenance/jobs/purge", body),
  purgeDrafts: (older_than_days: number) => req<{ deleted: number }>("POST", "/api/maintenance/drafts/purge", { older_than_days }),
  clearNoticesOlder: (older_than_days: number) => req<{ deleted: number }>("POST", "/api/maintenance/notices/clear", { older_than_days }),
  vacuum: () => req<{ before: number; after: number }>("POST", "/api/maintenance/vacuum"),
  runRetention: () => req<{ logs?: number; jobs?: number; notices?: number }>("POST", "/api/maintenance/retention/run"),
  deleteChatgptChats: () => req<{ deleted?: number; failed?: number; remaining?: number; note?: string; first_error?: string }>(
    "POST", "/api/maintenance/chatgpt/delete-chats", {}),
  activity: () => req<Activity>("GET", "/api/activity"),
  cancelAll: () => req<{ generations: number; submissions: number; auto_send_off: number; activity: Activity }>("POST", "/api/control/cancel-all", {}),
  translate: (texts: string[], target: string) =>
    req<{ translations: string[]; detected: string | null; provider: string }>("POST", "/api/translate", { texts, target }),
};

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Server sends naive-UTC ISO strings with a trailing Z. */
export function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s + "Z");
}

export function fmtTime(s: string | null | undefined): string {
  const d = parseDate(s);
  if (!d) return "—";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function ago(s: string | null | undefined): string {
  const d = parseDate(s);
  if (!d) return "—";
  const sec = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
