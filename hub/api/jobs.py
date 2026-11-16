from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlmodel import Session, select

from .. import events
from ..db import get_session
from ..fetcher.base import JobIn
from ..models import Account, Draft, Job, JobStatus, Submission, SubStatus
from ..serialize import draft_dict, job_dict
from ..services.assignment import choose_account
from ..services.ingest import ingest
from ..services.submission_queue import SendError, create_submission
from ..services import job_state, settings_store
from ..state import generation, submissions
from ..ws.connection_manager import manager

router = APIRouter(prefix="/api", tags=["jobs"])


def _get_job(s: Session, job_id: str) -> Job:
    job = s.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return job


def _full(s: Session, job: Job) -> dict:
    d = job_dict(job, s, full=True)
    subs = s.exec(select(Submission).where(Submission.job_id == job.id).order_by(Submission.id)).all()
    d["submissions"] = [submissions.submission_payload(s, x) for x in subs]
    focus = next((x for x in subs if x.account_id == job.assigned_account_id), None)
    d["submission"] = submissions.submission_payload(s, focus) if focus else None
    d["generating_accounts"] = generation.busy_for(job.id)
    accounts = s.exec(select(Account)).all()
    _, scores = choose_account(job, accounts, float(settings_store.get(s, "assign_threshold")))
    d["scores"] = scores
    return d


def _notify(s: Session, job: Job) -> None:
    events.notify("job_updated", job_dict(job, s))


@router.get("/jobs")
def list_jobs(
    status: Optional[str] = None,
    account: Optional[str] = None,
    q: Optional[str] = None,
    budget_min: Optional[float] = None,
    budget_max: Optional[float] = None,
    limit: int = 300,
    s: Session = Depends(get_session),
):
    stmt = select(Job)
    if status:
        stmt = stmt.where(Job.status.in_([x.strip() for x in status.split(",") if x.strip()]))
    if account == "unassigned":
        stmt = stmt.where(Job.assigned_account_id.is_(None))
    elif account:
        stmt = stmt.where(or_(Job.assigned_account_id == account, Job.target_accounts.like(f'%"{account}"%')))
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Job.title.ilike(like), Job.description.ilike(like)))
    if budget_min is not None:
        stmt = stmt.where(func.coalesce(Job.budget_max, Job.budget_min) >= budget_min)
    if budget_max is not None:
        stmt = stmt.where(func.coalesce(Job.budget_min, Job.budget_max) <= budget_max)
    stmt = stmt.order_by(Job.fetched_at.desc()).limit(max(1, min(limit, 1000)))
    return [job_dict(j, s) for j in s.exec(stmt).all()]


@router.post("/jobs")
def add_jobs(jobs: list[JobIn]):
    """Manually inject jobs (useful for testing or for pushing jobs from another script)."""
    ids = ingest(jobs, generation.enqueue)
    return {"inserted": ids}


@router.get("/jobs/{job_id}")
def get_job(job_id: str, s: Session = Depends(get_session)):
    return _full(s, _get_job(s, job_id))


class AssignBody(BaseModel):
    assigned_account_id: Optional[str] = None
    target_accounts: Optional[list[str]] = None
    auto_send: Optional[bool] = None
    auto_style: Optional[str] = None


def _set_targets(s: Session, job: Job, wanted: list[str]) -> None:
    """Change the accounts that bid on this job. Accounts that already have a submission stay."""
    for a in wanted:
        if s.get(Account, a) is None:
            raise HTTPException(404, f"account not found: {a}")
    keep = {x.account_id for x in s.exec(select(Submission).where(Submission.job_id == job.id)).all()}
    job.target_accounts = list(dict.fromkeys([*wanted, *sorted(keep - set(wanted))]))
    if job.target_accounts and job.assigned_account_id not in job.target_accounts:
        job.assigned_account_id = job.target_accounts[0]


@router.patch("/jobs/{job_id}")
def assign_job(job_id: str, body: AssignBody, s: Session = Depends(get_session)):
    """Change the focus account, the target accounts and/or the auto-send settings."""
    job = _get_job(s, job_id)
    fields = body.model_fields_set
    if "assigned_account_id" in fields:
        if body.assigned_account_id and s.get(Account, body.assigned_account_id) is None:
            raise HTTPException(404, "account not found")
        job.assigned_account_id = body.assigned_account_id or None
        if job.assigned_account_id and job.target_accounts and job.assigned_account_id not in job.target_accounts:
            job.target_accounts = [*job.target_accounts, job.assigned_account_id]
        if not job.assigned_account_id and "target_accounts" not in fields:
            _set_targets(s, job, [])
    if "target_accounts" in fields:
        _set_targets(s, job, body.target_accounts or [])
    if body.auto_send is not None:
        job.auto_send = body.auto_send
    if body.auto_style is not None:
        job.auto_style = body.auto_style
    job_state.refresh(s, job)
    s.add(job)
    s.commit()
    s.refresh(job)
    events.log("system", f"job accounts: {', '.join(job_state.targets(job)) or 'none'}"
                         f"{' (auto-send)' if job.auto_send else ''}", job_id=job.id, account_id=job.assigned_account_id)
    _notify(s, job)
    return _full(s, job)


class GenerateBody(BaseModel):
    account_ids: Optional[list[str]] = None  # default: every target account without a submission


@router.post("/jobs/{job_id}/generate")
def generate(job_id: str, body: Optional[GenerateBody] = None, s: Session = Depends(get_session)):
    job = _get_job(s, job_id)
    if job.status == JobStatus.SKIPPED:
        raise HTTPException(409, "job is skipped")
    if not job_state.targets(job):
        raise HTTPException(409, "assign an account first")
    added = generation.enqueue(job_id, body.account_ids if body else None)
    if not added:
        raise HTTPException(409, "nothing to generate: already queued, or every selected account already sent")
    return {"queued": True, "accounts": added, "generation": generation.status()}


@router.post("/jobs/{job_id}/stop-generation")
async def stop_generation(job_id: str, s: Session = Depends(get_session)):
    """Cancel this job's generations: the accounts still waiting AND the prompt ChatGPT is writing now."""
    _get_job(s, job_id)
    r = await generation.stop_job(job_id)
    events.log("generate", f"stopped: {r['dropped']} queued generation(s) dropped"
                           f"{', the running one cancelled' if r['current'] else ''}", job_id=job_id)
    return {"dropped": r["dropped"] + r["current"], "current": r["current"], "generation": generation.status()}


@router.post("/jobs/{job_id}/presence")
def watch_presence(job_id: str, s: Session = Depends(get_session)):
    """The job is open in the dashboard: refresh its client's last login first (still rate-limited)."""
    from ..services.presence import presence

    _get_job(s, job_id)
    presence.watch(job_id)
    return {"queued": True, **presence.status()}


@router.delete("/jobs/{job_id}")
def delete_job(job_id: str, s: Session = Depends(get_session)):
    from ..services.cleanup import delete_jobs

    _get_job(s, job_id)
    r = delete_jobs(s, [job_id])
    if not r["deleted"]:
        raise HTTPException(409, r["kept"].get(job_id, "could not delete"))
    events.log("system", "job deleted", job_id=job_id)
    return {"deleted": job_id}


class DeleteBody(BaseModel):
    job_ids: list[str]


@router.post("/jobs/delete")
def delete_many(body: DeleteBody, s: Session = Depends(get_session)):
    from ..services.cleanup import delete_jobs

    r = delete_jobs(s, body.job_ids)
    events.log("system", f"{len(r['deleted'])} job(s) deleted" + (f", {len(r['kept'])} kept (busy)" if r["kept"] else ""))
    return {"deleted": r["deleted"], "kept": r["kept"]}


class BatchBody(BaseModel):
    job_ids: list[str]
    account_ids: list[str] = []  # empty = each job keeps its own pre-selected (matching) accounts
    auto_send: bool = False
    auto_style: str = ""
    generate: bool = True


@router.post("/jobs/batch")
def batch(body: BatchBody, s: Session = Depends(get_session)):
    """Pre-assign several jobs to several accounts. Generation runs job by job, account by account; with
    auto_send each proposal is queued as soon as its drafts are ready and the submission queue spaces them out."""
    if not body.job_ids:
        raise HTTPException(422, "select at least one job")
    for a in body.account_ids:
        if s.get(Account, a) is None:
            raise HTTPException(404, f"account not found: {a}")
    done, skipped = [], []
    for jid in dict.fromkeys(body.job_ids):
        job = s.get(Job, jid)
        if job is None or job.status == JobStatus.SKIPPED:
            skipped.append(jid)
            continue
        if body.account_ids:
            _set_targets(s, job, list(body.account_ids))
        elif not job_state.targets(job):
            skipped.append(jid)  # no matching account and none picked
            continue
        job.auto_send = body.auto_send
        job.auto_style = body.auto_style
        job_state.refresh(s, job)
        s.add(job)
        s.commit()
        s.refresh(job)
        _notify(s, job)
        done.append(jid)
    queued = 0
    if body.generate:
        for jid in done:
            queued += len(generation.enqueue(jid))
    events.log("system", f"batch: {len(done)} job(s) -> {', '.join(body.account_ids) or 'their matching accounts'}"
                         f"{' with auto-send' if body.auto_send else ''}; {queued} generation(s) queued")
    return {"jobs": done, "skipped": skipped, "generations_queued": queued, "generation": generation.status()}


class SendBody(BaseModel):
    account_id: str
    draft_id: Optional[int] = None
    final_text: str
    price: float
    days: int


@router.post("/jobs/{job_id}/send")
def send(job_id: str, body: SendBody, s: Session = Depends(get_session)):
    try:
        sub = create_submission(
            s, job_id=job_id, account_id=body.account_id, draft_id=body.draft_id,
            final_text=body.final_text, price=body.price, days=body.days,
            ext_connected=manager.is_workana_connected(body.account_id),
        )
    except SendError as e:
        events.log("submit", f"send rejected: {e}", "warn", job_id=job_id, account_id=body.account_id)
        raise HTTPException(e.status_code, str(e))
    events.log("submit", f"submission #{sub.id} queued for {sub.account_id}", job_id=job_id, account_id=sub.account_id)
    payload = submissions.submission_payload(s, sub)
    events.notify("submission_updated", payload)
    job = s.get(Job, job_id)
    events.notify("job_updated", job_dict(job, s))
    return payload


@router.post("/jobs/{job_id}/skip")
def skip(job_id: str, s: Session = Depends(get_session)):
    job = _get_job(s, job_id)
    pending = s.exec(select(Submission).where(
        Submission.job_id == job_id, Submission.status.in_([SubStatus.QUEUED, SubStatus.SENDING]))).first()
    if pending:
        raise HTTPException(409, "a proposal is queued or sending for this job - cancel it first")
    generation.cancel_job(job_id)
    job.status = JobStatus.SKIPPED
    s.add(job)
    s.commit()
    s.refresh(job)
    _notify(s, job)
    return job_dict(job, s)


@router.post("/jobs/{job_id}/unskip")
def unskip(job_id: str, s: Session = Depends(get_session)):
    job = _get_job(s, job_id)
    if job.status != JobStatus.SKIPPED:
        raise HTTPException(409, "job is not skipped")
    job.status = JobStatus.NEW
    job_state.refresh(s, job, generating=False)
    s.add(job)
    s.commit()
    s.refresh(job)
    _notify(s, job)
    return job_dict(job, s)


class DraftEdit(BaseModel):
    text: str


@router.patch("/drafts/{draft_id}")
def edit_draft(draft_id: int, body: DraftEdit, s: Session = Depends(get_session)):
    d = s.get(Draft, draft_id)
    if d is None:
        raise HTTPException(404, "draft not found")
    if job_state.submission_for(s, d.job_id, d.account_id):
        raise HTTPException(409, "this account already sent or queued its proposal")
    d.text = body.text
    d.edited = True
    s.add(d)
    s.commit()
    s.refresh(d)
    return draft_dict(d)


@router.post("/jobs/{job_id}/urgent")
def make_urgent(job_id: str, s: Session = Depends(get_session)):
    """Pause everything else, generate/send this job's proposals now, then resume the previous order."""
    from ..services.urgent import urgent

    try:
        return urgent.start(s, job_id)
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.delete("/urgent")
def end_urgent():
    from ..services.urgent import urgent

    was = urgent.job_id
    urgent.end("ended from the dashboard")
    return {"ended": was}
