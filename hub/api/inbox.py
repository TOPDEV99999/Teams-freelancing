"""Dashboard inbox API: conversations of every account, their messages, reading and replying."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from .. import events
from ..db import engine, get_session
from ..models import Account
from ..services import inbox

router = APIRouter(prefix="/api/inbox", tags=["inbox"])


def _err(e: inbox.InboxError) -> HTTPException:
    return HTTPException(e.status, str(e))


@router.get("/conversations")
def conversations(account: Optional[str] = None, s: Session = Depends(get_session)):
    return {"items": inbox.list_conversations(s, account)}


@router.get("/{account_id}/{slug}")
def get_thread(account_id: str, slug: str, s: Session = Depends(get_session)):
    try:
        return inbox.thread(s, account_id, slug)
    except inbox.InboxError as e:
        raise _err(e)


@router.post("/{account_id}/{slug}/read")
def mark_read(account_id: str, slug: str, s: Session = Depends(get_session)):
    inbox.mark_read(s, account_id, slug)
    return {"ok": True}


@router.post("/{account_id}/{slug}/refresh")
async def refresh(account_id: str, slug: str):
    with Session(engine) as s:
        if s.get(Account, account_id) is None:
            raise HTTPException(404, "account not found")
    try:
        r = await inbox.request(account_id, "read", slug)
    except inbox.InboxError as e:
        raise _err(e)
    if not r.get("ok"):
        raise HTTPException(502, str(r.get("error") or "could not read the conversation"))
    with Session(engine) as s:
        out = inbox.thread(s, account_id, slug)
    out["recognised"] = len(((r.get("thread") or {}).get("messages")) or [])
    return out


class SendBody(BaseModel):
    text: str = Field(min_length=1, max_length=5000)


@router.post("/{account_id}/{slug}/send")
async def send(account_id: str, slug: str, body: SendBody):
    text = body.text.strip()
    if not text:
        raise HTTPException(422, "empty message")
    with Session(engine) as s:
        if s.get(Account, account_id) is None:
            raise HTTPException(404, "account not found")
    events.log("inbox", f"sending a reply on {slug} ({len(text)} characters)", account_id=account_id)
    try:
        r = await inbox.request(account_id, "send", slug, text=text, timeout=150)
    except inbox.InboxError as e:
        events.log("inbox", f"reply on {slug} failed: {e}", "error", account_id=account_id)
        raise _err(e)
    if not r.get("ok"):
        events.log("inbox", f"reply on {slug} NOT sent: {r.get('error')}", "error", account_id=account_id)
        raise HTTPException(502, str(r.get("error") or "the reply was not sent"))
    events.log("inbox", f"reply sent on {slug}" + ("" if r.get("verified") else " (could not verify it on the page)"),
               account_id=account_id)
    with Session(engine) as s:
        inbox.mark_read(s, account_id, slug)
        out = inbox.thread(s, account_id, slug)
    out["verified"] = bool(r.get("verified"))
    return out


@router.post("/{account_id}/check")
async def check(account_id: str):
    try:
        await inbox.refresh_list(account_id)
    except inbox.InboxError as e:
        raise _err(e)
    return {"ok": True}
