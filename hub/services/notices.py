"""Workana messages / notifications reported by the Workana extensions.

The extension sends:
  {"type": "notice", "items": [{"kind": "message"|"notification", "key": "...", "title": "...",
                                "body": "...", "url": "https://www.workana.com/inbox/<job-slug>"}]}
  {"type": "counters", "messages": 2, "notifications": 1}

New items are stored (de-duplicated per account + key), shown on the dashboard (Inbox page, bell,
toast, sound, desktop notification), optionally forwarded to Telegram, and a client message on a job
you bid on marks that bid's outcome as "replied".
"""
from __future__ import annotations

import asyncio
import html
import re
from typing import Any, Optional

from sqlmodel import Session, select

from .. import events
from ..db import engine
from ..models import Account, Job, Notice, Submission, SubStatus, utcnow
from ..serialize import iso, notice_dict
from . import settings_store

_SLUG_RE = re.compile(r"workana\.com/(?:inbox|job|messages/bid)/([A-Za-z0-9_\-]+)")

# Live counters per account (unread messages / notifications as shown in Workana's header).
counters: dict[str, dict[str, Any]] = {}


def job_for_url(s: Session, url: str) -> Optional[str]:
    m = _SLUG_RE.search(url or "")
    if not m:
        return None
    slug = m.group(1)
    return slug if s.get(Job, slug) is not None else None


def _clean(v: Any, n: int) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()[:n]


_REJECTED_RE = re.compile(r"no fue aceptad|n[ãa]o foi aceit|was not accepted|not been accepted|fue rechazad|foi recusad", re.I)
_PROJECT_RE = re.compile(r"\b(?:en|em|in|on|no|na)\s+(.+)$", re.I)


def _norm_title(t: str) -> str:
    return re.sub(r"\W+", " ", (t or "").lower()).strip()


def _rejected_bid(s: Session, account_id: str, text: str) -> Optional[tuple[int, str]]:
    """'Tu propuesta no fue aceptada · En <project title>' -> mark that sent bid as rejected."""
    if not _REJECTED_RE.search(text or ""):
        return None
    m = _PROJECT_RE.search(_REJECTED_RE.split(text, maxsplit=1)[-1].strip())
    if not m:
        return None
    want = _norm_title(m.group(1).rstrip(".… "))
    if len(want) < 8:
        return None
    subs = s.exec(select(Submission).where(Submission.account_id == account_id, Submission.status == SubStatus.SENT)).all()
    for sub in subs:
        job = s.get(Job, sub.job_id)
        have = _norm_title(job.title if job else "")
        if have and (have == want or have.startswith(want) or want.startswith(have)):
            if sub.outcome in ("none", "replied"):
                sub.outcome = "rejected"
                s.add(sub)
                return (sub.id, sub.job_id)
            return None
    return None


def workana_notifications(account_id: Optional[str], items: list[dict[str, Any]]) -> int:
    """Workana's bell notifications: not shown on the dashboard, but 'Tu propuesta no fue aceptada · En <project>'
    marks that bid as rejected. Returns how many bids changed."""
    if not account_id or not items:
        return 0
    changed: list[tuple[int, str]] = []
    with Session(engine) as s:
        if not settings_store.get(s, "notifications").get("auto_outcome", True):
            return 0
        for it in items[:50]:
            sid = _rejected_bid(s, account_id, f"{it.get('title') or ''} {it.get('body') or ''}")
            if sid:
                changed.append(sid)
        s.commit()
        if changed:
            from ..state import submissions

            for sid, _job in changed:
                events.notify("submission_updated", submissions.submission_payload(s, s.get(Submission, sid)))
    for _sid, job_id in changed:
        events.log("submit", "Workana: proposal not accepted - outcome set to 'rejected'", job_id=job_id, account_id=account_id)
    return len(changed)


def add(account_id: Optional[str], items: list[dict[str, Any]], *, test: bool = False) -> list[dict[str, Any]]:
    """Store new notices. Returns the serialized new ones (already broadcast)."""
    out: list[dict[str, Any]] = []
    replied: list[tuple[int, str]] = []
    rejected: list[str] = []
    with Session(engine) as s:
        opts = settings_store.get(s, "notifications")
        for it in items[:50]:
            if not isinstance(it, dict):
                continue
            kind = it.get("kind") if it.get("kind") in ("message", "notification") else "notification"
            if test:
                kind = "test"
            key = _clean(it.get("key"), 300) or _clean(f"{it.get('title')}|{it.get('body')}", 300)
            url = _clean(it.get("url"), 500)
            if url and not url.startswith("https://www.workana.com/"):
                url = ""
            exists = s.exec(select(Notice.id).where(Notice.account_id == account_id, Notice.key == key)).first()
            if exists and not test:
                continue
            n = Notice(account_id=account_id, kind=kind, key=key, title=_clean(it.get("title"), 200) or kind,
                       body=_clean(it.get("body"), 1000), url=url, job_id=job_for_url(s, url))
            s.add(n)
            s.flush()
            # A client wrote on a job this account bid on -> the bid got a reply.
            if kind == "message" and n.job_id and account_id and opts.get("auto_outcome", True):
                sub = s.exec(select(Submission).where(Submission.job_id == n.job_id, Submission.account_id == account_id,
                                                      Submission.status == SubStatus.SENT)).first()
                if sub and sub.outcome == "none":
                    sub.outcome = "replied"
                    s.add(sub)
                    replied.append((sub.id, n.job_id))
            if kind == "notification" and account_id:
                sid = _rejected_bid(s, account_id, f"{it.get('title') or ''} {it.get('body') or ''}")
                if sid:
                    replied.append(sid)
                    rejected.append(sid[1])
            out.append(n)
        s.commit()
        payloads = [notice_dict(n) for n in out]
        if replied:
            from ..state import submissions

            for sid, _job in replied:
                sub = s.get(Submission, sid)
                events.notify("submission_updated", submissions.submission_payload(s, sub))
        names = {a.id: a.display_name or a.id for a in s.exec(select(Account)).all()}
    for job_id in rejected:  # logged after the commit (SQLite: one writer at a time)
        events.log("submit", "Workana: proposal not accepted - outcome set to 'rejected'", job_id=job_id, account_id=account_id)
    with Session(engine) as s:
        tg = settings_store.get(s, "telegram")
        forward = bool(opts.get("telegram")) and tg.get("enabled") and tg.get("bot_token") and tg.get("chat_ids")
    for d in payloads:
        who = names.get(d["account_id"], d["account_id"] or "")
        events.notify("notice_new", d)
        events.log("notice", f"{d['kind']} for {who}: {d['title']}"
                             f"{' - ' + d['body'][:120] if d['body'] else ''}", job_id=d["job_id"], account_id=d["account_id"])
    if forward and payloads:
        _forward_telegram(tg, payloads, names)
    return payloads


def _forward_telegram(tg: dict[str, Any], payloads: list[dict[str, Any]], names: dict[str, str]) -> None:
    from . import telegram

    e = html.escape
    for d in payloads:
        icon = {"message": "💬", "notification": "🔔"}.get(d["kind"], "🧪")
        lines = [f"{icon} <b>{e(names.get(d['account_id'], d['account_id'] or ''))}</b> · {e(d['title'])}"]
        if d["body"]:
            lines.append(e(d["body"][:600]))
        if d["url"]:
            lines.append(f'<a href="{e(d["url"])}">Open on Workana</a>')
        text = "\n".join(lines)
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(telegram.send(tg["bot_token"], telegram.chat_list(tg["chat_ids"]), text))
        except RuntimeError:
            pass


def set_counters(account_id: str, msg: dict[str, Any]) -> None:
    def num(v: Any) -> Optional[int]:
        try:
            return None if v is None else max(0, int(v))
        except (TypeError, ValueError):
            return None

    counters[account_id] = {
        "messages": num(msg.get("messages")),
        "notifications": num(msg.get("notifications")),
        "source": _clean(msg.get("source"), 40),
        "at": iso(utcnow()),
    }
    events.notify("counters", {"account_id": account_id, **counters[account_id]})


def rename(old: str, new: str) -> None:
    if old in counters:
        counters[new] = counters.pop(old)
