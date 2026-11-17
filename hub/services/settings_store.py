"""Key/value settings stored in the `settings` table (JSON values)."""
from __future__ import annotations

import re
from datetime import datetime, time
from typing import Any

from sqlmodel import Session, select

from ..config import config
from ..models import Setting
from .prompt import DEFAULT_STYLES, DEFAULT_TEMPLATE


def defaults() -> dict[str, Any]:
    return {
        "master_prompt": DEFAULT_TEMPLATE,
        "styles": DEFAULT_STYLES,
        "fetch_interval_seconds": max(15, config.FETCH_INTERVAL_SECONDS),
        "generation_provider": config.GENERATION_PROVIDER,
        "jitter_min_seconds": 20,
        "jitter_max_seconds": 90,
        # Random pause between two ChatGPT prompts (batches): avoids usage limits / "unusual activity".
        "generation_pause_min_seconds": 15,
        "generation_pause_max_seconds": 45,
        "quiet_hours": {"enabled": False, "start": "23:00", "end": "07:00"},
        "assign_threshold": 1.0,
        "fetcher_enabled": True,
        "workana_filters": dict(DEFAULT_WORKANA_FILTERS),
        "telegram": {"enabled": False, "bot_token": "", "chat_ids": ""},
        "auto_send": dict(DEFAULT_AUTO_SEND),
        "retention": dict(DEFAULT_RETENTION),
        "translation": {"provider": "auto", "target": "en"},
        "notifications": {"telegram": False, "auto_outcome": True},
        "chatgpt": {"temporary_chat": True, "delete_after_reply": True},
        # Client "last seen" from public profiles (anonymous, rate-limited; see services/presence.py).
        "presence": {"enabled": True, "interval_minutes": 20, "max_age_hours": 24},
        # Bid currency per account (Accounts page); prices are decided in USD and converted with these rates.
        "currency_rates": {"BRL": 5.4, "MXN": 18.5, "updated_at": "", "source": "default"},
        # Dashboard inbox: auto (read in the background) | manual (read only when you check; alerts stay live) | off
        "inbox": {"mode": "auto", "interval_minutes": 3},
    }


# Automatic sending (per-job "Auto-send" switch and the optional auto-pilot for new jobs).
DEFAULT_AUTO_SEND: dict[str, Any] = {
    "review_seconds": 120,       # auto-queued proposals wait this long before dispatch (time to cancel)
    "style_mode": "fixed",       # fixed (job's style / first) | rotate | random
    "price_mode": "suggested",   # suggested | budget_min | budget_mid | budget_max_pct
    "price_pct": 90,             # for budget_max_pct
    "min_price": 0,              # never auto-send below this (USD, 0 = off)
    "max_price": 0,              # never auto-send above this (USD, 0 = off)
    "min_trust": "any",          # any | new | fair | good | high
    "max_bids": 0,               # skip jobs that already have more bids than this (0 = off)
    "daily_cap": 0,              # max auto-sent proposals per day, all accounts (0 = off)
    "autopilot": False,          # new jobs: generate + auto-send for matching accounts automatically
    "autopilot_accounts": [],    # empty = every matching account
}
_STYLE_MODES = ("fixed", "rotate", "random")
_PRICE_MODES = ("suggested", "budget_min", "budget_mid", "budget_max_pct")
_TRUST = ("any", "new", "fair", "good", "high")

# Automatic clean-up (Data page). 0 days = keep forever.
DEFAULT_RETENTION: dict[str, Any] = {
    "enabled": False,
    "logs_days": 14,
    "jobs_days": 30,
    "job_statuses": ["new", "skipped", "error"],
    "keep_sent": True,
    "notices_days": 30,
}
_JOB_STATUSES = ("new", "drafted", "sent", "skipped", "error")


DEFAULT_WORKANA_FILTERS: dict[str, Any] = {
    "languages": ["es", "pt"],
    "allow_fixed": True,
    "min_budget": 100,
    "allow_hourly": True,
    "min_hourly_rate": 0,
    "skills": [],
    "min_client_since": "",
    "min_paid_ratio": 0.0,
    "min_published": 0,
    "skip_closed": True,
    "check_job_page": True,
    "include_featured": False,
    "impersonate": "chrome",
}

_LANGS = {"es", "pt", "en"}


def _workana_filters(v: Any) -> dict[str, Any]:
    if not isinstance(v, dict):
        raise ValueError("workana_filters must be an object")
    out = dict(DEFAULT_WORKANA_FILTERS)
    for k in DEFAULT_WORKANA_FILTERS:
        if k in v:
            out[k] = v[k]
    langs = [str(x).strip().lower() for x in out["languages"] or []]
    if not langs or any(l not in _LANGS for l in langs):
        raise ValueError("languages: choose at least one of es, pt, en")
    out["languages"] = list(dict.fromkeys(langs))
    for k in ("allow_fixed", "allow_hourly", "skip_closed", "check_job_page", "include_featured"):
        out[k] = bool(out[k])
    if not out["allow_fixed"] and not out["allow_hourly"]:
        raise ValueError("enable fixed-price and/or hourly projects")
    out["min_budget"] = max(0.0, float(out["min_budget"] or 0))
    out["min_hourly_rate"] = max(0.0, float(out["min_hourly_rate"] or 0))
    out["min_paid_ratio"] = min(1.0, max(0.0, float(out["min_paid_ratio"] or 0)))
    out["min_published"] = max(0, int(out["min_published"] or 0))
    since = str(out["min_client_since"] or "").strip()
    if since:
        try:
            since = datetime.strptime(since, "%Y-%m").strftime("%Y-%m")
        except ValueError:
            raise ValueError("member since must be YYYY-MM (e.g. 2026-09)")
    out["min_client_since"] = since
    skills = out["skills"]
    if isinstance(skills, str):
        skills = skills.split(",")
    out["skills"] = sorted({str(s).strip().lower() for s in skills if str(s).strip()})
    out["impersonate"] = str(out["impersonate"] or "chrome").strip() or "chrome"
    return out


def seed_defaults(s: Session) -> None:
    existing = {row.key for row in s.exec(select(Setting)).all()}
    for k, v in defaults().items():
        if k not in existing:
            s.add(Setting(key=k, value=v))
    s.commit()


def get(s: Session, key: str) -> Any:
    row = s.get(Setting, key)
    if row is None:
        return defaults().get(key)
    return _merged(key, row.value)


def _merged(key: str, value: Any) -> Any:
    """Dict settings gain keys added in newer versions."""
    d = defaults().get(key)
    if isinstance(d, dict) and isinstance(value, dict):
        return {**d, **value}
    return value


def get_all(s: Session) -> dict[str, Any]:
    out = defaults()
    for row in s.exec(select(Setting)).all():
        if row.key in out:
            out[row.key] = _merged(row.key, row.value)
    return out


def validate(updates: dict[str, Any]) -> dict[str, Any]:
    """Validate/normalise a partial settings update. Raises ValueError."""
    known = defaults().keys()
    clean: dict[str, Any] = {}
    for k, v in updates.items():
        if k not in known:
            raise ValueError(f"unknown setting: {k}")
        if k == "master_prompt":
            if not isinstance(v, str) or len(v.strip()) < 20:
                raise ValueError("master_prompt must be a non-empty template")
        elif k == "styles":
            if not isinstance(v, list) or not v:
                raise ValueError("styles must be a non-empty list")
            seen = set()
            norm = []
            for st in v:
                key = str(st.get("key", "")).strip().lower()
                if not key or not key.replace("_", "").isalnum() or key in seen or key in ("price", "days"):
                    raise ValueError(f"invalid or duplicate style key: {key!r}")
                seen.add(key)
                norm.append({"key": key, "instructions": str(st.get("instructions", "")).strip()})
            v = norm
        elif k == "fetch_interval_seconds":
            v = int(v)
            if v < 15:
                raise ValueError("fetch_interval_seconds must be >= 15")
        elif k == "generation_provider":
            if v not in ("chatgpt_web", "openai_api"):
                raise ValueError("generation_provider must be chatgpt_web or openai_api")
        elif k in ("jitter_min_seconds", "jitter_max_seconds", "generation_pause_min_seconds", "generation_pause_max_seconds"):
            v = int(v)
            if v < 0:
                raise ValueError(f"{k} must be >= 0")
        elif k == "quiet_hours":
            v = {
                "enabled": bool(v.get("enabled")),
                "start": _hhmm(v.get("start", "23:00")),
                "end": _hhmm(v.get("end", "07:00")),
            }
        elif k == "assign_threshold":
            v = float(v)
        elif k == "fetcher_enabled":
            v = bool(v)
        elif k == "workana_filters":
            v = _workana_filters(v)
        elif k == "telegram":
            if not isinstance(v, dict):
                raise ValueError("telegram must be an object")
            v = {
                "enabled": bool(v.get("enabled")),
                "bot_token": str(v.get("bot_token") or "").strip(),
                "chat_ids": ",".join(c.strip() for c in str(v.get("chat_ids") or "").split(",") if c.strip()),
            }
            if v["enabled"] and not (v["bot_token"] and v["chat_ids"]):
                raise ValueError("Telegram needs a bot token and at least one chat ID")
        elif k == "auto_send":
            v = _auto_send(v)
        elif k == "retention":
            v = _retention(v)
        elif k == "translation":
            if not isinstance(v, dict):
                raise ValueError("translation must be an object")
            prov = str(v.get("provider") or "auto")
            if prov not in ("auto", "browser", "google"):
                raise ValueError("translation provider must be auto, browser or google")
            target = str(v.get("target") or "en").strip().lower()
            if not re.fullmatch(r"[a-z]{2,3}(?:-[a-z]{2,4})?", target, re.I):
                raise ValueError("translation target must be a language code such as en, ko, ja, zh-CN")
            v = {"provider": prov, "target": target}
        elif k == "inbox":
            if not isinstance(v, dict):
                raise ValueError("inbox must be an object")
            mode = str(v.get("mode") or "auto")
            if mode not in ("auto", "manual", "off"):
                raise ValueError("inbox mode must be auto, manual or off")
            v = {"mode": mode, "interval_minutes": max(1, min(60, int(v.get("interval_minutes") or 3)))}
        elif k == "currency_rates":
            from .currency import validate_rates
            v = validate_rates(v)
        elif k == "notifications":
            if not isinstance(v, dict):
                raise ValueError("notifications must be an object")
            v = {"telegram": bool(v.get("telegram")), "auto_outcome": bool(v.get("auto_outcome", True))}
        elif k == "presence":
            if not isinstance(v, dict):
                raise ValueError("presence must be an object")
            v = {"enabled": bool(v.get("enabled", True)),
                 "interval_minutes": max(5, min(240, int(v.get("interval_minutes") or 10))),
                 "max_age_hours": max(1, min(168, int(v.get("max_age_hours") or 48)))}
        elif k == "chatgpt":
            if not isinstance(v, dict):
                raise ValueError("chatgpt must be an object")
            v = {"temporary_chat": bool(v.get("temporary_chat", True)),
                 "delete_after_reply": bool(v.get("delete_after_reply", True))}
        clean[k] = v
    jmin = clean.get("jitter_min_seconds")
    jmax = clean.get("jitter_max_seconds")
    if jmin is not None and jmax is not None and jmin > jmax:
        raise ValueError("jitter_min_seconds must be <= jitter_max_seconds")
    gmin = clean.get("generation_pause_min_seconds")
    gmax = clean.get("generation_pause_max_seconds")
    if gmin is not None and gmax is not None and gmin > gmax:
        raise ValueError("generation_pause_min_seconds must be <= generation_pause_max_seconds")
    return clean


def _auto_send(v: Any) -> dict[str, Any]:
    if not isinstance(v, dict):
        raise ValueError("auto_send must be an object")
    out = {**DEFAULT_AUTO_SEND, **{k: v[k] for k in DEFAULT_AUTO_SEND if k in v}}
    out["review_seconds"] = max(0, min(3600, int(out["review_seconds"] or 0)))
    if out["style_mode"] not in _STYLE_MODES:
        raise ValueError(f"style_mode must be one of {', '.join(_STYLE_MODES)}")
    if out["price_mode"] not in _PRICE_MODES:
        raise ValueError(f"price_mode must be one of {', '.join(_PRICE_MODES)}")
    out["price_pct"] = max(10, min(100, int(out["price_pct"] or 90)))
    out["min_price"] = max(0.0, float(out["min_price"] or 0))
    out["max_price"] = max(0.0, float(out["max_price"] or 0))
    if out["max_price"] and out["min_price"] > out["max_price"]:
        raise ValueError("minimum auto-send price must be <= maximum")
    if out["min_trust"] not in _TRUST:
        raise ValueError(f"min_trust must be one of {', '.join(_TRUST)}")
    out["max_bids"] = max(0, int(out["max_bids"] or 0))
    out["daily_cap"] = max(0, int(out["daily_cap"] or 0))
    out["autopilot"] = bool(out["autopilot"])
    out["autopilot_accounts"] = [str(a) for a in out["autopilot_accounts"] or [] if str(a).strip()]
    return out


def _retention(v: Any) -> dict[str, Any]:
    if not isinstance(v, dict):
        raise ValueError("retention must be an object")
    out = {**DEFAULT_RETENTION, **{k: v[k] for k in DEFAULT_RETENTION if k in v}}
    out["enabled"] = bool(out["enabled"])
    for k in ("logs_days", "jobs_days", "notices_days"):
        out[k] = max(0, min(3650, int(out[k] or 0)))
    sts = [str(x) for x in out["job_statuses"] or []]
    if any(x not in _JOB_STATUSES for x in sts):
        raise ValueError(f"job_statuses: choose from {', '.join(_JOB_STATUSES)}")
    out["job_statuses"] = list(dict.fromkeys(sts))
    out["keep_sent"] = bool(out["keep_sent"])
    return out


def _hhmm(v: str) -> str:
    t = datetime.strptime(str(v).strip(), "%H:%M").time()
    return t.strftime("%H:%M")


def set_many(s: Session, updates: dict[str, Any]) -> dict[str, Any]:
    clean = validate(updates)
    for k, v in clean.items():
        row = s.get(Setting, k) or Setting(key=k)
        row.value = v
        s.add(row)
    s.commit()
    return get_all(s)


def set_raw(s: Session, key: str, value: Any) -> None:
    """Internal bookkeeping values (not user settings, no validation)."""
    row = s.get(Setting, key) or Setting(key=key)
    row.value = value
    s.add(row)
    s.commit()


def in_quiet_hours(qh: dict[str, Any], now_local: datetime | None = None) -> bool:
    if not qh or not qh.get("enabled"):
        return False
    now_t = (now_local or datetime.now()).time()
    start = time.fromisoformat(qh["start"])
    end = time.fromisoformat(qh["end"])
    if start == end:
        return False
    if start < end:
        return start <= now_t < end
    return now_t >= start or now_t < end  # window crosses midnight
