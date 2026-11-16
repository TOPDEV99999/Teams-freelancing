# Workana Proposal Assistant — Production

Finds new Workana jobs, has ChatGPT write a proposal for each of your accounts, and fills in the bid form in the right browser profile. In the default mode **you** click Workana's Send button.

```
PRODUCTION/
├─ WorkanaAssistant/
│  ├─ WorkanaAssistant.exe   the app (dashboard + job fetcher + queue)
│  ├─ .env                   settings: port, shared secret, fetcher (PRIVATE)
│  └─ data/                  your jobs, prompts, accounts, history (PRIVATE)
├─ extensions/
│  ├─ ext-chatgpt/           Chrome extension for the ChatGPT browser profile
│  └─ ext-workana/           Chrome extension for each Workana browser profile
├─ MASTER-PROMPT.txt         ready-to-use master prompt
├─ APPLY-UPDATE.bat          installs a new version from update\ (backs up data first)
└─ README.md                 this file
```

> `.env` and `data/` hold your shared secret and all your data. Don't share or upload this folder.

---

## 1. First-time setup

### 1.1 Start the app
1. Double-click `WorkanaAssistant\WorkanaAssistant.exe` and leave its window open (closing it stops everything).
2. Open the dashboard at **http://127.0.0.1:8766**, in any normal browser.

Only one copy of the app can run at a time. Close any older WorkanaAssistant window first.

### 1.2 Install the extensions
In each browser, open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and choose the folder:

| Browser / profile | Folder to load |
|---|---|
| The profile where you're logged in to chatgpt.com | `extensions\ext-chatgpt` |
| Each Workana account's profile (ixBrowser Mexico1/2/3… or Chrome) | `extensions\ext-workana` |

Then click the extension icon and fill in its popup:
- **Hub URL:** `ws://127.0.0.1:8766/ws/ext`
- **Shared secret:** the `HUB_SHARED_SECRET` value in `WorkanaAssistant\.env`
- **Account ID** (Workana extension only): `me`, `friend_a`, `friend_b` or `friend_c`. Use a different one in each profile, matching the Workana account logged in there.
- **Mode** (Workana extension only): `fill_only` (recommended)
- **Workana display name:** leave empty

Click **Save**. The dot turns green ("connected") within about 10 seconds.

The Workana extension also watches that account's **messages and notifications**. To do that it keeps one pinned Workana inbox tab open in the background (popup → *Keep a Workana inbox tab open*). Leave that tab alone; it refreshes itself every few minutes.

> Chrome identifies an unpacked extension by its folder. If your profiles still have the extension loaded from an older folder, either keep using it (copy the files from `extensions\` over the old folder and click ↻), or remove it and load it from here. Loading from a new folder means filling in the popup again.

### 1.3 Dashboard settings (once)
1. **Prompts**
   - Paste `MASTER-PROMPT.txt` into **Master prompt**, then click **Save master & styles**.
   - On each account card, click **Clear**, then **Save**. The card now says "uses master prompt".
   - **Client information** in the prompt: `{job.client}` inserts the client's facts as lines (country, hourly/fixed, payment verified, rating, paid X of Y projects, member since, proposals already sent) and the client's **name**; `{job.client_json}` inserts the same facts as JSON; `{job.client_name}` is only the name (empty when unknown). `MASTER-PROMPT.txt` already contains `{job.client}`.
   - Open **Profile text** on each card and write that freelancer's real skills, experience and tools, then **Save**. ChatGPT may only use these facts, so an empty profile gives generic proposals.
2. **Accounts:** for each account, fill in:
   - **Categories / keywords** (e.g. `wordpress, elementor, landing page`); new jobs are pre-selected for every matching account;
   - **daily limit** and **minimum delay** between bids;
   - **Bid currency on Workana**: US$, R$ or MX$, the currency that Workana account bids in;
   - **Active**.
3. **Fetcher:** languages, minimum budget, hourly/fixed, skills and client filters, then **Save & apply**. Optionally connect Telegram for job alerts.
4. **Settings:**
   - global jitter (random gap between any two bids), ChatGPT pause (15–45 s between prompts), quiet hours;
   - **Automatic sending:** review window, which proposal, price rule, limits, minimum client trust, auto-pilot (see 2.4);
   - **Currencies:** exchange rates for R$ and MX$ (**Get today's rates**, or type them in);
   - **Translation:** your language;
   - **Workana messages:** forward to Telegram, mark bids as "replied" automatically.
5. **Data:** optionally switch on **Automatic clean-up** so logs and old jobs don't pile up.

---

## 2. Daily use

**Start-up order:**
1. WorkanaAssistant.exe
2. The ChatGPT browser, with a chatgpt.com tab open and logged in
3. The Workana profiles

Wait until every chip at the top of the dashboard is green.

### One job
1. **Jobs:** click a job. The matching accounts are already selected under **Accounts bidding**. Add or remove accounts, or click **Select all**.
2. **Generate** (key **G**). ChatGPT writes one account after another, pausing 15–45 s between them. The header shows who it's writing for.
3. Open each account's tab:
   - pick a draft (keys **1–4**);
   - edit the text, price and days;
   - click **Send as …** (key **S**) and confirm.
4. That account's profile opens the job and fills in the form. **Check it and click Workana's Send.**
5. The bid turns **sent** by itself, and the tab closes about 5 seconds later.

### Many jobs at once
1. Tick the jobs' checkboxes. A bar slides up at the bottom.
2. Pick the accounts (or **All**).
3. Optionally turn on **Auto-send** and pick a style.
4. Click **Generate N**.

Everything then runs by itself, spaced out by the per-account delay, daily limits, jitter and quiet hours.

### 2.1 Cancel: always at the top right
The **Cancel** button (top right, on every page) opens **Running now**. It lists:
- what ChatGPT is writing;
- the queued generations;
- every proposal waiting or being sent, with its countdown;
- the jobs that have auto-send on.

Each line has its own **Cancel** or **Stop**. **Cancel everything** stops all of it at once and switches auto-send off. Proposals already sent on Workana stay sent.

In a job, **Stop** now also stops the account ChatGPT is writing for right now, not only the ones waiting.

### 2.1.1 ⚡ Send urgently (jump the queue)
Generation and sending normally run one after another. When one project can't wait, open it and click **⚡ Send urgently**.
1. **Everything else pauses:** other generations and other queued proposals wait.
2. **This job goes first:**
   - accounts that already have drafts are queued immediately (auto-send style and price rule, no review window);
   - accounts without drafts are generated first, with no pause between prompts;
   - its proposals skip the random gap, the minimum delay between bids and quiet hours.
3. **When its proposals are sent (or failed), the previous order continues by itself.** An orange banner at the top shows urgent mode; **End urgent mode** stops it at any time, and so does **Cancel everything**.

Still applied: daily limits, and paused or offline accounts are skipped. A prompt ChatGPT is already writing, or a form already being filled, finishes first. Urgent mode ends by itself after 20 minutes at the latest.

### 2.2 Client trust (colour in the job list)
The **Client** column shows the client's payment history, e.g. **7/8** = 7 of 8 published projects paid:

| Colour | Meaning |
|---|---|
| 🟢 green | very reliable / reliable |
| 🟡 amber | pays only some projects |
| 🔵 blue | new client, no history yet |
| 🔴 red | risky: publishes projects but never or rarely pays |
| ⚪ grey | no data (the job page wasn't checked) |

Hover for the details. Use the **Client trust** filter and **sort by trust** above the list.

Under the trust badge is the client's **last login** on Workana, updated live:

| Indicator | Meaning |
|---|---|
| 🟢 pulsing | logged in within the last 15 minutes (probably around now) |
| 🟢 | logged in within the last 2 hours |
| 🟡 | logged in within the last 24 hours |
| ⚪ | logged in longer ago |
| — | not checked yet |

Tick **recently active first** to sort by it.

Workana doesn't show a live online/offline status to anyone who isn't logged in, so this is the closest safe signal. The app reads it from the client's **public** profile by itself, without any login and never through your accounts' browsers.

To keep the risk low, it only checks open jobs from the last 48 hours plus the job you have open. It makes one request every 8–15 seconds, and pauses for 30 minutes if Workana pushes back. Change or switch it off in **Settings → Client last seen**.

### 2.3 Inbox: read and answer client messages from the dashboard
The **Inbox** page has two tabs.

**Conversations** shows only the projects where a **client has written** to one of your accounts. Conversations that contain only your own proposal are hidden (the count is shown under the list). Not-yet-read conversations are checked quietly in the background (one per account every ~90 seconds) and appear as soon as a client message is confirmed.
- Click a conversation to see the whole thread: the client's messages on the left, yours on the right.
- Type in the box at the bottom and click **Send as …** (or press Ctrl + Enter). The reply is typed and sent in **that account's own browser profile**: a background tab opens the conversation on Workana, sends the message, checks that it appeared, and closes.
- **↻ Refresh** reads the conversation again. **文A** translates it for reading only.
- New conversations and messages are read by themselves when Workana's inbox shows a change. The full text of a new client message appears in the bell, the toast and the desktop pop-up.

**Client messages** lists only messages written by clients: not your own replies, and not Workana's system notifications. Use **Open conversation & reply** to jump to the thread. (A Workana notice that a proposal was not accepted isn't shown, but it sets that bid's result to *rejected* in Stats.)

The profile's browser must be running (its chip at the top is green). Attachments can't be sent from the dashboard; use **Workana ↗** for that.

**Check that it works:**
1. Inbox → Client messages → **Send test notice**: you should see, hear and get a pop-up.
2. Open a conversation of a bid you sent and click **↻ Refresh**. The messages should appear within about 20 seconds.

> First version of this feature: the extension recognises Workana's conversation page by its layout. If a thread stays empty, or a reply says "send button not found", the extension saves the page's structure (layout only, long texts hidden) to `WorkanaAssistant\data\snapshots\`. Send that folder so the recognition can be matched to Workana's exact page.

### 2.4 Automatic sending
**Settings → Automatic sending** applies to every proposal queued by **Auto-send**:

| Setting | What it does |
|---|---|
| **Review window** (default 120 s) | Auto-queued proposals wait this long. Cancel them in that time, or press **Send now**. |
| **Which proposal** | The job's style, rotate styles, or random. |
| **Price** | ChatGPT's price, the budget minimum or middle, or a % of the maximum. Always kept inside the client's budget. |
| **Limits** | Price floor and ceiling, max auto-sends per day, minimum client trust, skip crowded jobs. |
| **Auto-pilot** (off by default) | New jobs matching an account's keywords are generated and auto-sent without a click. |

When a rule blocks an auto-send, the drafts stay ready and the job says why.

### 2.4.1 Currencies (one per account)
Each account bids in its own currency (Accounts page → **Bid currency on Workana**).
- Every price decision happens in **US dollars**: ChatGPT's suggestion, the client's budget, the auto-send price rule and its minimum/maximum.
- Only the amount typed into Workana's form is converted, using the rates in **Settings → Currencies**.
- In a job, the **Price** field is in that account's currency and shows "≈ US$ …" plus the client's budget converted.
- Bids show their currency everywhere (e.g. R$ 1.080).

Check the rates now and then (**Get today's rates**). A wrong rate means a wrong bid amount.

### 2.5 Translation (for reading only)
- **文A** at the top of a job (key **T**) translates the job.
- **Translate this** / **Translate all** above the proposal text translate the proposals.

A sidebar opens on the right, where you can choose the language. Nothing you send to Workana is translated.

### 2.6 Deleting history
- **Data** page:
  - storage overview;
  - delete old jobs (by age and status);
  - delete old generated proposals;
  - delete logs and Inbox notices;
  - **ChatGPT history**: temporary chats, auto-delete, or **Delete assistant chats now**;
  - **Automatic clean-up** (daily);
  - **Download backup**.
- **One job:** trash icon in the job panel.
- **Many jobs:** tick them, then the trash icon in the bottom bar.
- **Logs:** Logs page → **Delete logs**.

Jobs that are being generated, queued or sent are never deleted.

### 2.7 Accounts: change ID or delete
On the **Accounts** page:
- **Change ID** renames an account everywhere. Afterwards type the new ID in that profile's Workana extension popup and click **Save**.
- The **trash icon** deletes an account. If it has bids, tick *Also delete this history*, or untick **Active** instead to keep its Stats.

### Shortcuts
| Key | Action |
|---|---|
| J / K | next / previous job |
| G | generate for the selected accounts |
| 1–4 | pick a draft |
| S | send (Enter confirms) |
| X | skip job |
| T | translate the job |
| Esc | close the job panel |

---

## 3. When something goes wrong

| You see | Do this |
|---|---|
| Bid **failed**, but it IS on Workana | **✓ Mark as sent** |
| Bid stuck on **sending**, or you want to stop it | **■ Cancel sending** (the extension stops clicking) |
| Bid **failed** and was not posted | **Retry**, or **Cancel & unlock** |
| Yellow banner "account paused" (captcha, logged out, no credits) | Fix it in that profile, then **Resume** |
| Generation takes too long | **Stop** in the job, or **Cancel** (top right) |
| Something must stop **now** | **Cancel** (top right) → **Cancel everything** |
| Not sure the fetcher is still running | look at the **Jobs · 20s ago** chip at the top: green = checked recently. A hung check is replaced automatically by a fresh one (no restart needed). |
| No sound / pop-up for new jobs | bottom left: **Notify new jobs** on. If it shows "Click to allow desktop notifications", click it; if it says *blocked*, allow notifications for this page in the address bar. Then **Send a test notification**. The dashboard tab must stay open (use Telegram on the Fetcher page for alerts without it). Windows "Focus assist / Do not disturb" also hides pop-ups. |
| Bulk **Generate** | with no account picked in the bottom bar it uses each job's own matching accounts; pick accounts to override |
| Bid failed with `form_not_found` while you have unread messages | Fixed in extension 1.3.2 (the chat preview that pops up from the bottom was mistaken for the proposal form). Reload the Workana extension in every profile. If it still happens, send the newest files in `data\snapshots\` |
| Inbox conversation stays empty / reply not sent | **↻ Refresh**; if it stays empty, send the newest files in `data\snapshots\` (page layout only) |
| Inbox stays empty / chip says "waiting for a Workana tab" | Workana popup → tick *Keep a Workana inbox tab open* → **Check now** |
| "unknown account id" in a Workana popup | the ID was changed or deleted on the Accounts page: type the current ID and **Save** |
| A chip is grey | Start that profile; if needed click **Reconnect** in its popup |
| A chip says **update** | That profile still has an old extension: `chrome://extensions` → ↻ |
| Banner "A newer version is running" | Click **Reload** |
| Anything else | The **Logs** page shows every step and error |

The extensions never solve or bypass captchas or "unusual activity" checks. They only report them and pause that account.

---

## 4. Good to know
- **Modes.** `fill_only` fills the form and waits for your click. Switch a profile to `auto_submit` only after fill_only has worked reliably for a while.
- **One bid per account per job.** A job can have bids from several accounts, but each account bids only once.
- **Special fonts.** The master prompt puts special Unicode fonts in the "friendly" proposal only. Check how the first few look on Workana.
- **Backup.** Data → **Download backup** (works while the app runs), or close the app and copy `WorkanaAssistant\data\`. Copying it back restores everything.
- **Updating.**
  1. Close the app.
  2. Run `APPLY-UPDATE.bat` if an update folder is present. Otherwise replace `WorkanaAssistant.exe` and copy the new extension files over `extensions\`.
  3. Click ↻ on both extensions in every profile.
  4. Reload the dashboard tab (Ctrl + F5).
- **Port.** The app runs on port 8766 (`HUB_PORT` in `.env`) and is only reachable from this computer.
