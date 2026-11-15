/**
 * Finding the proposal form and the bid button on Workana's job page - robust against the chat preview that
 * pops up from the bottom when the account has unread messages (see page.ts).
 */
import { matchesAny } from "../../ext-common/dom";
import { SELECTORS, TEXT, URLS } from "./config";
import { all, onPage, pick, textBoxes } from "./page";

export interface FormParts { scope: HTMLElement; text: HTMLTextAreaElement; amount: HTMLInputElement | null }

/** The area around a text box that also holds the amount field (the proposal form), or null. */
function amountNear(text: HTMLElement): { scope: HTMLElement; amount: HTMLInputElement } | null {
  for (let box: HTMLElement | null = text.parentElement, i = 0; box && i < 10; box = box.parentElement, i++) {
    const amount = pick<HTMLInputElement>(SELECTORS.amountField, box);
    if (amount) return { scope: box, amount };
    if (box.tagName === "FORM") break;
  }
  return null;
}

/**
 * The proposal form: a text box WITH an amount field next to it. A lone text box is not enough - the chat
 * preview that pops up when you have unread messages has one too (it caused "amount field not found").
 */
export function findForm(): FormParts | null {
  const boxes = [...all<HTMLTextAreaElement>(SELECTORS.textField), ...textBoxes()]
    .filter((e, i, arr) => arr.indexOf(e) === i && onPage(e) && e.tagName === "TEXTAREA") as HTMLTextAreaElement[];
  for (const text of boxes) {
    const near = amountNear(text);
    if (near) return { scope: near.scope, text, amount: near.amount };
  }
  // On the proposal-form URL itself the biggest text box is the proposal (amount is checked when filling).
  if (URLS.bidForm.some((r) => r.test(location.href)) && boxes.length) {
    return { scope: (boxes[0].closest("form") as HTMLElement | null) ?? document.body, text: boxes[0], amount: null };
  }
  return null;
}

/** The job page's bid button - never one inside the chat preview or another pop-up. */
export function findBidButton(task: { job_id: string }): HTMLElement | null {
  const slug = task.job_id;
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/bid/"]'));
  return links.find((a) => onPage(a) && (a.getAttribute("href") ?? "").includes(slug))
    ?? pick<HTMLElement>(SELECTORS.bidButton)
    ?? Array.from(document.querySelectorAll<HTMLElement>("a, button, [role='button']"))
      .find((e) => onPage(e) && matchesAny((e.innerText || "").trim(), TEXT.bidButton))
    ?? null;
}

/**
 * VERIFIED (page captures, Nov 2026): without Connects, the job page's "Place a bid" is href="#" and opens
 * Workana's plan wall ("Improve your plan", div.modal-plan-wall.no-connects); the form URL says "Access Denied".
 */
export function noConnects(task: { job_id: string }): boolean {
  if (!document.querySelector(".modal-plan-wall.no-connects")) return false;
  const btn = findBidButton(task);
  return !btn || (btn.getAttribute("href") ?? "#") === "#" || !!btn.closest("article.block-cta")?.querySelector(".no-connects");
}

/** Workana's error page ("Access Denied"…) instead of the requested page. */
export function errorPageTitle(): string | null {
  const t = document.querySelector("section.error-section .error-title");
  return t ? (t.textContent ?? "").trim() || "error page" : null;
}

/** Where the bid button would lead: a link to this job's bid form anywhere in the page, even if hidden. */
export function bidFormUrl(task: { job_id: string }): string | null {
  const a = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/bid/"]'))
    .find((x) => (x.getAttribute("href") ?? "").includes(task.job_id));
  return a ? new URL(a.getAttribute("href")!, location.href).href : null;
}

