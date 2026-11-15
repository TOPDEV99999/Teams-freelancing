from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from .. import events
from ..db import get_session
from ..models import Job, OUTCOMES, Submission
from ..serialize import job_dict
from ..services.submission_queue import SendError
from ..state import submissions
from ..ws.connection_manager import manager

router = APIRouter(prefix="/api", tags=["submissions"])


@router.get("/submissions")
def list_submissions(account: Optional[str] = None, status: Optional[str] = None, limit: int = 500,
                     s: Session = Depends(get_session)):
    stmt = select(Submission)
    if account:
        stmt = stmt.where(Submission.account_id == account)
    if status:
        stmt = stmt.where(Submission.status == status)
    stmt = stmt.order_by(Submission.requested_at.desc()).limit(max(1, min(limit, 2000)))
    out = []
    for sub in s.exec(stmt).all():
        d = submissions.submission_payload(s, sub)
        job = s.get(Job, sub.job_id)
        d["job_title"] = job.title if job else ""
        d["job_url"] = job.url if job else ""
        out.append(d)
    return out


class OutcomeBody(BaseModel):
    outcome: str


@router.patch("/submissions/{sid}")
def set_outcome(sid: int, body: OutcomeBody, s: Session = Depends(get_session)):
    if body.outcome not in OUTCOMES:
        raise HTTPException(422, f"outcome must be one of {OUTCOMES}")
    sub = s.get(Submission, sid)
    if sub is None:
        raise HTTPException(404, "submission not found")
    sub.outcome = body.outcome
    s.add(sub)
    s.commit()
    s.refresh(sub)
    payload = submissions.submission_payload(s, sub)
    events.notify("submission_updated", payload)
    return payload


def _wrap(fn):
    try:
        return fn()
    except SendError as e:
        raise HTTPException(e.status_code, str(e))


@router.post("/submissions/{sid}/retry")
def retry(sid: int, s: Session = Depends(get_session)):
    sub = _wrap(lambda: submissions.retry(s, sid))
    events.log("submit", f"submission #{sid} re-queued", job_id=sub.job_id, account_id=sub.account_id)
    payload = submissions.submission_payload(s, sub)
    events.notify("submission_updated", payload)
    job = s.get(Job, sub.job_id)
    if job:
        events.notify("job_updated", job_dict(job, s))
    return payload


@router.post("/submissions/{sid}/cancel")
async def cancel(sid: int, s: Session = Depends(get_session)):
    job, notify = _wrap(lambda: submissions.cancel(s, sid))
    if notify:  # it was already in the browser: tell that profile's extension to stop
        conn = manager.get_workana(notify)
        if conn is not None:
            try:
                await conn.send({"type": "cancel", "submission_id": sid})
            except Exception:  # noqa: BLE001 - extension gone; nothing else to do
                pass
    events.log("submit", f"submission #{sid} cancelled{' while sending' if notify else ''}",
               job_id=job.id if job else None, account_id=notify)
    if job:
        events.notify("job_updated", job_dict(job, s))
        events.notify("submission_deleted", {"id": sid, "job_id": job.id})
    return {"cancelled": sid}


@router.post("/submissions/{sid}/release")
def release(sid: int, s: Session = Depends(get_session)):
    """End the auto-send review window now."""
    sub = _wrap(lambda: submissions.release(s, sid))
    events.log("submit", f"submission #{sid} released from its review window", job_id=sub.job_id, account_id=sub.account_id)
    payload = submissions.submission_payload(s, sub)
    events.notify("submission_updated", payload)
    return payload


@router.post("/submissions/{sid}/mark-sent")
def mark_sent(sid: int, s: Session = Depends(get_session)):
    sub = _wrap(lambda: submissions.mark_sent(s, sid))
    events.log("submit", f"submission #{sid} marked as SENT manually", job_id=sub.job_id, account_id=sub.account_id)
    payload = submissions.submission_payload(s, sub)
    events.notify("submission_updated", payload)
    job = s.get(Job, sub.job_id)
    if job:
        events.notify("job_updated", job_dict(job, s))
    return payload
