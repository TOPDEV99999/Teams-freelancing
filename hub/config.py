"""Hub configuration loaded from .env (project root)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

FROZEN = getattr(sys, "frozen", False)
# APP_DIR: writable folder (.env, data/, my_fetcher.py). Next to the .exe when packaged.
APP_DIR = Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parent.parent
# RES_DIR: bundled read-only resources (dashboard/dist, .env.example).
RES_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR)) if FROZEN else APP_DIR
ROOT = APP_DIR
load_dotenv(APP_DIR / ".env")


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


class Config:
    # The server is ALWAYS bound to localhost. Not configurable on purpose.
    HOST = "127.0.0.1"
    PORT = _int("HUB_PORT", 8766)
    SHARED_SECRET = os.getenv("HUB_SHARED_SECRET", "")
    DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{(ROOT / 'data' / 'hub.db').as_posix()}")
    FETCHER = os.getenv("FETCHER", "workana").strip().lower()
    FETCH_INTERVAL_SECONDS = _int("FETCH_INTERVAL_SECONDS", 60)
    GENERATION_PROVIDER = os.getenv("GENERATION_PROVIDER", "chatgpt_web").strip().lower()
    GENERATION_TIMEOUT_SECONDS = _int("GENERATION_TIMEOUT_SECONDS", 300)
    OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
    OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    SUBMIT_TIMEOUT_SECONDS = _int("SUBMIT_TIMEOUT_SECONDS", 900)
    EXT_STALE_SECONDS = 60
    DASHBOARD_DIST = RES_DIR / "dashboard" / "dist"
    # Optional external fetcher (lets the packaged .exe use your code without rebuilding).
    EXTERNAL_FETCHER = APP_DIR / "my_fetcher.py"


config = Config()
