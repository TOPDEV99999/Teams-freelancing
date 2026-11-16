/**
 * ALL Workana selectors and text patterns live here.
 *
 * ⚠️ These were written WITHOUT access to Workana's live DOM. Every list contains best guesses
 * plus a "TODO" marker. Before using auto_submit, verify each one on a real job page:
 * see README → "Finding the Workana selectors". Entries starting with "TODO" are ignored.
 * Each list is tried in order; the first selector that matches wins.
 */

export const VERSION = "1.3.5";

/** Close the job tab ~5 s after a proposal is verified as sent (failed tabs stay open). */
export const CLOSE_TAB_AFTER_SUCCESS = true;
export const HUB_URL_DEFAULT = "ws://127.0.0.1:8766/ws/ext";

export const SELECTORS = {
  /** Any element that exists ONLY when logged in (avatar, user menu, logout link…). */
  loggedIn: [
    "TODO: verify — user avatar / menu in the top bar",
    'a[href*="/logout"]',
    'a[href*="/dashboard"]',
    ".user-avatar",
    "#user-menu",
  ],
  /** Element whose text contains the logged-in username / display name (for the wrong-account check). */
  accountName: [
    "TODO: verify — element in the top bar showing your name",
    "nav .user-name", "header .user-name", ".navbar .user-name", "#header .user-name",
    "nav .profile-name", "header .profile-name", ".navbar .profile-name",
    "nav [class*='username']", "header [class*='username']",
  ],
  /** Never read the account name from inside these (the job's client card also uses .user-name). */
  accountNameExclude: ['a[href^="/e/"]', "#productName", ".project-view-v3", ".project-details", "main", "section"],
  /**
   * Job status label (VERIFIED on live job pages, Nov 2026): <header id="productName"><span class="pry label rounded open">.
   * The last class is the state: "open" = taking bids; anything else (e.g. "escrowing" = Waiting for escrow) = closed.
   */
  jobStatus: ["header#productName span.label"],
  /** Login link/button shown to logged-out visitors. */
  loginLink: ['a[href*="/login"]', 'a[href*="/signin"]'],

  /** On the job page: the button/link that opens the proposal form. */
  bidButton: [
    "TODO: verify — 'Enviar propuesta' / 'Enviar proposta' / 'Send proposal' button",
    'a[href*="/messages/bid/"]',
    'a[href*="/bid/"]',
    "#bid_button",
    "a.btn-bid",
  ],

  /** The proposal form and its fields. */
  form: ["TODO: verify — the proposal <form>", "form#BidForm", 'form[action*="bid"]', 'form[id*="bid" i]'],
  textField: [
    "TODO: verify — proposal text textarea",
    "textarea#BidContent",
    'textarea[name*="content" i]',
    'textarea[name*="Bid" i]',
    "form textarea",
  ],
  amountField: [
    "TODO: verify — price / amount input (what YOU charge, not what the client pays)",
    "input#Amount",
    'input[name*="amount" i]',
    'input[name*="price" i]',
  ],
  daysField: [
    "TODO: verify — delivery time input or select",
    "input#BidDeliveryTime",
    'input[name*="delivery" i]',
    'select[name*="delivery" i]',
    'input[name*="days" i]',
  ],
  submitButton: [
    "TODO: verify — the form's final send button",
    'form#BidForm button[type="submit"]',
    'form#BidForm input[type="submit"]',
    'form[action*="bid"] button[type="submit"]',
  ],

  /** Shown after a successful submission. */
  success: ["TODO: verify — success flash/alert after sending", ".alert-success", ".flash-success", ".notification-success"],
  /** Validation errors on the form. */
  formError: [".error-message", ".alert-danger", ".has-error .help-block", ".invalid-feedback", ".form-error"],
  /** Bot checks. Never interacted with — only reported. */
  captcha: [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="challenges.cloudflare.com"]',
    ".g-recaptcha",
    ".h-captcha",
    "#challenge-form",
  ],
} as const;

/** Text patterns (es / pt / en) searched in the page body. Adjust to the exact wording you see. */
export const TEXT = {
  alreadyBid: [
    /ya (?:enviaste|has enviado|realizaste) (?:una )?propuesta/i,
    /j[áa] (?:enviou|enviaste) (?:uma )?proposta/i,
    /you(?:'ve| have) already (?:sent|submitted|placed) (?:a )?(?:proposal|bid)/i,
    /editar (?:mi |minha )?propuesta|editar (?:minha )?proposta/i,
  ],
  jobClosed: [
    /proyecto (?:cerrado|finalizado|cancelado)/i,
    /projeto (?:fechado|encerrado|finalizado|cancelado)/i,
    /project (?:is )?(?:closed|finished|cancell?ed)/i,
    /ya no (?:recibe|acepta) (?:m[áa]s )?propuestas/i,
    /n[ãa]o (?:recebe|aceita) mais propostas/i,
  ],
  noCredits: [
    /no tienes (?:suficientes )?(?:bids|connects|propuestas disponibles)/i,
    /(?:sem|n[ãa]o tem) (?:bids|connects|propostas) dispon[íi]veis/i,
    /(?:out of|not enough|no) (?:bids|connects|credits)/i,
    /compr(?:ar|a) m[áa]s (?:bids|connects)/i,
  ],
  success: [
    /propuesta (?:fue )?enviada/i,
    /proposta (?:foi )?enviada/i,
    /proposal (?:was )?(?:sent|submitted)/i,
    /tu propuesta ha sido enviada/i,
    /you have placed a new bid/i,
  ],
  captcha: [/verify you are human/i, /no soy un robot/i, /n[ãa]o sou um rob[ôo]/i, /unusual activity/i],
  /** Label of the job page's bid button (also after Chrome's page translation). */
  bidButton: [
    /^\s*(?:place a bid|send (?:a )?proposal|bid now|make (?:a )?(?:bid|proposal))\s*$/i,
    /^\s*(?:enviar|env[ií]a|hacer|haz|realizar|presentar) (?:una )?(?:propuesta|oferta)\s*$/i,
    /^\s*(?:enviar|envie|fazer|realizar) (?:uma )?(?:proposta|oferta)\s*$/i,
    /^\s*(?:ofertar|postularme|candidatar-se|haz una oferta|coloca una oferta|colocar una oferta)\s*$/i,
  ],
} as const;

/** URL fragments that indicate we're on the proposal form page / a post-submit page. */
/**
 * The proposal form has its own address: https://www.workana.com/messages/bid/<job-slug> (verified Nov 2026).
 * The extension opens it directly instead of clicking the button on the job page.
 */
export function bidFormUrlFor(jobId: string, jobUrl: string): string | null {
  const slug = /^[A-Za-z0-9_-]{2,250}$/.test(jobId) ? jobId : (jobUrl.match(/workana\.com\/job\/([A-Za-z0-9_-]+)/)?.[1] ?? "");
  return slug ? `https://www.workana.com/messages/bid/${slug}` : null;
}

export const URLS = {
  bidForm: [/\/messages\/bid\//i, /\/bid\//i],
  /** Workana redirects to the project's chat (/inbox/<job-slug>) after a bid is placed (verified Nov 2026). */
  afterSubmit: [/\/inbox\//i, /\/messages\/?(?:\?|$)/i, /bid_sent|proposal_sent|success/i],
};

/** Message / notification watcher (see watch.ts). Generic heuristics run when these find nothing. */
export const WATCH = {
  /** Top bar of the logged-in site (counters are searched here first). */
  topBar: ["header", "nav", "#header", ".navbar", "[class*='header']", "[class*='navbar']"],
  /** Element (icon/link) that carries the unread-messages badge. */
  // VERIFIED (page captures, Nov 2026): the icons carry class "no-messages" while nothing is unread.
  messagesBadge: ["span.wk2-icon-messages-b.notification-icon", 'header a[href$="/inbox"]', 'nav a[href$="/inbox"]'],
  /** Element (icon/link) that carries the unread-notifications badge. */
  notificationsBadge: ["span.wk2-icon-bell-b.notification-icon", "header [class*='notification']", "nav [class*='notification']"],
  /** VERIFIED: the header's messages dropdown lists every conversation on every page (hidden until opened). */
  threadLinks: "ul.dropdown-menu.threads a.notification-link[href*='/messages/index/']",
  /** VERIFIED: the header's bell dropdown (Tu propuesta no fue aceptada · Ayer · En <project>). */
  bellItems: "ul.dropdown-menu.notifications li.notification",
  /** Links to one conversation on the inbox page (one per project: /inbox/<project-slug>). */
  conversationLink: ["TODO: verify — conversation rows on /inbox"],
  /** The row around a conversation link (its text gives the name + last message). */
  conversationItem: ["li", "[class*='conversation']", "[class*='thread']", "[class*='chat-item']", "[class*='message-item']", "article"],
  /** Inbox page the watcher keeps open (pinned, in the background) and refreshes. */
  inboxUrl: "https://www.workana.com/inbox",
  /** Refresh the background inbox tab this often (ms, jittered ±25%). */
  refreshMs: 4 * 60 * 1000,
  /** Counters are re-read this often inside every Workana tab (ms). */
  scanMs: 15000,
};

/**
 * Conversation page (/inbox/<project-slug>): read messages + reply from the dashboard (see inbox.ts).
 * Empty lists = generic heuristics. Fill these in when the page-structure capture shows the real classes.
 */
export const THREAD = {
  /** One element per message. */
  // VERIFIED (page captures, Nov 2026): section#container > ul > div > li.self | li.other (li.bid-proposal = a proposal)
  message: ["section#container li.self, section#container li.other"] as readonly string[],
  /** Inside a message: author name, message text, time. */
  author: ["[class*='author' i]", "[class*='sender' i]", "[class*='user-name' i]", "[class*='username' i]"] as readonly string[],
  text: ["article p.content", "[class*='message-text' i]", "[class*='message-body' i]"] as readonly string[],
  time: ["time", "[class*='time' i]", "[class*='date' i]"] as readonly string[],
  /** VERIFIED: the client's name in the panel on the right. */
  clientName: ["section.user-block a.user-name", ".messages-new-roaster li.user.active h4"] as readonly string[],
  /** VERIFIED: the conversation list on the left of the page - NEVER messages. */
  roster: ".messages-new-roaster, .messages-new-search",
  /** Reply box and its send button. */
  composer: ["textarea#MessageContent", "textarea[name='message[content]']"] as readonly string[],
  sendButton: ["button#SubmitMessage", "button.btn-send"] as readonly string[],
  /** Project title shown above the conversation. */
  title: [".messages-new-content .bid-title a", ".bid-title"] as readonly string[],
  /** Give up on one inbox job (read / send) after this long (ms). */
  jobTimeoutMs: 75000,
};

export const TIMINGS = {
  /** Random pause between filling fields (ms). */
  fieldDelay: [600, 1500] as [number, number],
  formWaitMs: 20000,
  /** How long the extension waits for a result (hub default is 15 min). */
  fillOnlyDeadlineMs: 14 * 60 * 1000,
  autoSubmitDeadlineMs: 3 * 60 * 1000,
  successWatchMs: 30000,
  /** Wait before closing the tab of a verified send. */
  closeTabDelayMs: 5000,
};
