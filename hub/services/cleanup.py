"""Deleting history: jobs (with their drafts and bids), logs, Workana notices; database stats and backup.

Jobs whose proposal is queued or being sent, and jobs ChatGPT is writing for, are never deleted.
"""
from __future__ import annotations

import sqlite3
from datetime import timedelta
from pathlib import Path
from typing import Any, Iterable, Optional

from sqlalchemy import func
from sqlmodel import Session, delete, select

from .. import events
from ..db import engine
from ..models import Draft, Event, Job, Notice, Submission, SubStatus, utcnow


def db_path() -> Optional[Path]:
    if engine.url.get_backend_name() != "sqlite" or not engine.url.database or ":memory:" in engine.url.database:
        return None
    return Path(engine.url.database)


def _busy_jobs(s: Session) -> set[str]:
    from ..state import generation

    busy = set(s.exec(select(Submission.job_id).where(
        Submission.status.in_([SubStatus.QUEUED, SubStatus.SENDING]))).all())
    busy |= {j for j, _ in generation.queued}
    if generation.current:
        busy.add(generation.current[0])
    return busy


def delete_jobs(s: Session, job_ids: Iterable[str]) -> dict[str, Any]:
    """Delete jobs with their drafts and submissions. Returns {"deleted": [...], "kept": {id: reason}}."""
    ids = list(dict.fromkeys(job_ids))
    busy = _busy_jobs(s)
    deleted, kept = [], {}
    for jid in ids:
        if jid in busy:
            kept[jid] = "a proposal is being generated, queued or sent - cancel it first"
            continue
        if s.get(Job, jid) is None:
            kept[jid] = "not found"
            continue
        deleted.append(jid)
    for i in range(0, len(deleted), 400):
        chunk = deleted[i:i + 400]
        s.exec(delete(Submission).where(Submission.job_id.in_(chunk)))
        s.exec(delete(Draft).where(Draft.job_id.in_(chunk)))
        for n in s.exec(select(Notice).where(Notice.job_id.in_(chunk))).all():
            n.job_id = None
            s.add(n)
        s.exec(delete(Job).where(Job.id.in_(chunk)))
    s.commit()
    if deleted:
        events.notify("jobs_deleted", {"ids": deleted})
    return {"deleted": deleted, "kept": kept}


def purge_jobs(s: Session, older_than_days: int, statuses: list[str], keep_sent: bool) -> dict[str, Any]:
    """Delete jobs fetched more than N days ago (0 = any age) whose status is in `statuses`."""
    stmt = select(Job.id)
    if older_than_days > 0:
        stmt = stmt.where(Job.fetched_at < utcnow() - timedelta(days=older_than_days))
    if statuses:
        stmt = stmt.where(Job.status.in_(statuses))
    ids = list(s.exec(stmt).all())
    if keep_sent and ids:
        with_sent = set(s.exec(select(Submission.job_id).where(Submission.status == SubStatus.SENT)).all())
        ids = [j for j in ids if j not in with_sent]
    return delete_jobs(s, ids)


def purge_drafts(s: Session, older_than_days: int) -> int:
    """Delete generated proposals (drafts) older than N days of jobs that are finished (sent / skipped).
    What was actually sent stays in the bid (submission) itself."""
    stmt = select(Draft.id).join(Job, Job.id == Draft.job_id).where(Job.status.in_(["sent", "skipped"]))
    if older_than_days > 0:
        stmt = stmt.where(Draft.created_at < utcnow() - timedelta(days=older_than_days))
    ids = list(s.exec(stmt).all())
    for i in range(0, len(ids), 400):
        chunk = ids[i:i + 400]
        for sub in s.exec(select(Submission).where(Submission.draft_id.in_(chunk))).all():
            sub.draft_id = None
            s.add(sub)
        s.exec(delete(Draft).where(Draft.id.in_(chunk)))
    s.commit()
    return len(ids)


def clear_logs(s: Session, older_than_days: int = 0) -> int:
    stmt = delete(Event)
    if older_than_days > 0:
        stmt = stmt.where(Event.ts < utcnow() - timedelta(days=older_than_days))
    n = s.exec(stmt).rowcount or 0
    s.commit()
    return n


def clear_notices(s: Session, older_than_days: int = 0, only_read: bool = False) -> int:
    stmt = delete(Notice)
    if older_than_days > 0:
        stmt = stmt.where(Notice.ts < utcnow() - timedelta(days=older_than_days))
    if only_read:
        stmt = stmt.where(Notice.read == True)  # noqa: E712
    n = s.exec(stmt).rowcount or 0
    s.commit()
    return n


def vacuum() -> None:
    """Give the freed space back to the disk."""
    with engine.connect() as conn:
        conn.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.exec_driver_sql("VACUUM")


def stats(s: Session) -> dict[str, Any]:
    def count(model, *where) -> int:
        q = select(func.count()).select_from(model)
        for w in where:
            q = q.where(w)
        return s.exec(q).one()

    jobs_by_status = dict(s.exec(select(Job.status, func.count()).group_by(Job.status)).all())
    subs_by_status = dict(s.exec(select(Submission.status, func.count()).group_by(Submission.status)).all())
    size = 0
    p = db_path()
    if p:
        for f in (p, p.with_name(p.name + "-wal")):
            try:
                size += f.stat().st_size
            except OSError:
                pass
    oldest_job = s.exec(select(func.min(Job.fetched_at))).one()
    oldest_log = s.exec(select(func.min(Event.ts))).one()
    return {
        "db_bytes": size,
        "jobs": sum(jobs_by_status.values()),
        "jobs_by_status": jobs_by_status,
        "drafts": count(Draft),
        "submissions": sum(subs_by_status.values()),
        "submissions_by_status": subs_by_status,
        "logs": count(Event),
        "notices": count(Notice),
        "notices_unread": count(Notice, Notice.read == False),  # noqa: E712
        "oldest_job": oldest_job.isoformat() + "Z" if oldest_job else None,
        "oldest_log": oldest_log.isoformat() + "Z" if oldest_log else None,
    }


def backup_to(dest: Path) -> Path:
    """Consistent copy of the live database (safe while the app runs)."""
    src_path = db_path()
    if src_path is None:
        raise RuntimeError("backup is only available for the SQLite database")
    src = sqlite3.connect(src_path)
    try:
        out = sqlite3.connect(dest)
        with out:
            src.backup(out)
        out.close()
    finally:
        src.close()
    return dest


def run_retention(force: bool = False) -> Optional[dict[str, Any]]:
    """Automatic clean-up (Data page → Automatic clean-up). Runs at most once a day unless forced."""
    from . import settings_store

    with Session(engine) as s:
        r = settings_store.get(s, "retention")
        if not r.get("enabled") and not force:
            return None
        last = settings_store.get(s, "retention_last_run")
        now = utcnow()
        if not force and last:
            try:
                from datetime import datetime

                if now - datetime.fromisoformat(str(last)) < timedelta(hours=23):
                    return None
            except ValueError:
                pass
        res: dict[str, Any] = {"logs": 0, "jobs": 0, "notices": 0}
        if r.get("jobs_days"):
            res["jobs"] = len(purge_jobs(s, int(r["jobs_days"]), list(r.get("job_statuses") or []),
                                         bool(r.get("keep_sent", True)))["deleted"])
        if r.get("notices_days"):
            res["notices"] = clear_notices(s, int(r["notices_days"]))
        if r.get("logs_days"):
            res["logs"] = clear_logs(s, int(r["logs_days"]))
        settings_store.set_raw(s, "retention_last_run", now.isoformat())
    if any(res.values()):
        events.log("system", f"automatic clean-up: {res['jobs']} job(s), {res['logs']} log line(s), "
                             f"{res['notices']} notice(s) deleted")
    return res
