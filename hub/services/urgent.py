"""Urgent mode: one job jumps ahead of everything, the rest pauses, then the previous order resumes.

While a job is urgent:
  * generation: that job's accounts are generated first (no pause between prompts); other jobs wait;
  * sending: only that job's proposals are dispatched - without the random gap, the review window, the
    account's minimum delay or quiet hours (you asked for "now"); other queued proposals wait;
  * still enforced: daily limit, paused / inactive / offline accounts, one proposal at a time per account.
    A prompt ChatGPT is already writing, or a form already being filled, is never cut off.
Urgent mode ends by itself when the job's proposals are sent / failed (or can't go: account paused/offline),
after MAX_MINUTES at the latest, or with "End urgent mode" / "Cancel everything".
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

from sqlmodel import Session, select

from .. import events
from ..db import engine
from ..models import Account, Draft, Job, JobStatus, Submission, SubStatus, utcnow
from ..serialize import iso, job_dict
from . import job_state

MAX_MINUTES = 20


class UrgentControl:
    def __init__(self) -> None:
        self.job_id: Optional[str] = None
        self.started_at: Optional[datetime] = None
        self.title = ""
        self.prev_auto_send: Optional[bool] = None

    def active_for(self, job_id: str) -> bool:
        return self.job_id is not None and self.job_id == job_id

    def status(self) -> Optional[dict[str, Any]]:
        if not self.job_id:
            return None
        return {"job_id": self.job_id, "title": self.title, "started_at": iso(self.started_at),
                "ends_at": iso(self.started_at + timedelta(minutes=MAX_MINUTES)) if self.started_at else None}

    def _broadcast(self) -> None:
        events.notify("urgent", self.status() or {"job_id": None})

    # ------------------------------------------------------------------ start / end
    def start(self, s: Session, job_id: str) -> dict[str, Any]:
        """Make this job urgent: queue proposals for accounts with drafts, generate the others first."""
        from ..state import generation, submissions
        from .submission_queue import local_day_start_utc  # noqa: F401  (keeps import order explicit)

        job = s.get(Job, job_id)
        if job is None:
            raise ValueError("job not found")
        if job.status == JobStatus.SKIPPED:
            raise ValueError("job is skipped - un-skip it first")
        targets = job_state.targets(job)
        if not targets:
            raise ValueError("no accounts selected for this job")
        if self.job_id and self.job_id != job_id:
            self.end(f"replaced by another urgent job")
        self.job_id, self.started_at, self.title = job_id, utcnow(), job.title
        self.prev_auto_send = job.auto_send
        job.auto_send = True  # its drafts are queued for sending as soon as they exist
        s.add(job)
        s.commit()
        busy = set(generation.busy_for(job_id))
        queued_now: list[str] = []
        to_generate: list[str] = []
        skipped: list[str] = []
        for acc_id in targets:
            if job_state.submission_for(s, job_id, acc_id):
                continue  # already queued/sending (now first in line) or sent
            if acc_id in busy:
                continue  # generating / queued for generation: picked first, auto-sent when done
            has_drafts = s.exec(select(Draft.id).where(Draft.job_id == job_id, Draft.account_id == acc_id)).first()
            if has_drafts:
                generation._auto_send(job_id, acc_id)
                if job_state.submission_for(s, job_id, acc_id):
                    queued_now.append(acc_id)
                else:
                    skipped.append(acc_id)
            else:
                to_generate.append(acc_id)
        if to_generate:
            generation.enqueue(job_id, to_generate)
        events.log("submit", f"URGENT: '{job.title[:60]}' goes first - other generations and sends are paused "
                             f"(queued now: {', '.join(queued_now) or '-'}; generating first: {', '.join(to_generate) or '-'})",
                   "warn", job_id=job_id)
        with Session(engine) as s2:
            j = s2.get(Job, job_id)
            if j is not None:
                events.notify("job_updated", job_dict(j, s2))
            submissions._broadcast_queue(s2)
        self._broadcast()
        return {"queued_now": queued_now, "generating": to_generate, "not_queued": skipped, "urgent": self.status()}

    def end(self, reason: str = "done") -> None:
        if not self.job_id:
            return
        job_id = self.job_id
        with Session(engine) as s:
            job = s.get(Job, job_id)
            if job is not None and self.prev_auto_send is not None and job.auto_send != self.prev_auto_send:
                job.auto_send = self.prev_auto_send  # back to how it was before
                s.add(job)
                s.commit()
                events.notify("job_updated", job_dict(job, s))
        self.job_id, self.started_at, self.title, self.prev_auto_send = None, None, "", None
        events.log("submit", f"urgent mode ended ({reason}) - the previous order continues", job_id=job_id)
        self._broadcast()

    # ------------------------------------------------------------------ progress
    def check_done(self, s: Session, manager, now: Optional[datetime] = None) -> None:
        """Called every queue tick: end urgent mode once nothing of the job can still go out."""
        if not self.job_id:
            return
        from ..state import generation

        now = now or utcnow()
        if self.started_at and now - self.started_at > timedelta(minutes=MAX_MINUTES):
            return self.end(f"time limit of {MAX_MINUTES} minutes")
        job = s.get(Job, self.job_id)
        if job is None or job.status == JobStatus.SKIPPED:
            return self.end("job removed or skipped")
        if generation.busy_for(self.job_id):
            return
        if self.started_at and now - self.started_at < timedelta(seconds=2):
            return  # give freshly generated drafts a moment to be queued
        pending = s.exec(select(Submission).where(Submission.job_id == self.job_id,
                                                  Submission.status.in_([SubStatus.QUEUED, SubStatus.SENDING]))).all()
        for sub in pending:
            if sub.status == SubStatus.SENDING:
                return
            acc = s.get(Account, sub.account_id)
            if acc and acc.active and not acc.paused and manager.is_workana_connected(acc.id):
                return  # can still go out
        self.end("done" if not pending else "the remaining accounts are paused or offline")


urgent = UrgentControl()
