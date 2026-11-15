# Workana Proposal Assistant — Linux

The same app as the Windows version (dashboard, job fetcher, ChatGPT and Workana queues, Inbox, client trust and last seen), packaged for Linux.

```
PRODUCTION-LINUX/
├─ WorkanaAssistant/
│  ├─ install.sh            one-time setup (Python environment + dependencies + .env)
│  ├─ start.sh              start the app in this terminal
│  ├─ install-service.sh    optional: run in the background, start automatically, restart on failure
│  ├─ build-binary.sh       optional: build a single-file program (WorkanaAssistant-linux)
│  ├─ hub/  dashboard/      the app
│  ├─ requirements.txt  .env.example  entry.py
│  ├─ .env                  created by install.sh (PRIVATE: shared secret)
│  └─ data/                 created on first start (PRIVATE: jobs, accounts, history)
├─ extensions/              Chrome extensions (same files as on Windows), version 1.2.0
├─ workana-assistant-linux.tar.gz   everything above in one file (keeps Linux line endings and permissions)
├─ MASTER-PROMPT.txt
└─ README.md
```

**Requirements:**
- any 64-bit Linux (x86-64 or ARM64): Ubuntu 22.04+, Debian 12+, Fedora, Arch…;
- Python 3.10 or newer, with `venv`;
- internet access for the one-time install.

---

## 1. Copy it to the Linux machine
Copying the single file is easiest, because it keeps the scripts executable:

```bash
scp workana-assistant-linux.tar.gz user@linux-pc:~
ssh user@linux-pc
tar xzf workana-assistant-linux.tar.gz          # creates ~/workana-assistant/
cd ~/workana-assistant/WorkanaAssistant
```

If you copied the folder itself (USB stick, file share), run `chmod +x *.sh` inside `WorkanaAssistant/` once.

## 2. Install (once)
```bash
sudo apt install python3 python3-venv     # Debian/Ubuntu, if Python isn't there yet
./install.sh
```

It creates a private Python environment in `.venv` and a `.env` with a new shared secret, then prints that secret.

## 3. Start
```bash
./start.sh
```

Open **http://localhost:8766** in a browser. Ctrl + C stops the app.

**To run it in the background and start automatically:**
```bash
./install-service.sh                       # systemd user service, restarts on failure
sudo loginctl enable-linger $USER          # optional: also when you're not logged in / after reboot
journalctl --user -u workana-assistant -f  # live log
./install-service.sh --remove              # uninstall the service
```

## 4. Extensions and browsers
The extensions run in the Chrome / Chromium / ixBrowser profiles where ChatGPT and your Workana accounts are logged in. On those, load `extensions/ext-chatgpt` and `extensions/ext-workana` with `chrome://extensions` → Developer mode → **Load unpacked**. Then fill in each popup:
- **Hub URL:** `ws://127.0.0.1:8766/ws/ext`
- **Shared secret:** `HUB_SHARED_SECRET` from `WorkanaAssistant/.env`
- **Account ID**

The app only listens on `127.0.0.1` (this computer), on purpose. It is never reachable from the network.

**Browsers on the same Linux desktop:** nothing else to do.

**App on a Linux server, browsers on your Windows PC:** keep an SSH tunnel open on the PC.
```bash
ssh -N -L 8766:127.0.0.1:8766 user@linux-server
```
While it runs, `http://localhost:8766` and the extensions on the PC reach the server exactly as if the app were local. No popup changes needed.

## 5. Moving your Windows data (optional)
Bring your jobs, accounts, prompts and history over:
1. On Windows: Dashboard → **Data** → **Download backup**.
2. Copy that file to the Linux machine as `WorkanaAssistant/data/hub.db`, with the app stopped there.
3. To keep the extensions' current secret, copy the `HUB_SHARED_SECRET=` line from Windows `PRODUCTION\WorkanaAssistant\.env` into the Linux `.env`.

**Run only one copy at a time** (Windows or Linux). Two copies would send bids independently.

## 6. Optional: single-file program
```bash
./build-binary.sh
```

This builds `WorkanaAssistant-linux`, a single program like the Windows `.exe`. It must be built on Linux (it can't be made from Windows). Afterwards `start.sh` and `install-service.sh` use it automatically, with the same `.env` and `data/`. It runs on Linux systems at least as new as the one that built it.

## 7. Daily use, settings, troubleshooting
Everything inside the dashboard is identical to Windows. See the Windows `PRODUCTION\README.md` (sections 1.3–4), or the project README.

Linux specifics:

| Problem | Fix |
|---|---|
| `python3: command not found` / `venv` missing | `sudo apt install python3 python3-venv` |
| Python older than 3.10 | install a newer one, then `PYTHON=python3.12 ./install.sh` |
| "port already in use" | another copy is running (`./install-service.sh --remove`, or stop the other terminal), or change `HUB_PORT` in `.env` |
| Extensions grey on the Windows PC | the SSH tunnel isn't running (section 4) |
| Updating | see section 8 |

## 8. Updating
An update comes as `workana-assistant-update.tar.gz` (the same files are in the `update/` folder).

```bash
tar xzf workana-assistant-update.tar.gz              # in the folder that contains workana-assistant/ (e.g. ~)
bash workana-assistant/update/apply-update.sh
```

The script:
- stops the background service, if you use it (if the app runs in a terminal, press Ctrl + C there first);
- backs up `data/`, `.env` and the old code to `workana-assistant/backups/<date>/`;
- installs the new files, updates the dependencies and starts the service again.

`.env` and `data/` are never overwritten. Afterwards reload the dashboard (Ctrl + F5), and the extensions if `update/README-UPDATE.txt` says they changed. If you had built a single-file program, it is set aside because it contains the old version. Run `./build-binary.sh` again if you want it.
