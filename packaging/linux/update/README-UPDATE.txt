Workana Assistant - Linux update (2026-11-16)

New in this version
  - Currency per account (US$, R$, MX$): Accounts page -> "Bid currency on Workana"; rates in Settings -> Currencies.
    Prices are decided in USD (budget, auto-send rules) and converted only for the Workana form.
  - Dashboard alerts show ONLY client messages (no own replies, no Workana system notifications).
  - Inbox reads Workana's real conversation markup (fixes the conversation LIST showing up as messages; wrong entries are removed automatically).
  - Notifications show Workana's real text; "Tu propuesta no fue aceptada" sets that bid to "rejected".
  - "No Connects left" (Improve your plan) is reported clearly and pauses that account.
  - Inbox: every account's conversations on the dashboard. Read the full thread and reply
    ("Send as ...") - the reply is typed and sent in that account's own browser profile.
  - The full text of new client messages appears in the bell, toast and desktop pop-up.
  - Bids now open the proposal form directly (/messages/bid/<job>), job page only as fallback.
  - Fixed: bids failing with "form_not_found" when the account had unread messages
    (Workana's chat preview was mistaken for the proposal form).
  - Prompt variables {job.client}, {job.client_json}, {job.client_name}.
  - Workana extension 1.3.2: reload it in EVERY Workana browser profile
    (copy extensions/ext-workana over the folder the profile loads, then chrome://extensions -> reload).
    The ChatGPT extension is unchanged (1.2.0).

How to install
  1. Copy workana-assistant-update.tar.gz into the folder that CONTAINS workana-assistant/
     (usually your home folder) and unpack it there:
        tar xzf workana-assistant-update.tar.gz
  2. Run:
        bash workana-assistant/update/apply-update.sh
     It stops the background service (if used), backs up data/, .env and the old code to
     workana-assistant/backups/<date>/, installs the new files, updates dependencies and starts the
     service again. If the app runs in a terminal, stop it there with Ctrl+C first.
  3. Start the app (./start.sh) if you don't use the service, reload the dashboard (Ctrl+F5),
     and reload the Workana extension in every profile.

Kept untouched: WorkanaAssistant/.env and WorkanaAssistant/data/.
