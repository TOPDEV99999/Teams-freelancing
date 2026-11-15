"""Client "last seen": the client's last login, read from their PUBLIC Workana profile (no login, no account).

Workana does not publish a live online/offline state to logged-out visitors; the public profile shows
"Last login: <strong title="November 14, 2026 04:54">10 hours ago</strong>". This service refreshes that for
recent, still-open jobs and pushes it to the dashboard.

Safety (the account is never involved):
  * anonymous requests from the hub (like the job fetcher), never through a logged-in browser;
  * only jobs fetched in the last N hours that are still open (new / drafted / error) or open in the dashboard;
  * one request at a time, >= 8 s apart with random jitter, each job at most every N minutes;
  * pauses 30 minutes on any block / challenge / error status;
  * off switch: Settings → Client last seen.
"""
from __future__ import annotations

import asyncio
import html
import json
import logging
import random
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

from sqlmodel import Session, select

from .. import events
from ..db import engine
from ..models import Job, utcnow
from ..serialize import iso, job_dict
from . import settings_store

log = logging.getLogger("hub.presence")

BASE = "https://www.workana.com"
# Timestamps on Workana profiles are in Argentina/Brazil time (UTC-3, no DST). Verified Nov 2026 by comparing
# them with the "N hours ago" text next to them.
WORKANA_TZ = timezone(timedelta(hours=-3))
OPEN_STATUSES = ("new", "drafted", "error")
MIN_GAP_S, MAX_GAP_S = 20.0, 40.0
BLOCK_PAUSE_S = 60 * 60  # doubles after each further block (1 h, 2 h, 4 h ... max 12 h)

_MONTHS = {m: i + 1 for i, m in enumerate(
    "january february march april may june july august september october november december".split())}
_MONTHS.update({m: i + 1 for i, m in enumerate(
    "enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre".split())})
_MONTHS.update({m: i + 1 for i, m in enumerate(
    "janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro".split())})

_UNIT_S = {"second": 1, "segundo": 1, "minute": 60, "minuto": 60, "hour": 3600, "hora": 3600, "day": 86400,
           "día": 86400, "dia": 86400, "week": 604800, "semana": 604800, "month": 2592000, "mes": 2592000,
           "mês": 2592000, "year": 31536000, "año": 31536000, "ano": 31536000}


# ---------------------------------------------------------------- parsing

def client_profile_path(job_page_html: str) -> Optional[str]:
    """/e/<id> link of the client card on a public job page."""
    m = re.search(r'class="wk-user-info".{0,800}?href="(/e/[A-Za-z0-9_\-]+)"', job_page_html, re.S)
    if not m:
        m = re.search(r'href="(/e/[A-Za-z0-9_\-]+)"', job_page_html)
    return m.group(1) if m else None


def _json_field(text: str, key: str) -> Optional[str]:
    m = re.search(r'"' + key + r'"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    if not m:
        return None
    try:
        return json.loads('"' + m.group(1) + '"')
    except ValueError:
        return m.group(1)


def parse_absolute(title: str) -> Optional[datetime]:
    """'November 14, 2026 04:54' / '14 de noviembre de 2026 04:54' (Workana time) -> naive UTC."""
    t = title.strip().lower()
    m = re.match(r"([a-zçñ]+)\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})", t)
    if m and m.group(1) in _MONTHS:
        mon, day, year, hh, mm = _MONTHS[m.group(1)], int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5))
    else:
        m = re.match(r"(\d{1,2})\s+de\s+([a-zçñ]+)\s+de\s+(\d{4}),?\s+(\d{1,2}):(\d{2})", t)
        if not m or m.group(2) not in _MONTHS:
            return None
        day, mon, year, hh, mm = int(m.group(1)), _MONTHS[m.group(2)], int(m.group(3)), int(m.group(4)), int(m.group(5))
    try:
        local = datetime(year, mon, day, hh, mm, tzinfo=WORKANA_TZ)
    except ValueError:
        return None
    return local.astimezone(timezone.utc).replace(tzinfo=None)


def parse_relative(text: str) -> Optional[int]:
    """'10 hours ago' / 'hace 2 horas' / 'há um dia' / 'just now' -> seconds."""
    t = text.strip().lower()
    if re.search(r"just now|moments? ago|ahora|agora|now", t):
        return 0
    m = re.search(r"(\d+|an?|one|un[ao]?|uma?)\s+([a-zíêñ]+?)s?\b", t.replace("hace ", "").replace("há ", ""))
    if not m:
        return None
    n = int(m.group(1)) if m.group(1).isdigit() else 1
    unit = m.group(2).rstrip("s")
    for k, v in _UNIT_S.items():
        if unit.startswith(k) or (len(unit) >= 3 and k.startswith(unit)):
            return n * v
    return None


def parse_profile(profile_html: str, now: Optional[datetime] = None) -> dict[str, Any]:
    """Last login (UTC) + verified payment from a public client profile page."""
    now = now or utcnow()
    text = html.unescape(profile_html)
    out: dict[str, Any] = {}
    raw = _json_field(text, "lastLogin")
    if raw:
        m = re.search(r'title="([^"]+)"[^>]*>([^<]+)<', raw)
        absolute = parse_absolute(m.group(1)) if m else None
        rel_text = (m.group(2) if m else re.sub(r"<[^>]+>", "", raw).split(":", 1)[-1]).strip()
        rel = parse_relative(rel_text)
        when = absolute
        if rel is not None:
            by_rel = now - timedelta(seconds=rel)
            # Trust the exact timestamp unless it clearly disagrees with the "N ago" text.
            if when is None or abs((when - by_rel).total_seconds()) > max(2 * 3600, rel * 0.35):
                when = by_rel
        if when is not None:
            out["last_login"] = iso(min(when, now))
        out["last_login_text"] = rel_text[:40]
    v = re.search(r'"hasVerifiedPaymentMethod"\s*:\s*(true|false)', text)
    if v:
        out["payment_verified"] = v.group(1) == "true"
    return out


def is_blocked(status: int, body: str) -> bool:
    return status in (403, 429, 503) or "cf-chl" in body[:5000] or "Just a moment" in body[:3000]


# ---------------------------------------------------------------- service

class PresenceService:
    def __init__(self, get: Optional[Callable[[str], tuple[int, str]]] = None, rng: Optional[random.Random] = None):
        self._get = get  # injectable for tests: url -> (status, body)
        self._session = None
        self.rng = rng or random.Random()
        self.paused_until = 0.0
        self.priority: dict[str, float] = {}  # job ids opened in the dashboard -> when
        self.checked = 0
        self.last_error: Optional[str] = None
        self.blocks = 0  # consecutive blocks -> longer pauses

    # -- http (anonymous)
    def _fetch(self, path: str) -> tuple[int, str]:
        if self._get:
            return self._get(BASE + path)
        if self._session is None:
            from curl_cffi import requests

            self._session = requests.Session(impersonate="chrome")
        r = self._session.get(BASE + path, timeout=20,
                              headers={"Accept": "text/html,*/*", "Accept-Language": "en-US,en;q=0.9"})
        return r.status_code, r.text

    def watch(self, job_id: str) -> None:
        """A job opened in the dashboard is refreshed first (still rate-limited)."""
        self.priority[job_id] = time.time()

    def status(self) -> dict[str, Any]:
        left = self.paused_until - time.time()
        return {"paused_s": int(left) if left > 0 else 0, "checked": self.checked, "last_error": self.last_error}

    def due(self, s: Session, cfg: dict[str, Any], now: Optional[datetime] = None) -> Optional[Job]:
        now = now or utcnow()
        interval = timedelta(minutes=max(2, int(cfg.get("interval_minutes") or 10)))
        oldest = now - timedelta(hours=max(1, int(cfg.get("max_age_hours") or 48)))
        # Dashboard-opened jobs first (within the last 30 min), regardless of age/status.
        for jid, at in sorted(self.priority.items(), key=lambda kv: -kv[1]):
            if time.time() - at > 1800:
                self.priority.pop(jid, None)
                continue
            job = s.get(Job, jid)
            if job and self._stale(job, now, timedelta(minutes=2)):
                return job
        cands = s.exec(select(Job).where(Job.status.in_(OPEN_STATUSES), Job.fetched_at >= oldest)
                       .order_by(Job.fetched_at.desc()).limit(300)).all()
        stale = [j for j in cands if self._stale(j, now, interval)]
        if not stale:
            return None
        # Never checked first, then the longest ago.
        stale.sort(key=lambda j: (j.client_info or {}).get("presence_checked_at") or "")
        return stale[0]

    def _stale(self, job: Job, now: datetime, interval: timedelta) -> bool:
        ci = job.client_info or {}
        if ci.get("presence_failed"):
            return False
        at = ci.get("presence_checked_at")
        if not at:
            return True
        try:
            last = datetime.fromisoformat(str(at).rstrip("Z"))
        except ValueError:
            return True
        # Jittered interval so requests don't fall into a fixed rhythm.
        return now - last >= interval * self.rng.uniform(0.8, 1.3)

    def check(self, job_id: str) -> Optional[dict[str, Any]]:
        """One refresh (blocking network). Returns the new presence fields or None."""
        with Session(engine) as s:
            job = s.get(Job, job_id)
            if job is None:
                return None
            ci = dict(job.client_info or {})
            slug = job.id
        path = ci.get("client_profile")
        if not path:
            st, body = self._fetch(f"/job/{slug}")
            if is_blocked(st, body):
                return self._blocked(st)
            path = client_profile_path(body) if st == 200 else None
            if not path:
                return self._save(job_id, {"presence_failed": True})
            time.sleep(self.rng.uniform(MIN_GAP_S, MAX_GAP_S))
        st, body = self._fetch(path)
        if is_blocked(st, body):
            return self._blocked(st)
        if st != 200:
            return self._save(job_id, {"client_profile": path, "presence_failed": st == 404})
        info = parse_profile(body)
        self.checked += 1
        self.last_error = None
        self.blocks = max(0, self.blocks - 1)
        return self._save(job_id, {"client_profile": path, **info})

    def _blocked(self, status: int) -> None:
        pause = min(BLOCK_PAUSE_S * (2 ** self.blocks), 12 * 3600)
        self.blocks += 1
        self.paused_until = time.time() + pause
        self._session = None  # fresh session next time
        self.last_error = (f"Workana answered HTTP {status} / challenge - client last-seen paused for "
                           f"{pause // 3600} h (the job fetcher is not affected)")
        events.log("fetch", self.last_error, "warn")
        return None

    def _save(self, job_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        with Session(engine) as s:
            job = s.get(Job, job_id)
            if job is None:
                return fields
            ci = dict(job.client_info or {})
            ci.update(fields)
            ci["presence_checked_at"] = iso(utcnow())
            job.client_info = ci  # new dict -> SQLAlchemy sees the change
            s.add(job)
            s.commit()
            s.refresh(job)
            events.notify("job_updated", job_dict(job, s))
        return fields

    async def loop(self) -> None:
        await asyncio.sleep(20)
        while True:
            delay = self.rng.uniform(MIN_GAP_S, MAX_GAP_S)
            try:
                with Session(engine) as s:
                    cfg = settings_store.get(s, "presence")
                    busy_fetch = _fetcher_busy()
                    job = None if (not cfg.get("enabled") or busy_fetch or time.time() < self.paused_until) \
                        else self.due(s, cfg)
                    jid = job.id if job else None
                if jid:
                    await asyncio.to_thread(self.check, jid)
                else:
                    delay = 5.0
            except Exception as e:  # noqa: BLE001 - never let the loop die
                self.last_error = repr(e)
                log.warning("presence check failed: %r", e)
                delay = 60.0
            await asyncio.sleep(delay)


def _fetcher_busy() -> bool:
    from .ingest import fetch_control

    return bool(fetch_control.busy)


presence = PresenceService()
