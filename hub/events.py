"""Event log (Logs page) + fire-and-forget broadcast to dashboards."""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from sqlmodel import Session, delete, select, func

from .db import engine
from .models import Event
from .ws.connection_manager import manager

logger = logging.getLogger("hub")

_loop: Optional[asyncio.AbstractEventLoop] = None
_tasks: set[asyncio.Task] = set()


def set_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def notify(type_: str, data: Any) -> None:
    """Broadcast to all dashboards. Safe to call from sync or async code."""
    coro = manager.broadcast_ui(type_, data)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:
        t = loop.create_task(coro)
        _tasks.add(t)
        t.add_done_callback(_tasks.discard)
    elif _loop is not None and _loop.is_running():
        asyncio.run_coroutine_threadsafe(coro, _loop)
    else:
        coro.close()


def log(kind: str, message: str, level: str = "info", job_id: str | None = None, account_id: str | None = None) -> None:
    getattr(logger, {"warn": "warning"}.get(level, level), logger.info)("[%s] %s", kind, message)
    with Session(engine) as s:
        ev = Event(kind=kind, level=level, message=message, job_id=job_id, account_id=account_id)
        s.add(ev)
        s.commit()
        s.refresh(ev)
        data = event_dict(ev)
    notify("log", data)


def event_dict(ev: Event) -> dict[str, Any]:
    return {
        "id": ev.id,
        "ts": ev.ts.isoformat() + "Z",
        "kind": ev.kind,
        "level": ev.level,
        "message": ev.message,
        "job_id": ev.job_id,
        "account_id": ev.account_id,
    }


def trim(keep: int = 5000) -> None:
    with Session(engine) as s:
        total = s.exec(select(func.count()).select_from(Event)).one()
        if total <= keep:
            return
        cutoff = s.exec(select(Event.id).order_by(Event.id.desc()).offset(keep).limit(1)).first()
        if cutoff is not None:
            s.exec(delete(Event).where(Event.id <= cutoff))
            s.commit()
