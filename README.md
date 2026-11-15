# Workana Proposal Assistant

A local, single-computer system that lets 4 freelancers (4 Workana accounts) answer new Workana jobs quickly:

```
Job fetcher ──▶ Hub (FastAPI + SQLite, 127.0.0.1:8766) ──▶ ChatGPT extension (Chrome profile 0) → 4 draft styles
                     ▲          │
   Dashboard (React) ┘          └──▶ Workana extension ×4 (Chrome profiles 1–4) → fills / submits the proposal
```

**Human-in-the-loop is mandatory.** Nothing reaches Workana unless someone clicks **Send** in the dashboard (and,
in the default `fill_only` mode, also clicks Workana's own send button).

---

## 1. Install

Requirements: Python 3.11+, Node 18+, Google Chrome 116+.

```bat
cd workana-assistant
py -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt

npm install                 :: build tools for the extensions
npm run build               :: builds ext-chatgpt/dist, ext-workana/dist and dashboard/dist
```

## 2. Run the hub

```bat
run.bat                     :: or: .venv\Scripts\python -m hub
```

On first run a `.env` is created from `.env.example` with a random `HUB_SHARED_SECRET`; it's printed in the
console. Open **http://localhost:8766**. You should see the dashboard with 5 grey status lights (ChatGPT + 4 accounts).

> **Port already in use?** Set `HUB_PORT=8767` (or any free port) in `.env`, restart, and put
> `ws://127.0.0.1:8767/ws/ext` in the **Hub URL** field of every extension popup.

### `.env` settings

| key | default | meaning |
|---|---|---|
| `HUB_PORT` | 8766 | hub port (always bound to 127.0.0.1) |
| `HUB_SHARED_SECRET` | generated | extensions must send it on register |
| `FETCHER` | `workana` | `workana` = built-in Workana fetcher, `mine` = `hub/fetcher/my_fetcher.py`, `demo` = fake jobs, `none` |
| `FETCH_INTERVAL_SECONDS` | 60 | initial value; editable on the Settings page |
| `GENERATION_PROVIDER` | `chatgpt_web` | or `openai_api` (needs `OPENAI_API_KEY`, `OPENAI_MODEL`) |
| `GENERATION_TIMEOUT_SECONDS` | 300 | per generation |
| `SUBMIT_TIMEOUT_SECONDS` | 900 | how long the hub waits for a Workana result |

## 3. Jobs: the built-in Workana fetcher

`FETCHER=workana` (default) polls the same JSON endpoint Workana's own job list uses (`/jobs?language=xx`) through
`curl_cffi` (real Chrome TLS fingerprint, needed for Cloudflare) — the method of the old standalone Telegram bot.
Everything is controlled from the dashboard's **Fetcher** page, applied live:

- Start / Stop / Check now, health (Cloudflare challenges, empty cycles, session recreations…), live log.
- Filters: languages (es/pt/en), fixed and/or hourly, min budget, min hourly rate, skill slugs (≥1 must match),
  client member-since, paid ratio, skip projects that no longer take bids (`Waiting for escrow`…), featured posts.
- **Import from old bot** — paste the old bot's `.env` to copy filters, skills, interval and Telegram.
- Optional Telegram alert per new job.

The first check of each language only records what's listed (`data/workana_seen.json`); after that, each newly
posted job that passes the filters is added and auto-assigned. The session self-heals (recreated after repeated
challenges / failures / empty cycles / 45 min) and failed cycles back off exponentially.

**Own code instead:** set `FETCHER=mine` and fill `_fetch_sync()` in `hub/fetcher/my_fetcher.py` (or the copy next
to the exe). While it's still the empty template the built-in fetcher is used. Any script can also push jobs with
`POST /api/jobs` (JSON list of `JobIn`). `FETCHER=demo` generates fake jobs for testing.

### Prompts

The **Prompts** page holds one prompt per account plus the master prompt (used by accounts with an empty prompt),
the shared proposal styles and each account's profile text. **Preview** renders the exact text sent to ChatGPT.

## 4. Chrome profiles & extensions

Create **5 Chrome profiles** (Chrome menu → profile icon → *Add*):

| profile | logged in to | extension |
|---|---|---|
| Profile 0 | chatgpt.com (your ChatGPT account) | `ext-chatgpt/dist` |
| Profile 1–4 | one Workana account each | `ext-workana/dist` |

In each profile: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the `dist` folder.
Then click the extension icon (pin it) and fill the popup:

* **ChatGPT profile:** shared secret → *Save*. Status turns **connected**.
* **Each Workana profile:** **Account ID** (exactly the id on the dashboard's Accounts page: `me`, `friend_a`,
  `friend_b`, `friend_c`), optionally the Workana display name (enables the wrong-account check), shared secret →
  *Save*. Leave **Mode = fill_only** until you've verified the selectors (section 6).

Keep the ChatGPT profile window open (the tab may be in the background). After rebuilding an extension
(`npm run build:ext`) click the ⟳ reload icon on `chrome://extensions` in each profile.

## 5. Daily use

1. **Accounts page** — for each account fill *Profile text* (the ONLY facts the AI may use: skills, years,
   projects, portfolio links, languages), *Categories/keywords* (used for auto-assignment), daily limit, minimum
   delay, optional min budget/default rate, *Auto-generate*.
2. New jobs appear live on the **Jobs** page, auto-assigned to the best-matching account (or unassigned if none
   scores above the threshold). Turn on *Notify new jobs* (bottom-left) for sound + desktop notifications.
3. Open a job → **Generate** (`G`) → 4 draft cards → pick one (`1`–`4`), edit text/price/days → **Send** (`S`) →
   confirm (`Enter`). `X` skips, `J`/`K` move through the list, `Esc` closes the panel.
4. The hub queues the submission, applies the per-account delay, the daily limit and 20–90 s global jitter (countdown
   shown), then sends it **only** to that account's Chrome profile. The extension opens the job, fills the form and
   — in `fill_only` — waits for you to click Workana's send button. Success is verified on the page, then the
   dashboard shows `sent` or a specific error.
5. **Stats** — mark outcomes (replied / interview / hired / rejected) to see which style and account perform best.

### Several accounts on one job

In the job panel, **Accounts bidding** selects which accounts send a proposal (**Select all** for all four). Each account
gets its own prompt and its own drafts: **Generate** queues them and ChatGPT writes them one after another (the next
account starts as soon as the previous reply is in). Every account has a tab with its drafts, its Send button and its
submission status. Each account can send only once per job.

New jobs come with every matching account (keyword score above the threshold) already selected, best match first.
**Stop** cancels the job's generations: the accounts still waiting and the one ChatGPT is writing (the extension presses
ChatGPT's own Stop button and the reply is discarded).

### Cancel — always available

The **Cancel** button at the top right of every page opens *Running now*: the prompt ChatGPT is writing, the queued
generations, every queued / sending proposal (with its auto-send review countdown) and the jobs with auto-send on. Each
line has its own **Cancel / Stop**; **Cancel everything** stops ChatGPT, removes every queued proposal, stops the ones
being filled in and switches auto-send off. Proposals already sent on Workana stay sent.

### ChatGPT pacing

Between two prompts the hub waits a random 15–45 s (Settings → *ChatGPT pause*), so long batches don't hit ChatGPT usage
limits or "unusual activity" checks. The header shows who ChatGPT is writing for, or the countdown to the next prompt.
The ChatGPT extension uses *temporary chats*, so your ChatGPT history doesn't fill up. If a chat is saved anyway, it is
deleted right after the reply was read; **Data → ChatGPT history** has both switches and *Delete assistant chats now*
(removes only chats the extension created). After a verified send the Workana tab closes itself after ~5 s; failed tabs
stay open.

### Updates

After installing a new version, reload the dashboard tab (a banner offers it) and click ↻ on both extensions in every
profile. An extension chip marked **update** in the header is still running an old version.

### Pre-assigning many jobs (batch)

Tick jobs in the list → choose accounts in the blue bar (**all** for every account) → optionally **auto-send** + a style →
**Generate N proposals**. Generation runs job by job, account by account. With auto-send each proposal is queued as soon
as its drafts are ready (chosen style, ChatGPT's suggested price/days); the submission queue then spaces everything out
with the per-account delay, daily limits, global jitter and quiet hours. In `fill_only` mode you still click Workana's
send button for each one; in `auto_submit` mode the extension clicks it.

### Automatic sending (Settings → Automatic sending)

Applies to proposals queued by **Auto-send** (job switch, bulk bar) and by the **auto-pilot**:

| rule | meaning |
|---|---|
| Review window | auto-queued proposals wait N s (default 120) before dispatch: cancel, or **Send now** to skip the wait |
| Which proposal | the job's style · rotate styles per account · random |
| Price | ChatGPT's suggestion · budget minimum · budget middle · N % of the maximum; always kept inside the client's range |
| Never below / skip if above | USD floor; skip auto-send when the price would exceed a maximum |
| Max per day | cap on auto-sent proposals across all accounts |
| Minimum client trust | skip clients below a trust tier (see below) |
| Skip if more bids than | skip crowded jobs |
| **Auto-pilot** | new jobs that match an account's keywords are generated and auto-sent without a click (pick the accounts) |

A skipped auto-send leaves the drafts ready and says why on the job. In `fill_only` mode you still click Workana's send
button for every proposal.

### Client trust

Each job shows a colour-coded trust badge from the client's public history on the job page (projects published vs paid,
member since): **Very reliable** (green, e.g. paid 7/8) · **Reliable** · **Pays sometimes** (amber) · **New client** (blue,
no history yet) · **Risky** (red, publishes but never/rarely pays) · grey = not checked. Hover for the reasons. The Jobs page
can filter by minimum trust and sort by trust; auto-send can require a minimum.

**Client last seen.** Under the trust badge: the client's last login, read from the client's *public* profile
(`/e/<id>`, `lastLogin` - timestamps are UTC-3) by the hub without any login, never via a logged-in browser. Workana
doesn't publish a live online state to logged-out visitors, so this is the closest safe signal (green pulse = within
15 min, green = 2 h, amber = 24 h, grey = older). `services/presence.py` refreshes only open jobs (new / drafted /
error) from the last 48 h plus jobs open in the dashboard, one request every 8-15 s, each job at most every 10 min, and
pauses 30 min on HTTP 403/429/503 or a Cloudflare challenge. Settings → *Client last seen* (on/off, interval, age). The
job list endpoint also provides `hasVerifiedPaymentMethod` and the client `rating`, now part of the trust reasons.

### Workana messages & notifications (Inbox)

Each Workana profile's extension reads what Workana already shows: the unread counters in the top bar and, on the inbox
page, the conversation list (who wrote, last line, unread). To work without you keeping Workana open, it keeps one
**pinned inbox tab** in the background and refreshes it every ~4 min (popup → *Keep a Workana inbox tab open*; the popup's
**Check now** shows what it detects). New client messages and new notifications appear on the **Inbox** page, with a toast,
a chime and a desktop notification (*Notify Workana messages*, bottom-left), optionally on Telegram (Settings). A client
message on a job you bid on marks that bid **replied** in Stats. **Send test notice** checks the dashboard side.
Selectors for Workana's top bar / inbox live in `WATCH` in `ext-workana/src/config.ts`; generic fall-backs are used when
they don't match.

### Translation (view only)

The 文A button on a job (key `T`) and *Translate this / all* on the proposals open a sidebar on the right with the text in
your language. Chrome's on-device translator (Chrome 138+) is used when available, otherwise Google Translate via the
hub. Unicode "font" letters are normalised first. Nothing sent to Workana is translated.

### Data & history (Data page)

Storage figures; delete jobs (by age + status, optionally keeping jobs with a sent bid; busy jobs are never deleted),
delete old generated proposals, delete logs, delete Inbox notices, compact the database, **download a backup**, ChatGPT
history switches, and an **automatic daily clean-up** (logs / jobs / notices older than N days). Single jobs can be
deleted from the job panel (trash icon) or in bulk from the selection bar; logs also from the Logs page.

### Accounts: change ID, delete

**Change ID** renames an account everywhere (jobs, drafts, bids, logs, messages); afterwards set the new Account ID in that
profile's extension popup. **Delete** (trash icon) removes an account; if it has bids you can delete its history with it
(or deactivate it instead to keep Stats).

### Errors & pausing

| code | meaning | account paused? |
|---|---|---|
| `captcha` | verification challenge on the page | **yes** |
| `not_logged_in` | Workana session missing | **yes** |
| `no_credits` | out of bids/connects | **yes** |
| `wrong_account` | profile logged in as someone else | **yes** |
| `job_closed`, `already_bid` | job no longer biddable | no |
| `form_not_found` | a selector didn't match — fix `config.ts` | no |
| `timeout` | no verified result in time (tab closed, unverifiable page…) | no |

A paused account shows a yellow banner; fix the problem in that Chrome profile, then click **Resume**. The
extensions never try to solve or bypass captchas, limits or "unusual activity" checks.

A failed submission keeps that account locked on the job. In its tab use **Retry**, **Cancel & unlock** (only after
checking on Workana that nothing was posted) or **✓ Mark as sent** (the proposal IS on Workana but couldn't be verified).
While a submission is *sending*, **■ Cancel sending** stops it: the extension is told to stop and clicks nothing more.

## 6. Finding the Workana selectors (do this before `auto_submit`)

The Workana selectors in `ext-workana/src/config.ts` were written **without access to Workana's live pages** — they
are best guesses marked `TODO`. The extension was tested end-to-end against a mock page built on those guesses, so the
flow works; only the selectors need to match the real site.

For each entry, in a Workana profile:

1. Open a real job page, right-click the element → **Inspect**.
2. In the Elements panel pick a stable attribute: `id`, `name`, `data-*`, a stable class, or an `href` pattern.
   Avoid auto-generated classes like `css-1x2y3z`.
3. Test it in the DevTools **Console**: `document.querySelector('textarea#BidContent')` → must return the element
   (and `document.querySelectorAll(...)` should return exactly one).
4. Put it **first** in the matching list in `config.ts`, delete the `TODO` line, `npm run build:ext`, reload the
   extension.

| key | where to find it |
|---|---|
| `loggedIn` | anything only shown when logged in (avatar, user menu, logout link) |
| `accountName` | element in the header showing your name (wrong-account check) |
| `bidButton` | the "Enviar propuesta / Send proposal" button on a job page |
| `form`, `textField`, `amountField`, `daysField`, `submitButton` | the proposal form |
| `success` | the confirmation message after sending (send one proposal by hand and inspect it) |
| `formError` | validation message (submit an empty form) |
| `TEXT.*` | exact wording for already-bid / closed / no-credits / success messages, in your language |

Run a few jobs in `fill_only` and watch the Logs page. Switch to `auto_submit` only when every step works.

ChatGPT selectors live in `ext-chatgpt/src/config.ts`. If ChatGPT changes its UI and generation starts failing with
`composer_not_found` or timeouts, re-check `composer`, `sendButton`, `stopButton` and `assistantMessage` the same way.

## 7. Testing

```bat
.venv\Scripts\python -m pytest hub\tests -q          :: 45 tests: prompt/JSON parsing, assignment, queue rules, WebSocket flow
npm run typecheck:ext                                 :: extensions
npm --prefix dashboard run typecheck                  :: dashboard
```

**Simulated extensions** (no Chrome needed) — with the hub running:

```bat
.venv\Scripts\python tools\sim_extensions.py                    :: fake ChatGPT + 4 Workana profiles, all report "sent"
.venv\Scripts\python tools\sim_extensions.py --fail captcha     :: Workana sims report captcha → account auto-pauses
```

Then add the demo fetcher (`FETCHER=demo`) and click through Generate → Send in the dashboard. All 5 lights go green.

## 8. Safety rules (enforced in code)

1. No submission without a dashboard action: a Send click (`POST /api/jobs/{id}/send`), Auto-send you switched on
   (job / batch), or the auto-pilot if you enabled it. Auto-queued proposals have a review window. Default `fill_only`
   mode also needs your click on Workana.
2. One proposal per account per job: API checks + `UNIQUE(submissions.job_id, account_id)`; only accounts selected for
   the job can send; results from a different account are ignored.
3. Per-account daily limit and minimum delay; random global jitter (Settings) between submissions; quiet hours.
4. Captchas, limits and "unusual activity" are only detected and reported, never bypassed; the account pauses.
5. Prompts tell the model to use only that account's `profile_text`.
6. Hub binds to `127.0.0.1`; extensions must present `HUB_SHARED_SECRET`; requests whose `Host` isn't localhost are
   rejected (blocks DNS rebinding); dashboard WebSocket checks `Origin`.

## 9. WebSocket protocol (`/ws/ext`)

| direction | type | payload |
|---|---|---|
| ext → hub | `register` | `role` (`chatgpt`/`workana`), `account` (workana), `token`, `version` |
| hub → ext | `registered` / `register_error` | `error` |
| ext → hub | `ping` (every 20 s) → hub `pong` | — |
| hub → chatgpt | `generate` | `request_id`, `job_id`, `account_id`, `prompt`, `temporary_chat`, `delete_after` |
| chatgpt → hub | `generated` / `generate_error` | `request_id`, `raw_text` / `error` |
| hub → chatgpt | `cancel_generate` | `request_id` (press ChatGPT's Stop) |
| hub → chatgpt | `delete_chats` → chatgpt `command_result` | `request_id` → `deleted`, `failed`, `remaining` / `error` |
| hub → workana | `submit` | `submission_id`, `job_id`, `url`, `text`, `price`, `days` |
| workana → hub | `progress` | `submission_id`, `stage` |
| workana → hub | `result` | `submission_id`, `status` (`sent`/`failed`), `error?`, `detail?` |
| hub → workana | `cancel` | `submission_id` |
| workana → hub | `counters` | `messages`, `notifications` (unread, as shown by Workana), `source` |
| workana → hub | `notice` | `items`: [{`kind` message/notification, `key`, `title`, `body`, `url`}] |
| ext → hub | `log` | `level`, `message` (shown on Logs page) |

Dashboard (`/ws/ui`) receives `job_new`, `job_updated`, `drafts_ready`, `submission_updated`, `submission_deleted`,
`account_updated`, `account_deleted`, `ext_status`, `log`, `logs_cleared`, `jobs_deleted`, `notice_new`, `notices_read`,
`notices_cleared`, `counters`, `reload`. A second `workana` registration for an already-connected
account is rejected; extensions silent for 60 s are dropped.

## 10. Project layout

```
hub/            FastAPI app — api/, ws/, services/ (assignment, generation, submission_queue, prompt, ingest, trust,
                notices, cleanup), fetcher/, tests/
dashboard/      React + Vite + TS + Tailwind (built into dashboard/dist, served by the hub)
ext-common/     shared extension code (hub WebSocket client, DOM helpers)
ext-chatgpt/    manifest.json, src/{background,content,config,popup}.ts  → dist/
ext-workana/    manifest.json, src/{background,content,config,popup,watch}.ts  → dist/
tools/          sim_extensions.py (fake extensions), build-extensions.mjs
```
