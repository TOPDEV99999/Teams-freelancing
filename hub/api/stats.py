from __future__ import annotations

from collections import defaultdict
from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from ..db import get_session
from ..models import Submission, SubStatus, utcnow

router = APIRouter(prefix="/api", tags=["stats"])

_REPLY = {"replied", "interview", "hired"}


def _bucket() -> dict:
    return {"sent": 0, "replied": 0, "interview": 0, "hired": 0, "rejected": 0, "failed": 0}


def _finish(b: dict) -> dict:
    sent = b["sent"]
    b["reply_rate"] = round(b["replied"] / sent, 4) if sent else 0.0
    b["hire_rate"] = round(b["hired"] / sent, 4) if sent else 0.0
    return b


@router.get("/stats")
def stats(days: int = 90, s: Session = Depends(get_session)):
    since = utcnow() - timedelta(days=max(1, days))
    subs = s.exec(select(Submission).where(Submission.requested_at >= since)).all()
    by_account: dict[str, dict] = defaultdict(_bucket)
    by_style: dict[str, dict] = defaultdict(_bucket)
    matrix: dict[tuple[str, str], dict] = defaultdict(_bucket)
    daily: dict[str, int] = defaultdict(int)
    for sub in subs:
        style = sub.style or "custom"
        targets = (by_account[sub.account_id], by_style[style], matrix[(sub.account_id, style)])
        if sub.status == SubStatus.FAILED:
            for t in targets:
                t["failed"] += 1
            continue
        if sub.status != SubStatus.SENT:
            continue
        daily[(sub.sent_at or sub.requested_at).date().isoformat()] += 1
        for t in targets:
            t["sent"] += 1
            if sub.outcome in _REPLY:
                t["replied"] += 1
            if sub.outcome in ("interview", "hired"):
                t["interview"] += 1
            if sub.outcome == "hired":
                t["hired"] += 1
            if sub.outcome == "rejected":
                t["rejected"] += 1
    return {
        "days": days,
        "by_account": [{"account_id": k, **_finish(v)} for k, v in sorted(by_account.items())],
        "by_style": [{"style": k, **_finish(v)} for k, v in sorted(by_style.items())],
        "by_account_style": [{"account_id": a, "style": st, **_finish(v)} for (a, st), v in sorted(matrix.items())],
        "daily_sent": [{"date": d, "sent": n} for d, n in sorted(daily.items())],
    }
