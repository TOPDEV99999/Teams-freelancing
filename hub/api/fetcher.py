"""Fetcher controls + health (Fetcher page) and the Telegram test button."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlmodel import Session

from .. import events
from ..db import get_session
from ..services import settings_store, telegram
from ..services.ingest import fetch_control

router = APIRouter(prefix="/api", tags=["fetcher"])


@router.get("/fetcher")
def fetcher_status():
    return fetch_control.status()


def _set_enabled(s: Session, on: bool) -> dict:
    settings_store.set_many(s, {"fetcher_enabled": on})
    events.log("fetch", "fetcher started" if on else "fetcher stopped")
    fetch_control.wake()
    return fetch_control.status()


@router.post("/fetcher/start")
def fetcher_start(s: Session = Depends(get_session)):
    return _set_enabled(s, True)


@router.post("/fetcher/stop")
def fetcher_stop(s: Session = Depends(get_session)):
    return _set_enabled(s, False)


@router.post("/fetcher/check")
def fetcher_check():
    if fetch_control.fetcher is None:
        raise HTTPException(409, "no fetcher is running (FETCHER=none in .env)")
    fetch_control.check_now()
    return fetch_control.status()


@router.post("/fetcher/reset-seen")
def fetcher_reset_seen():
    f = fetch_control.fetcher
    if f is None or not hasattr(f, "reset_seen"):
        raise HTTPException(409, "the current fetcher has no seen list")
    f.reset_seen()
    events.log("fetch", "seen list cleared - next check records the current listing again")
    return fetch_control.status()


@router.post("/telegram/test")
async def telegram_test(body: dict[str, Any] = Body(...)):
    token = str(body.get("bot_token") or "").strip()
    chats = telegram.chat_list(str(body.get("chat_ids") or ""))
    if not token or not chats:
        raise HTTPException(422, "bot token and at least one chat ID are required")
    res = await telegram.send(token, chats, "✅ <b>Workana Assistant — test message</b>\n\nYour token and chat ID work.")
    failed = {k: v for k, v in res.items() if v != "ok"}
    return {"ok": not failed, "sent": len(res) - len(failed), "total": len(res),
            "error": "; ".join(f"{k}: {v}" for k, v in failed.items()) or None}
