"""Dashboard inbox: every account's Workana conversations, read and answered through that account's extension.

Flow
  hub  -> extension  {"type": "inbox_read", "id": ..., "slug": ...}
                     {"type": "inbox_send", "id": ..., "slug": ..., "text": ...}
                     {"type": "inbox_refresh"}                       (reload the inbox list tab)
  extension -> hub   {"type": "inbox_list", "items": [{slug, url, name, snippet, unread}]}
                     {"type": "inbox_result", "id": ..., "ok": bool, "error": str, "thread": {...}}
                     {"type": "snapshot", "page": ..., "outline": ...}   (page structure, to tune selectors)

The extension opens the conversation in a background tab of that account's own browser profile, reads it
(or types the reply and clicks Workana's send button), and closes the tab - the same thing a person does.
"""
from __future__ import annotations

import asyncio
import hashlib
import re
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional

from sqlmodel import Session, delete, select

from .. import events
from ..config import ROOT
from ..db import engine
from ..models import Conversation, Job, Message, Submission, SubStatus, utcnow
from ..serialize import iso
from ..ws.connection_manager import manager

SLUG_RE = re.compile(r"^[A-Za-z0-9_\-]{2,200}$")
_pending: dict[str, asyncio.Future] = {}
_last_auto: dict[tuple[str, str], datetime] = {}
AUTO_READ_GAP = timedelta(minutes=3)  # never auto-open the same conversation more often than this


class InboxError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _clean(v: Any, n: int) -> str:
    return re.sub(r"[ \t]+", " ", str(v or "")).strip()[:n]


def has_client_message(s: Session, c: Conversation) -> bool:
    return s.exec(select(Message.id).where(Message.account_id == c.account_id, Message.slug == c.slug,
                                           Message.mine == False)).first() is not None  # noqa: E712


def conv_dict(c: Conversation, s: Optional[Session] = None, last: Optional[Message] = None) -> dict[str, Any]:
    job = s.get(Job, c.slug) if s is not None else None
    return {
        "has_client": has_client_message(s, c) if s is not None else False,
        "id": c.id, "account_id": c.account_id, "slug": c.slug, "name": c.name, "title": c.title or (job.title if job else ""),
        "snippet": c.snippet, "unread": c.unread, "updated_at": iso(c.updated_at), "synced_at": iso(c.synced_at),
        "last_error": c.last_error, "job_id": job.id if job else None,
        "url": f"https://www.workana.com/inbox/{c.slug}",
        "last": msg_dict(last) if last else None,
    }


def msg_dict(m: Message) -> dict[str, Any]:
    return {"id": m.id, "pos": m.pos, "author": m.author, "mine": m.mine, "text": m.text, "time": m.time_text,
            "first_seen": iso(m.first_seen)}


def _get(s: Session, account_id: str, slug: str, create: bool = True) -> Optional[Conversation]:
    c = s.exec(select(Conversation).where(Conversation.account_id == account_id, Conversation.slug == slug)).first()
    if c is None and create:
        c = Conversation(account_id=account_id, slug=slug)
        s.add(c)
        s.flush()
    return c


def ensure_from_bids(s: Session, days: int = 60) -> None:
    """Every sent bid has a conversation (/inbox/<job-slug>) even before Workana's inbox list was read."""
    since = utcnow() - timedelta(days=days)
    subs = s.exec(select(Submission).where(Submission.status == SubStatus.SENT, Submission.requested_at >= since)).all()
    have = {(c.account_id, c.slug) for c in s.exec(select(Conversation)).all()}
    added = False
    for sub in subs:
        if (sub.account_id, sub.job_id) in have:
            continue
        job = s.get(Job, sub.job_id)
        s.add(Conversation(account_id=sub.account_id, slug=sub.job_id, title=job.title if job else "",
                           updated_at=sub.sent_at or sub.requested_at))
        have.add((sub.account_id, sub.job_id))
        added = True
    if added:
        s.commit()


def list_conversations(s: Session, account: Optional[str] = None, client_only: bool = True) -> list[dict[str, Any]]:
    """Conversations for the dashboard. client_only (default): only projects where a CLIENT has written."""
    ensure_from_bids(s)
    stmt = select(Conversation)
    if account:
        stmt = stmt.where(Conversation.account_id == account)
    if client_only:
        stmt = stmt.where(select(Message.id).where(Message.account_id == Conversation.account_id,
                                                   Message.slug == Conversation.slug,
                                                   Message.mine == False).exists())  # noqa: E712
    rows = s.exec(stmt.order_by(Conversation.updated_at.desc()).limit(500)).all()
    out = []
    for c in rows:
        last = s.exec(select(Message).where(Message.account_id == c.account_id, Message.slug == c.slug)
                      .order_by(Message.pos.desc())).first()
        out.append(conv_dict(c, s, last))
    return out


def hidden_count(s: Session, account: Optional[str] = None) -> int:
    """Conversations not shown because no client message has been seen in them (yet)."""
    total = len(s.exec(select(Conversation.id).where(*( [Conversation.account_id == account] if account else []))).all())
    return max(0, total - len(list_conversations(s, account, client_only=True)))


_norm_re = re.compile(r"[^a-z0-9]+")


def _norm(t: str) -> str:
    import unicodedata

    return _norm_re.sub(" ", unicodedata.normalize("NFKC", t or "").lower()).strip()


def looks_like_own_proposal(s: Session, c: Conversation) -> bool:
    """Workana's latest line in the list is just the proposal you sent (nobody else has written)."""
    snip = _norm(c.snippet.rstrip(".… "))[:60]
    if not snip:
        return True
    sub = s.exec(select(Submission).where(Submission.job_id == c.slug, Submission.account_id == c.account_id)).first()
    if sub is None:
        return False
    own = _norm(sub.final_text)
    return own.startswith(snip[:40]) or snip.startswith(own[:40])


def sweep_candidate(s: Session, account_id: str) -> Optional[str]:
    """A not-yet-read conversation that probably has a client message (its latest line isn't your proposal)."""
    rows = s.exec(select(Conversation).where(Conversation.account_id == account_id, Conversation.synced_at == None)  # noqa: E711
                  .order_by(Conversation.updated_at.desc()).limit(300)).all()
    for c in rows:
        if _last_auto.get((account_id, c.slug), datetime.min) > utcnow() - timedelta(hours=6):
            continue  # tried recently
        if c.unread or not looks_like_own_proposal(s, c):
            return c.slug
    return None


SWEEP_SECONDS = 90


async def sweep_loop() -> None:
    """Gently finds conversations where a client wrote: one conversation per account every ~90 s."""
    import random

    while True:
        await asyncio.sleep(SWEEP_SECONDS * random.uniform(0.8, 1.2))
        try:
            for account_id in list(manager.workana.keys()):
                with Session(engine) as s:
                    slug = sweep_candidate(s, account_id)
                if slug:
                    _last_auto[(account_id, slug)] = utcnow()
                    asyncio.get_running_loop().create_task(_safe_request(account_id, "read", slug))
        except Exception as e:  # noqa: BLE001 - never stop the loop
            events.log("inbox", f"inbox sweep error: {e!r}", "warn")


def thread(s: Session, account_id: str, slug: str) -> dict[str, Any]:
    c = _get(s, account_id, slug, create=False)
    if c is None:
        raise InboxError(404, "conversation not found")
    msgs = s.exec(select(Message).where(Message.account_id == account_id, Message.slug == slug).order_by(Message.pos)).all()
    return {"conversation": conv_dict(c, s), "messages": [msg_dict(m) for m in msgs]}


def mark_read(s: Session, account_id: str, slug: str) -> None:
    c = _get(s, account_id, slug, create=False)
    if c is not None and c.unread:
        c.unread = False
        s.add(c)
        s.commit()
        events.notify("inbox_conversation", conv_dict(c, s))


# ---------------------------------------------------------------- from the extension
def on_list(account_id: str, items: list[dict[str, Any]]) -> None:
    """Workana's inbox list was read: update conversations; changed ones get their messages read."""
    changed: list[str] = []
    with Session(engine) as s:
        for it in items[:200]:
            if not isinstance(it, dict):
                continue
            slug = _clean(it.get("slug"), 200)
            if not SLUG_RE.match(slug):
                continue
            existed = _get(s, account_id, slug, create=False) is not None
            c = _get(s, account_id, slug)
            snippet = _clean(it.get("snippet"), 400)
            name = _clean(it.get("name"), 120)
            title = _clean(it.get("title"), 200)
            unread = bool(it.get("unread"))
            if title and not c.title:
                c.title = title
                s.add(c)
            if snippet != c.snippet or unread != c.unread or (name and name != c.name):
                if snippet and snippet != c.snippet:
                    c.updated_at = utcnow()
                    # Read it now - except conversations seen for the first time that have nothing unread.
                    if existed or unread:
                        changed.append(slug)
                c.snippet, c.unread = snippet or c.snippet, unread
                if name and not c.name:
                    c.name = name
                s.add(c)
                s.commit()
                events.notify("inbox_conversation", conv_dict(c, s))
    # Read the conversations that changed (one after another, in the background tab of that profile).
    for slug in changed[:5]:
        key = (account_id, slug)
        if utcnow() - _last_auto.get(key, datetime.min) < AUTO_READ_GAP:
            continue
        _last_auto[key] = utcnow()
        asyncio.get_running_loop().create_task(_safe_request(account_id, "read", slug))


async def _safe_request(account_id: str, op: str, slug: str) -> None:
    try:
        await request(account_id, op, slug)
    except Exception:  # noqa: BLE001 - errors are stored on the conversation
        pass


def on_result(account_id: str, msg: dict[str, Any]) -> None:
    fut = _pending.pop(str(msg.get("id")), None)
    th = msg.get("thread") if isinstance(msg.get("thread"), dict) else None
    slug = _clean(msg.get("slug") or (th or {}).get("slug"), 200)
    if SLUG_RE.match(slug or ""):
        from . import notices

        new_notices: list[dict[str, Any]] = []
        with Session(engine) as s:
            c = _get(s, account_id, slug)
            c.last_error = "" if msg.get("ok") else _clean(msg.get("error"), 300)
            if th is not None:
                new_notices = store_thread(s, c, th)  # may set last_error (page not recognised)
            s.add(c)
            s.commit()
            events.notify("inbox_conversation", conv_dict(c, s))
            events.notify("inbox_thread", {"account_id": account_id, "slug": slug})
        if new_notices:  # after the commit: SQLite allows one writer at a time
            rest = _merge_recent(account_id, slug, new_notices)
            if rest:
                notices.add(account_id, rest)
    if fut is not None and not fut.done():
        fut.set_result(msg)


def _merge_recent(account_id: str, slug: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The inbox-list watcher usually announced this message a moment ago (with a one-line preview): put the
    full text into that notice instead of ringing twice. Returns the items that still need a new notice."""
    from ..models import Notice
    from ..serialize import notice_dict

    url = f"https://www.workana.com/inbox/{slug}"
    with Session(engine) as s:
        recent = s.exec(select(Notice).where(Notice.account_id == account_id, Notice.url == url, Notice.kind == "message",
                                             Notice.ts >= utcnow() - timedelta(minutes=15))
                        .order_by(Notice.id.desc())).first()
        if recent is None or recent.key.startswith("msg:"):
            return items
        last = items[-1]
        recent.title, recent.body, recent.key = last["title"], last["body"], last["key"]
        s.add(recent)
        s.commit()
        events.notify("notice_updated", notice_dict(recent))
    return items[:-1]


def _key(author: str, text: str, time_text: str, mine: bool) -> str:
    return hashlib.sha1(f"{mine}|{author}|{time_text}|{text}".encode("utf-8")).hexdigest()


def store_thread(s: Session, c: Conversation, th: dict[str, Any]) -> list[dict[str, Any]]:
    """Replace the stored messages with what the page shows. Returns the notices for new client messages."""
    if th.get("method") != "workana":
        # Only Workana's verified markup is trusted. The generic fallback (and extensions older than 1.3.2) once
        # stored the conversation LIST as messages - never again: keep what we have and report it.
        c.last_error = "conversation page not recognised - its layout was saved to data/snapshots for tuning"
        return []
    msgs = [m for m in (th.get("messages") or []) if isinstance(m, dict) and _clean(m.get("text"), 8000)]
    if th.get("title") and not c.title:
        c.title = _clean(th.get("title"), 200)
    if th.get("name"):
        c.name = _clean(th.get("name"), 120)
    first_sync = c.synced_at is None
    c.synced_at = utcnow()
    c.parsed_v = 2
    if not msgs:
        return []  # nothing recognised: keep what we had (the capture lets the selectors be fixed)
    old = {m.key: m for m in s.exec(select(Message).where(Message.account_id == c.account_id, Message.slug == c.slug)).all()}
    fresh: list[Message] = []
    keep: set[str] = set()
    for pos, m in enumerate(msgs[-200:]):
        author, text, tt, mine = _clean(m.get("author"), 120), str(m.get("text") or "").strip()[:8000], _clean(m.get("time"), 60), bool(m.get("mine"))
        k = _key(author, text, tt, mine)
        if k in keep:
            k = f"{k}:{pos}"
        keep.add(k)
        row = old.get(k)
        if row is None:
            row = Message(account_id=c.account_id, slug=c.slug, key=k, author=author, mine=mine, text=text, time_text=tt)
            fresh.append(row)
        row.pos = pos
        s.add(row)
    for k, row in old.items():
        if k not in keep:
            s.delete(row)
    last = msgs[-1]
    c.snippet = _clean(last.get("text"), 400)
    if fresh:
        c.updated_at = utcnow()
    s.flush()
    incoming = [m for m in fresh if not m.mine]
    if first_sync:
        incoming = incoming[-1:] if c.unread else []  # first read: don't flood the bell with old messages
    return [{
        "kind": "message", "key": f"msg:{c.slug}:{m.key}"[:300],
        "title": m.author or c.name or "New message", "body": m.text[:1000],
        "url": f"https://www.workana.com/inbox/{c.slug}",
    } for m in incoming[-5:]]


# ---------------------------------------------------------------- commands to the extension
async def request(account_id: str, op: str, slug: str, text: str = "", timeout: float = 120.0) -> dict[str, Any]:
    if not SLUG_RE.match(slug or ""):
        raise InboxError(400, "invalid conversation id")
    conn = manager.get_workana(account_id)
    if conn is None:
        raise InboxError(409, f"the Workana extension of '{account_id}' is not connected - start that browser profile")
    rid = uuid.uuid4().hex[:12]
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    _pending[rid] = fut
    msg: dict[str, Any] = {"type": "inbox_send" if op == "send" else "inbox_read", "id": rid, "slug": slug}
    if op == "send":
        msg["text"] = text
    try:
        await conn.send(msg)
        return await asyncio.wait_for(fut, timeout=timeout)
    except asyncio.TimeoutError:
        raise InboxError(504, "no answer from the extension in time (is the browser profile busy or asleep?)")
    finally:
        _pending.pop(rid, None)


async def refresh_list(account_id: str) -> None:
    conn = manager.get_workana(account_id)
    if conn is None:
        raise InboxError(409, f"the Workana extension of '{account_id}' is not connected")
    await conn.send({"type": "inbox_refresh"})


# ---------------------------------------------------------------- housekeeping
def rename(old: str, new: str) -> None:
    for k in [k for k in _last_auto if k[0] == old]:
        _last_auto[(new, k[1])] = _last_auto.pop(k)


def drop_account(s: Session, account_id: str) -> None:
    s.exec(delete(Message).where(Message.account_id == account_id))
    s.exec(delete(Conversation).where(Conversation.account_id == account_id))


SNAP_DIR = ROOT / "data" / "snapshots"


def save_snapshot(account_id: Optional[str], msg: dict[str, Any]) -> Optional[Path]:
    """Page structure from the extension (tags/classes, no long texts) - used to tune Workana selectors."""
    page = re.sub(r"[^a-z]", "", str(msg.get("page") or "page"))[:20] or "page"
    outline = str(msg.get("outline") or "")[:400000]
    if not outline:
        return None
    SNAP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = utcnow().strftime("%Y%m%d-%H%M%S")
    path = SNAP_DIR / f"{stamp}_{account_id or 'ext'}_{page}.txt"
    head = f"# page={page} path={_clean(msg.get('path'), 300)} reason={_clean(msg.get('reason'), 300)}\n"
    path.write_text(head + outline, encoding="utf-8")
    files = sorted(SNAP_DIR.glob("*.txt"))
    for old in files[:-60]:
        try:
            old.unlink()
        except OSError:
            pass
    events.log("ext", f"page structure saved for tuning: data/snapshots/{path.name} ({_clean(msg.get('reason'), 120)})",
               account_id=account_id)
    return path
