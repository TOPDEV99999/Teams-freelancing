"""Data page: storage stats, deleting history (jobs, drafts, logs, notices, ChatGPT chats), backup,
and the always-available Cancel (activity) controls."""
from __future__ import annotations

import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .. import events
from ..db import get_session
from ..models import Job, Submission, SubStatus
from ..serialize import job_dict
from ..services import cleanup
from ..state import generation, submissions
from ..ws.connection_manager import manager

router = APIRouter(prefix="/api", tags=["maintenance"])


@router.get("/maintenance/stats")
def stats(s: Session = Depends(get_session)):
    from ..services import settings_store

    return {**cleanup.stats(s), "retention_last_run": settings_store.get(s, "retention_last_run")}


class Age(BaseModel):
    older_than_days: int = Field(default=0, ge=0, le=3650)


@router.post("/maintenance/logs/clear")
def clear_logs(body: Age, s: Session = Depends(get_session)):
    n = cleanup.clear_logs(s, body.older_than_days)
    events.notify("logs_cleared", {"older_than_days": body.older_than_days})
    if body.older_than_days:
        events.log("system", f"{n} log line(s) older than {body.older_than_days} day(s) deleted")
    return {"deleted": n}


class JobPurge(Age):
    statuses: list[str] = Field(default_factory=list)
    keep_sent: bool = True


@router.post("/maintenance/jobs/purge")
def purge_jobs(body: JobPurge, s: Session = Depends(get_session)):
    r = cleanup.purge_jobs(s, body.older_than_days, body.statuses, body.keep_sent)
    kept = f", {len(r['kept'])} kept (busy)" if r["kept"] else ""
    events.log("system", f"job history: {len(r['deleted'])} job(s) deleted{kept}")
    return {"deleted": len(r["deleted"]), "kept": len(r["kept"])}


@router.post("/maintenance/drafts/purge")
def purge_drafts(body: Age, s: Session = Depends(get_session)):
    n = cleanup.purge_drafts(s, body.older_than_days)
    events.log("system", f"{n} old generated proposal(s) deleted")
    return {"deleted": n}


@router.post("/maintenance/notices/clear")
def clear_notices(body: Age, s: Session = Depends(get_session)):
    n = cleanup.clear_notices(s, body.older_than_days)
    events.notify("notices_cleared", {})
    return {"deleted": n}


@router.post("/maintenance/vacuum")
def vacuum(s: Session = Depends(get_session)):
    before = cleanup.stats(s)["db_bytes"]
    s.close()
    cleanup.vacuum()
    with Session(cleanup.engine) as s2:
        after = cleanup.stats(s2)["db_bytes"]
    return {"before": before, "after": after}


@router.post("/maintenance/retention/run")
def run_retention():
    return cleanup.run_retention(force=True) or {}


@router.get("/maintenance/backup")
def backup(tasks: BackgroundTasks):
    tmp = Path(tempfile.mkdtemp(prefix="wa-backup-")) / "hub.db"
    try:
        cleanup.backup_to(tmp)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"backup failed: {e}")
    tasks.add_task(lambda: (tmp.unlink(missing_ok=True), tmp.parent.rmdir()))
    name = f"workana-assistant-backup-{datetime.now():%Y%m%d-%H%M}.db"
    return FileResponse(tmp, filename=name, media_type="application/octet-stream")


class ChatsBody(BaseModel):
    scope: str = "assistant"  # only chats the assistant created


@router.post("/maintenance/chatgpt/delete-chats")
async def delete_chatgpt_chats(body: Optional[ChatsBody] = None):
    """Ask the ChatGPT extension to delete the ChatGPT conversations it created (ChatGPT history)."""
    if manager.chatgpt is None:
        raise HTTPException(409, "the ChatGPT extension is not connected")
    if generation.current:
        raise HTTPException(409, "ChatGPT is writing a proposal right now - try again when it is done")
    try:
        r = await generation.chatgpt.command({"type": "delete_chats", "scope": (body.scope if body else "assistant")},
                                             timeout=180)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e))
    if r.get("error"):
        raise HTTPException(502, r["error"])
    events.log("system", f"ChatGPT history: {r.get('deleted', 0)} chat(s) deleted"
                         f"{', ' + str(r.get('failed')) + ' failed' if r.get('failed') else ''}")
    return r


# ---------------------------------------------------------------- activity + Cancel (always available)

def _activity(s: Session) -> dict:
    gen = generation.status()
    subs = submissions.active(s)
    out = []
    for sub in subs:
        d = submissions.submission_payload(s, sub)
        job = s.get(Job, sub.job_id)
        d["job_title"] = job.title if job else sub.job_id
        out.append(d)
    queued_gen = []
    for item in gen["queued"]:
        jid, _, acc = item.partition(":")
        job = s.get(Job, jid)
        queued_gen.append({"job_id": jid, "account_id": acc, "job_title": job.title if job else jid})
    cur = None
    if gen["current"]:
        job = s.get(Job, gen["current"])
        cur = {"job_id": gen["current"], "account_id": gen["current_account"], "job_title": job.title if job else gen["current"]}
    auto_jobs = [{"job_id": j.id, "job_title": j.title} for j in s.exec(select(Job).where(
        Job.auto_send == True, Job.status.in_(["new", "generating", "drafted"]))).all()]  # noqa: E712
    return {"generation": {"current": cur, "queued": queued_gen, "next_at": gen["next_at"]},
            "submissions": out, "auto_jobs": auto_jobs}


@router.get("/activity")
def activity(s: Session = Depends(get_session)):
    return _activity(s)


class CancelAll(BaseModel):
    generation: bool = True
    submissions: bool = True
    auto_send: bool = True  # also switch Auto-send off on jobs still waiting for drafts


@router.post("/control/cancel-all")
async def cancel_all(body: Optional[CancelAll] = None, s: Session = Depends(get_session)):
    body = body or CancelAll()
    res = {"generations": 0, "submissions": 0, "auto_send_off": 0}
    touched: set[str] = set()
    if body.auto_send:
        for job in s.exec(select(Job).where(Job.auto_send == True)).all():  # noqa: E712
            job.auto_send = False
            s.add(job)
            touched.add(job.id)
            res["auto_send_off"] += 1
        s.commit()
    if body.generation:
        touched |= {j for j, _ in generation.queued} | ({generation.current[0]} if generation.current else set())
        r = await generation.stop_all()
        res["generations"] = r["dropped"] + r["current"]
    if body.submissions:
        for sub in s.exec(select(Submission).where(
                Submission.status.in_([SubStatus.QUEUED, SubStatus.SENDING]))).all():
            sid = sub.id
            try:
                job, notify = submissions.cancel(s, sid)
            except Exception:  # noqa: BLE001 - finished meanwhile
                continue
            res["submissions"] += 1
            if notify and (conn := manager.get_workana(notify)) is not None:
                try:
                    await conn.send({"type": "cancel", "submission_id": sid})
                except Exception:  # noqa: BLE001
                    pass
            if job:
                touched.add(job.id)
                events.notify("submission_deleted", {"id": sid, "job_id": job.id})
    for jid in touched:
        if (job := s.get(Job, jid)) is not None:
            events.notify("job_updated", job_dict(job, s))
    events.log("system", f"CANCEL ALL: {res['generations']} generation(s), {res['submissions']} submission(s) cancelled, "
                         f"auto-send switched off on {res['auto_send_off']} job(s)", "warn")
    return {**res, "activity": _activity(s)}
