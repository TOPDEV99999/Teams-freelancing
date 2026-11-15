from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session, select

from .. import events
from ..db import get_session
from ..models import Notice
from ..serialize import notice_dict
from ..services import notices as notice_service

router = APIRouter(prefix="/api", tags=["notices"])


@router.get("/notices")
def list_notices(account: Optional[str] = None, unread: bool = False, limit: int = 300,
                 s: Session = Depends(get_session)):
    stmt = select(Notice)
    if account:
        stmt = stmt.where(Notice.account_id == account)
    if unread:
        stmt = stmt.where(Notice.read == False)  # noqa: E712
    stmt = stmt.order_by(Notice.id.desc()).limit(max(1, min(limit, 1000)))
    return {"items": [notice_dict(n) for n in s.exec(stmt).all()], "counters": notice_service.counters}


class ReadBody(BaseModel):
    ids: Optional[list[int]] = None
    all: bool = False
    read: bool = True


@router.post("/notices/read")
def mark_read(body: ReadBody, s: Session = Depends(get_session)):
    stmt = select(Notice)
    if not body.all:
        stmt = stmt.where(Notice.id.in_(body.ids or []))
    n = 0
    for row in s.exec(stmt).all():
        if row.read != body.read:
            row.read = body.read
            s.add(row)
            n += 1
    s.commit()
    events.notify("notices_read", {"ids": body.ids, "all": body.all, "read": body.read})
    return {"updated": n}


class TestBody(BaseModel):
    account_id: Optional[str] = None


@router.post("/notices/test")
def test_notice(body: Optional[TestBody] = None):
    """Creates a fake notice to check the dashboard alert, sound, desktop notification and Telegram forwarding."""
    acc = body.account_id if body else None
    items = notice_service.add(acc, [{
        "kind": "message", "key": "test", "title": "Test notification",
        "body": "If you can see (and hear) this, Workana notices reach the dashboard.",
        "url": "https://www.workana.com/inbox",
    }], test=True)
    return {"created": len(items)}


@router.delete("/notices")
def clear(only_read: bool = False, s: Session = Depends(get_session)):
    from ..services.cleanup import clear_notices

    n = clear_notices(s, only_read=only_read)
    events.notify("notices_cleared", {"only_read": only_read})
    return {"deleted": n}
