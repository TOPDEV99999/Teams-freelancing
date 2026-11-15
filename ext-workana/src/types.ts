export type Mode = "fill_only" | "auto_submit";

export type Stage = "opening" | "job_page" | "clicked_bid" | "form" | "filled" | "submitted";

export interface Task {
  submission_id: number;
  job_id: string;
  url: string;
  text: string;
  price: number;
  days: number;
  tabId: number;
  stage: Stage;
  mode: Mode;
  deadline: number;
  startedAt: number;
}

export type ErrorCode =
  | "not_logged_in" | "wrong_account" | "job_closed" | "already_bid" | "no_credits"
  | "form_not_found" | "captcha" | "timeout" | "busy" | "manual";

/** Messages from content script → background */
export type ContentMsg =
  | { kind: "hello"; page?: string }
  | { kind: "inbox_result"; id: string; ok: boolean; error?: string; verified?: boolean; thread?: unknown }
  | { kind: "snapshot"; page: string; path: string; reason: string; outline: string }
  | { kind: "counters"; messages: number | null; notifications: number | null; title: number | null }
  | { kind: "conversations"; items: { slug: string; url: string; name: string; snippet: string; unread: boolean; title?: string }[]; own?: string | null }
  | { kind: "bell"; items: { key: string; title: string; body: string }[] }
  | { kind: "stage"; submission_id: number; stage: Stage }
  | { kind: "progress"; submission_id: number; text: string }
  | { kind: "result"; submission_id: number; status: "sent" | "failed"; error?: ErrorCode; detail?: string };
