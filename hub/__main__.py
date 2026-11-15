"""Run the hub:  py -m hub   (or WorkanaAssistant.exe when packaged).

Options:  --no-browser   don't open the dashboard automatically
          --reload       auto-reload on code changes (source checkout only)
"""
from __future__ import annotations

import secrets
import shutil
import sys
import threading
import time
import webbrowser

from .config import APP_DIR, FROZEN, RES_DIR


def _ensure_env() -> None:
    env = APP_DIR / ".env"
    if not env.exists():
        shutil.copy(RES_DIR / ".env.example", env)
    text = env.read_text(encoding="utf-8")
    if "HUB_SHARED_SECRET=change-me" in text or "HUB_SHARED_SECRET=\n" in text:
        secret = secrets.token_urlsafe(24)
        text = text.replace("HUB_SHARED_SECRET=change-me", f"HUB_SHARED_SECRET={secret}")
        text = text.replace("HUB_SHARED_SECRET=\n", f"HUB_SHARED_SECRET={secret}\n")
        env.write_text(text, encoding="utf-8")
    secret_line = next((l for l in text.splitlines() if l.startswith("HUB_SHARED_SECRET=")), "")
    print(f"\n  Settings file: {env}\n  {secret_line}\n  (paste the secret into each extension's popup)\n")


def main() -> None:
    _ensure_env()
    # Import after .env exists so config picks it up.
    import importlib

    import uvicorn

    from . import config as config_module

    importlib.reload(config_module)
    cfg = config_module.config
    url = f"http://localhost:{cfg.PORT}"
    print(f"  Dashboard: {url}\n  Close this window to stop the hub.\n")

    if "--no-browser" not in sys.argv:
        def _open() -> None:
            time.sleep(2)
            webbrowser.open(url)

        threading.Thread(target=_open, daemon=True).start()

    if "--reload" in sys.argv and not FROZEN:
        uvicorn.run("hub.main:app", host=cfg.HOST, port=cfg.PORT, reload=True)
        return
    from .main import app

    try:
        uvicorn.run(app, host=cfg.HOST, port=cfg.PORT, log_level="info")
    except SystemExit:
        pass
    if FROZEN and sys.stdin is not None and sys.stdin.isatty():  # no terminal under systemd
        input(f"\n  The hub stopped (is port {cfg.PORT} already in use?). Press Enter to close…")


if __name__ == "__main__":
    main()
