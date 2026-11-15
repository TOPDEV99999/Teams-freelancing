"""Multi-account job state: which accounts bid on a job, and the job's overall status.

A job has one *focus* account (`assigned_account_id`, what the dashboard opens first) and a list of
*target* accounts (`target_accounts`) that should each send their own proposal. An empty target list
means "just the assigned account" - the original one-account behaviour.
"""
from __future__ import annotations

from sqlmodel import Session, select

from ..models import Draft, Job, JobStatus, Submission, SubStatus


def targets(job: Job) -> list[str]:
    t = [a for a in (job.target_accounts or []) if a]
    if t:
        return list(dict.fromkeys(t))
    return [job.assigned_account_id] if job.assigned_account_id else []


def submission_for(s: Session, job_id: str, account_id: str) -> Submission | None:
    return s.exec(select(Submission).where(Submission.job_id == job_id, Submission.account_id == account_id)).first()


def refresh(s: Session, job: Job, generating: bool | None = None) -> Job:
    """Recompute job.status and job.locked from drafts + submissions (caller commits).

    generating=None keeps the current "generating" state; True/False sets it.
    """
    if generating is None:
        generating = job.status == JobStatus.GENERATING
    tg = targets(job)
    subs = s.exec(select(Submission).where(Submission.job_id == job.id)).all()
    by_acc = {x.account_id: x for x in subs}
    # Locked = every target account already has a submission (nothing left to send).
    job.locked = bool(tg) and all(a in by_acc for a in tg)
    if job.status == JobStatus.SKIPPED:
        return job
    sent = {a for a, x in by_acc.items() if x.status == SubStatus.SENT}
    pending = any(x.status in (SubStatus.QUEUED, SubStatus.SENDING) for x in subs)
    failed = any(x.status == SubStatus.FAILED for x in subs)
    has_drafts = s.exec(select(Draft.id).where(Draft.job_id == job.id)).first() is not None
    if generating:
        job.status = JobStatus.GENERATING
    elif tg and all(a in sent for a in tg):
        job.status = JobStatus.SENT
    elif failed and not pending:
        job.status = JobStatus.ERROR
    elif has_drafts:
        job.status = JobStatus.DRAFTED
    elif sent:
        job.status = JobStatus.SENT
    else:
        job.status = JobStatus.NEW
    return job
