"""Built-in Workana fetcher (FETCHER=workana).

Ported from the standalone workana_bot.py:
  * reads the same JSON endpoint Workana's own front-end uses (/jobs?language=xx), no HTML scraping;
  * curl_cffi replays a real Chrome TLS handshake (Cloudflare); the session self-heals on
    repeated challenges / failures / empty cycles / old age;
  * filters: languages, fixed budget, hourly + min rate, skill slugs, client member-since,
    paid ratio, closed projects (status label on the job page).
All filters are read from the dashboard (Fetcher page) on every cycle - no restart needed.

First run: everything currently listed is only recorded as "seen" (no flood of old jobs).
"""
from __future__ import annotations

import html
import json
import logging
import os
import random
import re
import threading
import time
from pathlib import Path
from typing import Any

from sqlmodel import Session

from .. import events
from ..config import config
from ..db import engine
from .base import JobFetcher, JobIn

log = logging.getLogger("hub.fetcher")

WORKANA_URL = "https://www.workana.com/jobs"
LIST_HEADERS = {
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    # English UI: Workana stores the locale in a cookie, and the job-page parser below
    # is most reliable with English labels (es/pt labels are handled too).
    "Accept-Language": "en-US,en;q=0.9,es;q=0.8,pt;q=0.7",
    "Referer": WORKANA_URL,
}
PAGE_HEADERS = {"Accept": "text/html,*/*", "Accept-Language": "en-US,en;q=0.9,es;q=0.8", "Referer": WORKANA_URL}

MAX_REMEMBERED = 5000
MAX_SESSION_AGE_S = 45 * 60
CF_LIMIT, FAILURE_LIMIT, EMPTY_LIMIT = 3, 5, 5


# --------------------------------------------------------------------------- parsing helpers

_TAG_RE = re.compile(r"<[^>]+>")
_BLANK_RE = re.compile(r"\n\s*\n\s*(?:\n\s*)+")


def strip_tags(s: str | None) -> str:
    if not s:
        return ""
    s = re.sub(r"<br\s*/?>", "\n", s)
    return _BLANK_RE.sub("\n\n", html.unescape(_TAG_RE.sub("", s))).strip()


def _to_number(token: str) -> float:
    """'1,000' / '1.000' / '1.000,50' / '1,000.50' / '12,5' -> float."""
    token = token.strip().rstrip(".,")
    if "," in token and "." in token:  # the last separator is the decimal one
        dec = "," if token.rfind(",") > token.rfind(".") else "."
        token = token.replace("." if dec == "," else ",", "").replace(dec, ".")
    elif re.fullmatch(r"\d{1,3}(?:[.,]\d{3})+", token):  # thousands separators only
        token = re.sub(r"[.,]", "", token)
    else:
        token = token.replace(",", ".")
    try:
        return float(token)
    except ValueError:
        return float("nan")


def parse_budget(text: str) -> tuple[float | None, float | None]:
    if not text:
        return None, None
    low = text.lower()
    nums = [n for n in (_to_number(t) for t in re.findall(r"\d[\d.,]*", text)) if n == n]
    if not nums:
        return None, None
    if "menos de" in low or "less than" in low:
        return 0.0, nums[0]
    if any(k in low for k in ("más de", "mas de", "mais de", "more than", "over ")):
        return nums[0], None
    if len(nums) >= 2:
        return min(nums[0], nums[1]), max(nums[0], nums[1])
    return nums[0], nums[0]


def full_title(p: dict) -> str:
    raw = p.get("title") or ""
    m = re.search(r'title="([^"]+)"', raw)
    return html.unescape(m.group(1)).strip() if m else strip_tags(raw)


def country_name(p: dict) -> str:
    raw = p.get("country") or ""
    m = re.search(r'class="country-name"[^>]*>.*?<a[^>]*>([^<]+)</a>', raw, re.S)
    if m:
        return html.unescape(m.group(1)).strip()
    m = re.search(r'title="([^"]+)"', raw)
    return html.unescape(m.group(1)).strip() if m else strip_tags(raw)


def skill_slugs(p: dict) -> set[str]:
    out = set()
    for sk in p.get("skills") or []:
        m = re.search(r"[?&]skills=([^&\"']+)", sk.get("anchorLink") or "")
        if m:
            out.add(m.group(1).lower())
    return out


def split_description(raw: str) -> tuple[str, str | None, str | None]:
    """The list endpoint appends 'Category: <strong>X</strong> Subcategory: ...' - split it off."""
    # Case-sensitive on purpose: "Category" must not match inside "Subcategory".
    mc = re.search(r"(?:Category|Categoría|Categoria):\s*<strong>([^<]+)</strong>", raw)
    ms = re.search(r"(?:Subcategory|Subcategoría|Subcategoria):\s*<strong>([^<]+)</strong>", raw)
    cat = html.unescape(mc.group(1)).strip() if mc else None
    sub = html.unescape(ms.group(1)).strip() if ms else None
    return strip_tags(raw[: mc.start()] if mc else raw), cat, sub


_MONTHS = {m: i + 1 for i, m in enumerate(
    "january february march april may june july august september october november december".split())}
_MONTHS.update({m: i + 1 for i, m in enumerate(
    "enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre".split())})
_MONTHS.update({m: i + 1 for i, m in enumerate(
    "janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro".split())})


def _stat(text: str, label: str) -> int | None:
    m = re.search(r'<p[^>]*>\s*(\d+)\s*</p>\s*<p[^>]*>\s*' + label + r"\s*</p>", text, re.I | re.S)
    return int(m.group(1)) if m else None


def parse_job_page(text: str) -> dict[str, Any]:
    """Client + status info from a public job page (fields are None when not found)."""
    info: dict[str, Any] = {}
    m = re.search(r'<header id="productName">\s*<span class="([^"]*\blabel\b[^"]*)"[^>]*>\s*([^<]+?)\s*</span>', text)
    if m:
        classes = m.group(1).split()
        info["status"] = html.unescape(m.group(2)).strip()
        info["status_key"] = classes[-1] if classes else ""
        info["is_open"] = "open" in classes
    m = re.search(r"(?:Member since|Miembro desde|Membro desde)\s*:?\s*([A-Za-zÀ-ÿ]+),?\s+(?:de\s+)?(\d{4})", text, re.I)
    if m:
        month = _MONTHS.get(m.group(1).lower())
        if month:
            info["member_since"] = f"{int(m.group(2)):04d}-{month:02d}"
            info["member_since_text"] = f"{m.group(1).capitalize()} {m.group(2)}"
    for key, label in (("published", r"(?:Published\s+projects|Proyectos\s+publicados|Projetos\s+publicados)"),
                       ("paid", r"(?:Projects\s+paid|Proyectos\s+pagos|Projetos\s+pagos)"),
                       ("bids", r"(?:Bids|Propuestas|Propostas)"),
                       ("interested", r"(?:Interested\s+freelancers|Freelancers\s+interesad[oa]s|Freelancers\s+interessad[oa]s)")):
        v = _stat(text, label)
        if v is not None:
            info[key] = v
    from ..services.presence import client_profile_path

    path = client_profile_path(text)
    if path:
        info["client_profile"] = path
    # Best effort: Workana shows a "verified payment method" badge on some client profiles.
    if re.search(r"(?:payment\s+method\s+verified|verified\s+payment|m[eé]todo\s+de\s+pago\s+verificado|"
                 r"pago\s+verificado|m[eé]todo\s+de\s+pagamento\s+verificado|pagamento\s+verificado)", text, re.I):
        info["payment_verified"] = True
    return info


# --------------------------------------------------------------------------- filters

def budget_ok(p: dict, f: dict) -> tuple[bool, str]:
    lo, _hi = parse_budget(p.get("budget") or "")
    if p.get("isHourly"):
        if not f.get("allow_hourly", True):
            return False, "hourly"
        rate = float(f.get("min_hourly_rate") or 0)
        return (lo is None or rate <= 0 or lo >= rate), "hourly rate"
    if not f.get("allow_fixed", True):
        return False, "fixed"
    mb = float(f.get("min_budget") or 0)
    if mb <= 0:
        return True, ""
    return (lo is not None and lo >= mb), "budget"


def skills_ok(p: dict, f: dict) -> bool:
    wanted = {s.lower() for s in f.get("skills") or []}
    return not wanted or bool(skill_slugs(p) & wanted)


def client_ok(info: dict, f: dict) -> tuple[bool, str]:
    if f.get("skip_closed", True) and info.get("is_open") is False:
        return False, f"status '{info.get('status')}'"
    since = (f.get("min_client_since") or "").strip()
    if since and info.get("member_since") and info["member_since"] >= since:
        return False, f"client joined {info['member_since']} (>= {since})"
    ratio = float(f.get("min_paid_ratio") or 0)
    pub, paid = info.get("published"), info.get("paid")
    if ratio > 0 and pub is not None and paid is not None and pub >= max(int(f.get("min_published") or 0), 1):
        if paid / pub < ratio:
            return False, f"paid ratio {paid}/{pub} < {ratio:.0%}"
    return True, ""


# --------------------------------------------------------------------------- fetcher

def _default_state_file() -> Path:
    """Next to the database (data/workana_seen.json)."""
    url = config.DATABASE_URL
    if url.startswith("sqlite:///") and ":memory:" not in url:
        return Path(url.removeprefix("sqlite:///")).parent / "workana_seen.json"
    return config.ROOT / "data" / "workana_seen.json"


class WorkanaFetcher(JobFetcher):
    def __init__(self, state_file: Path | None = None) -> None:
        self.state_file = state_file or _default_state_file()
        self._lock = threading.Lock()
        self._session = None
        self._born = 0.0
        self.h: dict[str, Any] = {
            "cycle": 0, "recreations": 0, "consecutive_cf": 0, "consecutive_failures": 0, "consecutive_empty": 0,
            "last_ok_ts": None, "last_nonempty_ts": None, "last_cycle_ts": None, "last_error": None,
            "listed": 0, "matched_total": 0, "filtered_total": 0, "seen": 0, "seeded": False,
        }
        self.seen: list[str] = []
        self.seen_set: set[str] = set()
        self.seeded_langs: set[str] = set()  # a language's first listing is only recorded, never imported
        self._load_state()

    # ---- state ----
    def _load_state(self) -> None:
        try:
            d = json.loads(self.state_file.read_text(encoding="utf-8"))
            self.seen = list(d.get("seen", []))[-MAX_REMEMBERED:]
            self.seeded_langs = set(d.get("seeded_langs", []))
        except (OSError, ValueError):
            self.seen = []
        self.h["seeded"] = bool(self.seeded_langs)
        self.seen_set = set(self.seen)
        self.h["seen"] = len(self.seen_set)

    def _save_state(self) -> None:
        try:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.state_file.with_suffix(".tmp")
            tmp.write_text(json.dumps({"seen": self.seen[-MAX_REMEMBERED:], "seeded_langs": sorted(self.seeded_langs)}), encoding="utf-8")
            os.replace(tmp, self.state_file)
        except OSError as e:
            log.warning("could not save %s: %s", self.state_file, e)

    def reset_seen(self) -> None:
        with self._lock:
            self.seen, self.seen_set, self.seeded_langs = [], set(), set()
            self.h["seeded"] = False
            self.h["seen"] = 0
            self._save_state()

    def _remember(self, slug: str) -> None:
        if slug not in self.seen_set:
            self.seen_set.add(slug)
            self.seen.append(slug)
            if len(self.seen) > MAX_REMEMBERED * 1.2:
                self.seen = self.seen[-MAX_REMEMBERED:]
                self.seen_set = set(self.seen)

    # ---- session ----
    def _sess(self, impersonate: str):
        from curl_cffi import requests as curl_requests

        if self._session is not None and time.time() - self._born > MAX_SESSION_AGE_S:
            self._refresh("max session age")
        if self._session is None:
            self._session = curl_requests.Session(impersonate=impersonate or "chrome")
            self._born = time.time()
        return self._session

    def _refresh(self, reason: str) -> None:
        events.log("fetch", f"recreating Workana session ({reason})", "warn")
        try:
            if self._session is not None:
                self._session.close()
        except Exception:
            pass
        self._session = None
        self.h["recreations"] += 1
        self.h["consecutive_cf"] = self.h["consecutive_failures"] = self.h["consecutive_empty"] = 0

    @staticmethod
    def _is_challenge(resp) -> bool:
        if resp.status_code in (403, 503):
            return True
        head = resp.content[:600].decode("utf-8", errors="replace").lower()
        return "just a moment" in head or "cf-browser-verification" in head

    def _get_list(self, lang: str, imp: str) -> list[dict] | None:
        """Returns the project list, [] when empty, None on failure."""
        try:
            resp = self._sess(imp).get(WORKANA_URL, params={"language": lang, "page": "1"}, headers=LIST_HEADERS, timeout=30)
        except Exception as e:
            self.h["consecutive_failures"] += 1
            self.h["last_error"] = f"network [{lang}]: {e}"
            events.log("fetch", f"network failure [{lang}]: {e}", "warn")
            if self.h["consecutive_failures"] >= FAILURE_LIMIT:
                self._refresh(f"{self.h['consecutive_failures']} network failures")
            return None
        if self._is_challenge(resp):
            self.h["consecutive_cf"] += 1
            self.h["last_error"] = f"Cloudflare challenge [{lang}] HTTP {resp.status_code}"
            events.log("fetch", f"Cloudflare challenge [{lang}] (#{self.h['consecutive_cf']})", "warn")
            if self.h["consecutive_cf"] >= CF_LIMIT:
                self._refresh(f"{self.h['consecutive_cf']} Cloudflare challenges")
            return None
        if resp.status_code != 200:
            self.h["consecutive_failures"] += 1
            self.h["last_error"] = f"HTTP {resp.status_code} [{lang}]"
            events.log("fetch", f"HTTP {resp.status_code} [{lang}]", "warn")
            if self.h["consecutive_failures"] >= FAILURE_LIMIT:
                self._refresh(f"{self.h['consecutive_failures']} HTTP failures")
            return None
        self.h["consecutive_failures"] = self.h["consecutive_cf"] = 0
        self.h["last_ok_ts"] = time.time()
        try:
            projects = resp.json()["results"]["results"]
            if not isinstance(projects, list):
                raise TypeError("results is not a list")
        except (ValueError, KeyError, TypeError) as e:
            self.h["last_error"] = f"unexpected response [{lang}]: {e}"
            events.log("fetch", f"unexpected Workana response [{lang}]: {e}", "warn")
            return None
        return projects

    def _job_page(self, slug: str, imp: str) -> dict[str, Any]:
        try:
            resp = self._sess(imp).get(f"https://www.workana.com/job/{slug}", headers=PAGE_HEADERS, timeout=20)
            if resp.status_code == 200:
                return parse_job_page(resp.text)
        except Exception as e:
            log.info("job page %s failed: %s", slug, e)
        return {}

    # ---- one cycle ----
    def _cycle(self) -> list[JobIn]:
        from ..services import settings_store

        with Session(engine) as s:
            f = settings_store.get(s, "workana_filters")
        langs = [l for l in f.get("languages") or ["es", "pt"] if l]
        imp = f.get("impersonate") or "chrome"
        with self._lock:
            self.h["cycle"] += 1
            self.h["last_cycle_ts"] = time.time()
            got_response = False
            listed = 0
            candidates: list[tuple[str, dict]] = []
            for lang in langs:
                projects = self._get_list(lang, imp)
                if projects is None:
                    continue
                got_response = True
                listed += len(projects)
                first_time = lang not in self.seeded_langs
                for p in projects:
                    slug = p.get("slug")
                    if not slug or slug in self.seen_set:
                        continue
                    if p.get("isSearchFeatured") and not f.get("include_featured"):
                        continue  # promoted (often old) posts; re-checked each cycle, like the old bot
                    self._remember(slug)
                    if not first_time:
                        candidates.append((lang, p))
                if first_time:
                    self.seeded_langs.add(lang)
                    events.log("fetch", f"first check for language '{lang}': recorded {len(projects)} listed jobs as seen; "
                                        "only jobs posted from now on will appear")
            self.h["listed"] = listed
            if got_response:
                if listed == 0:
                    self.h["consecutive_empty"] += 1
                    if self.h["consecutive_empty"] >= EMPTY_LIMIT:
                        self._refresh(f"{self.h['consecutive_empty']} empty cycles (possible soft block)")
                else:
                    self.h["consecutive_empty"] = 0
                    self.h["last_nonempty_ts"] = time.time()
            self.h["seeded"] = bool(self.seeded_langs)
            if not got_response and langs:
                self._save_state()
                raise RuntimeError(self.h["last_error"] or "all Workana requests failed")

            out: list[JobIn] = []
            for lang, p in candidates:
                title = full_title(p) or p["slug"]
                ok, why = budget_ok(p, f)
                if not ok:
                    self._filtered(f"{why}: {title[:60]} ({p.get('budget')})")
                    continue
                if not skills_ok(p, f):
                    self._filtered(f"skills: {title[:60]}")
                    continue
                info = self._job_page(p["slug"], imp) if f.get("check_job_page", True) else {}
                ok, why = client_ok(info, f)
                if not ok:
                    self._filtered(f"{why}: {title[:60]}")
                    continue
                out.append(self._to_job(lang, p, info))
                time.sleep(random.uniform(0.4, 1.2))  # gentle pacing between job-page requests
            self.h["matched_total"] += len(out)
            self.h["seen"] = len(self.seen_set)
            self.h["last_error"] = None if got_response else self.h["last_error"]
            self._save_state()
            return out

    def _filtered(self, msg: str) -> None:
        self.h["filtered_total"] += 1
        events.log("fetch", f"filtered ({msg})")

    @staticmethod
    def _to_job(lang: str, p: dict, info: dict) -> JobIn:
        desc, cat, sub = split_description(p.get("description") or "")
        lo, hi = parse_budget(p.get("budget") or "")
        client = {
            "language": lang,
            "country": country_name(p) or None,
            "client": (p.get("authorName") or "").strip() or None,
            "hourly": bool(p.get("isHourly")),
            "posted": strip_tags(p.get("postedDate")) or None,
            "subcategory": sub,
            "skill_slugs": sorted(skill_slugs(p)),
        }
        # From the list endpoint (verified Nov 2026): payment method verified + client rating.
        if isinstance(p.get("hasVerifiedPaymentMethod"), bool):
            client["payment_verified"] = p["hasVerifiedPaymentMethod"]
        try:
            rv = float((p.get("rating") or {}).get("value"))
            if rv > 0:
                client["rating"] = rv
        except (TypeError, ValueError, AttributeError):
            pass
        for k in ("status", "member_since", "member_since_text", "published", "paid", "bids", "interested",
                  "payment_verified", "client_profile"):
            if info.get(k) is not None:
                client[k] = info[k]
        client = {k: v for k, v in client.items() if v not in (None, "", [])}
        return JobIn(
            id=p["slug"], url=f"https://www.workana.com/job/{p['slug']}", title=full_title(p) or p["slug"],
            description=desc, budget_text=strip_tags(p.get("budget")) or "", budget_min=lo, budget_max=hi,
            category=cat, skills=[sk["anchorText"].strip() for sk in p.get("skills") or [] if sk.get("anchorText")],
            client_info=client,
        )

    # ---- JobFetcher API ----
    async def fetch_new(self) -> list[JobIn]:
        import asyncio

        return await asyncio.to_thread(self._cycle)

    def health(self) -> dict[str, Any]:
        h = dict(self.h)
        h["session_age_s"] = int(time.time() - self._born) if self._session is not None else 0
        return h
