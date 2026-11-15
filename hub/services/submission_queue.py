"""Submission validation, queueing, rate limiting and result handling.

Rules enforced here (see README "Safety rules"):
  * one submission per (job, account) (logic + UNIQUE constraint on submissions(job_id, account_id))
  * the account must be one of the job's selected (target) accounts
  * per-account daily limit and minimum delay between submissions
  * global random jitter between submissions across ALL accounts
  * quiet hours: nothing is dispatched
  * paused accounts (captcha / not logged in / no credits / wrong account) are not dispatched
  * commands only go to the extension registered for that account
"""
from __future__ import annotations

import asyncio
import random
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from .. import events
from ..config import config
from ..db import engine
from ..models import Account, Draft, Job, JobStatus, Submission, SubStatus, utcnow
from ..serialize import account_dict, iso, job_dict, submission_dict
from . import job_state, settings_store

PAUSE_CODES = {"captcha", "not_logged_in", "no_credits", "wrong_account"}
KNOWN_ERRORS = {
    "not_logged_in", "wrong_account", "job_closed", "already_bid", "no_credits",
    "form_not_found", "captcha", "timeout",
}


class SendError(Exception):
    def __init__(self, message: str, status_code: int = 409):
        super().__init__(message)
        self.status_code = status_code


def local_day_start_utc(now_utc: Optional[datetime] = None) -> datetime:
    now_utc = now_utc or utcnow()
    local = now_utc.replace(tzinfo=timezone.utc).astimezone()
    start_local = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return start_local.astimezone(timezone.utc).replace(tzinfo=None)


def today_count(s: Session, account_id: str, now: Optional[datetime] = None) -> int:
    """Submissions that count toward the daily limit (failed ones don't)."""
    return s.exec(
        select(func.count())
        .select_from(Submission)
        .where(
            Submission.account_id == account_id,
            Submission.requested_at >= local_day_start_utc(now),
            Submission.status != SubStatus.FAILED,
        )
    ).one()


def last_dispatch(s: Session, account_id: Optional[str] = None) -> Optional[datetime]:
    q = select(func.max(Submission.dispatched_at))
    if account_id:
        q = q.where(Submission.account_id == account_id)
    return s.exec(q).one()


def create_submission(
    s: Session,
    *,
    job_id: str,
    account_id: str,
    draft_id: Optional[int],
    final_text: str,
    price: float,
    days: int,
    ext_connected: bool,
    auto: bool = False,
    hold_seconds: int = 0,
) -> Submission:
    """Validate a Send request and create a queued submission. Raises SendError."""
    job = s.get(Job, job_id)
    if job is None:
        raise SendError("job not found", 404)
    if job_state.submission_for(s, job_id, account_id):
        raise SendError(f"{account_id} already has a proposal sent or queued for this job")
    if job.status == JobStatus.SKIPPED:
        raise SendError("job is skipped; un-skip it first")
    if account_id not in job_state.targets(job):
        raise SendError(f"{account_id} is not selected for this job - add it to the job's accounts first")
    acc = s.get(Account, account_id)
    if acc is None:
        raise SendError("account not found", 404)
    if not acc.active:
        raise SendError("account is inactive")
    if acc.paused:
        raise SendError(f"account is paused ({acc.pause_reason}); resolve it and resume the account first")
    if not ext_connected:
        raise SendError("the Workana extension for this account is not connected")
    if today_count(s, account_id) >= acc.daily_limit:
        raise SendError(f"daily limit reached ({acc.daily_limit}) for {acc.display_name or acc.id}")
    final_text = (final_text or "").strip()
    if len(final_text) < 20:
        raise SendError("proposal text is too short", 422)
    if price is None or price <= 0:
        raise SendError("price must be > 0", 422)
    if days is None or int(days) < 1:
        raise SendError("days must be >= 1", 422)
    style = None
    if draft_id is not None:
        draft = s.get(Draft, draft_id)
        if draft is None or draft.job_id != job_id:
            raise SendError("draft does not belong to this job", 422)
        style = draft.style

    from .currency import norm
    sub = Submission(
        job_id=job_id, account_id=account_id, draft_id=draft_id, style=style,
        final_text=final_text, price=float(price), currency=norm(acc.currency), days=int(days), status=SubStatus.QUEUED,
        auto=auto, hold_until=utcnow() + timedelta(seconds=hold_seconds) if hold_seconds > 0 else None,
    )
    s.add(sub)
    try:
        s.flush()
        job_state.refresh(s, job)
        s.add(job)
        s.commit()
    except IntegrityError:
        s.rollback()
        raise SendError(f"{account_id} already has a proposal for this job")
    s.refresh(sub)
    return sub


class SubmissionQueue:
    def __init__(self, manager, rng: Optional[random.Random] = None):
        self.manager = manager
        self.rng = rng or random.Random()
        self.next_global_at: Optional[datetime] = None

    # ---- lifecycle --------------------------------------------------------
    def recover_on_startup(self) -> None:
        """Anything 'sending' when the hub died has an unknown outcome -> failed (verify manually)."""
        with Session(engine) as s:
            for sub in s.exec(select(Submission).where(Submission.status == SubStatus.SENDING)).all():
                sub.status = SubStatus.FAILED
                sub.error = "hub_restarted"
                sub.progress = "Hub restarted while sending - check Workana manually before retrying"
                s.add(sub)
            s.commit()
            last = last_dispatch(s)
            jmin = int(settings_store.get(s, "jitter_min_seconds"))
            if last:
                self.next_global_at = last + timedelta(seconds=jmin)

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception as e:  # never let the loop die
                events.log("submit", f"queue tick error: {e!r}", "error")
            await asyncio.sleep(1)

    # ---- scheduling -------------------------------------------------------
    def queue_info(self, s: Session, sub: Submission, now: Optional[datetime] = None) -> dict[str, Any]:
        """ETA + reason a queued submission is waiting (for dashboard countdowns)."""
        if sub.status != SubStatus.QUEUED:
            return {"not_before": None, "blocked": None, "review_until": None}
        now = now or utcnow()
        acc = s.get(Account, sub.account_id)
        blocked = None
        if acc is None or not acc.active:
            blocked = "account inactive"
        elif acc.paused:
            blocked = f"account paused ({acc.pause_reason})"
        elif not self.manager.is_workana_connected(sub.account_id):
            blocked = "extension disconnected"
        elif settings_store.in_quiet_hours(settings_store.get(s, "quiet_hours")):
            blocked = "quiet hours"
        elif s.exec(select(Submission).where(Submission.account_id == sub.account_id,
                                             Submission.status == SubStatus.SENDING)).first():
            blocked = "account busy with another submission"
        candidates = [now]
        if sub.hold_until and sub.hold_until > now:
            candidates.append(sub.hold_until)
        last = last_dispatch(s, sub.account_id)
        if acc and last:
            candidates.append(last + timedelta(seconds=acc.min_delay_seconds))
        if self.next_global_at:
            candidates.append(self.next_global_at)
        held = bool(sub.hold_until and sub.hold_until > now)
        return {"not_before": iso(max(candidates)), "blocked": blocked, "review_until": iso(sub.hold_until) if held else None}

    def submission_payload(self, s: Session, sub: Submission) -> dict[str, Any]:
        return submission_dict(sub, self.queue_info(s, sub))

    async def tick(self, now: Optional[datetime] = None) -> None:
        now = now or utcnow()
        with Session(engine) as s:
            self._check_timeouts(s, now)
            if settings_store.in_quiet_hours(settings_store.get(s, "quiet_hours")):
                return
            if self.next_global_at and now < self.next_global_at:
                return
            queued = s.exec(
                select(Submission).where(Submission.status == SubStatus.QUEUED).order_by(Submission.requested_at)
            ).all()
            if not queued:
                return
            busy = set(s.exec(select(Submission.account_id).where(Submission.status == SubStatus.SENDING)).all())
            for sub in queued:
                acc = s.get(Account, sub.account_id)
                if acc is None or not acc.active or acc.paused or acc.id in busy:
                    continue
                if sub.hold_until and now < sub.hold_until:  # review window (auto-send)
                    continue
                conn = self.manager.get_workana(acc.id)
                if conn is None:
                    continue
                last = last_dispatch(s, acc.id)
                if last and now < last + timedelta(seconds=acc.min_delay_seconds):
                    continue
                job = s.get(Job, sub.job_id)
                sub.status = SubStatus.SENDING
                sub.dispatched_at = now
                sub.progress = "dispatched to extension"
                s.add(sub)
                s.commit()
                try:
                    await conn.send({
                        "type": "submit",
                        "submission_id": sub.id,
                        "attempt": iso(now),  # retries keep the id; the extension de-duplicates per attempt
                        "job_id": sub.job_id,
                        "url": job.url if job else "",
                        "text": sub.final_text,
                        "price": sub.price,
                        "days": sub.days,
                    })
                except Exception as e:
                    sub.status = SubStatus.QUEUED
                    sub.dispatched_at = None
                    sub.progress = None
                    s.add(sub)
                    s.commit()
                    events.log("submit", f"could not reach extension for {acc.id}: {e!r}", "warn",
                               job_id=sub.job_id, account_id=acc.id)
                    continue
                jmin = int(settings_store.get(s, "jitter_min_seconds"))
                jmax = int(settings_store.get(s, "jitter_max_seconds"))
                self.next_global_at = now + timedelta(seconds=self.rng.uniform(jmin, max(jmin, jmax)))
                events.log("submit", f"submission #{sub.id} dispatched to {acc.id}", job_id=sub.job_id, account_id=acc.id)
                events.notify("submission_updated", self.submission_payload(s, sub))
                self._broadcast_queue(s)
                return  # at most one dispatch per tick

    def _broadcast_queue(self, s: Session) -> None:
        for q in s.exec(select(Submission).where(Submission.status == SubStatus.QUEUED)).all():
            events.notify("submission_updated", self.submission_payload(s, q))

    def _check_timeouts(self, s: Session, now: datetime) -> None:
        limit = now - timedelta(seconds=config.SUBMIT_TIMEOUT_SECONDS)
        stuck = s.exec(
            select(Submission).where(Submission.status == SubStatus.SENDING, Submission.dispatched_at < limit)
        ).all()
        for sub in stuck:
            self._mark_failed(s, sub, "timeout", "no result from extension in time")

    # ---- results from extensions -----------------------------------------
    def _mark_failed(self, s: Session, sub: Submission, code: str, detail: Optional[str] = None) -> None:
        sub.status = SubStatus.FAILED
        sub.error = code + (f": {detail}" if detail else "")
        s.add(sub)
        job = s.get(Job, sub.job_id)
        if job:
            s.flush()
            job_state.refresh(s, job)
            job.last_error = f"Submission failed ({sub.account_id}): {sub.error}"
            s.add(job)
        acc = s.get(Account, sub.account_id)
        paused = False
        if acc and code in PAUSE_CODES:
            acc.paused = True
            acc.pause_reason = code
            s.add(acc)
            paused = True
        s.commit()
        events.log("submit", f"submission #{sub.id} failed: {sub.error}", "error", job_id=sub.job_id, account_id=sub.account_id)
        events.notify("submission_updated", self.submission_payload(s, sub))
        if job:
            events.notify("job_updated", job_dict(job, s))
        if paused and acc:
            events.log("submit", f"account {acc.id} PAUSED ({code}) - resolve in its Chrome profile, then click Resume",
                       "warn", account_id=acc.id)
            events.notify("account_updated", account_dict(acc))

    def handle_result(self, account_id: str, msg: dict[str, Any]) -> None:
        try:
            sid = int(msg.get("submission_id"))
        except (TypeError, ValueError):
            events.log("submit", f"result without valid submission_id from {account_id}", "warn")
            return
        status = msg.get("status")
        with Session(engine) as s:
            sub = s.get(Submission, sid)
            if sub is None:
                events.log("submit", f"result for unknown submission #{sid}", "warn", account_id=account_id)
                return
            if sub.account_id != account_id:
                events.log("submit", f"IGNORED result for #{sid} from {account_id} (belongs to {sub.account_id})",
                           "warn", account_id=account_id)
                return
            if sub.status not in (SubStatus.SENDING, SubStatus.FAILED):
                events.log("submit", f"ignored result for #{sid} in state {sub.status}", "warn", account_id=account_id)
                return
            if status == "sent":
                sub.status = SubStatus.SENT
                sub.sent_at = utcnow()
                sub.error = None
                sub.progress = "verified on Workana"
                job = s.get(Job, sub.job_id)
                s.add(sub)
                if job:
                    s.flush()
                    job_state.refresh(s, job)
                    job.last_error = None
                    s.add(job)
                s.commit()
                events.log("submit", f"submission #{sid} SENT by {account_id}", job_id=sub.job_id, account_id=account_id)
                events.notify("submission_updated", self.submission_payload(s, sub))
                if job:
                    events.notify("job_updated", job_dict(job, s))
            else:
                code = str(msg.get("error") or "unknown")
                self._mark_failed(s, sub, code, msg.get("detail"))

    def handle_progress(self, account_id: str, msg: dict[str, Any]) -> None:
        try:
            sid = int(msg.get("submission_id"))
        except (TypeError, ValueError):
            return
        with Session(engine) as s:
            sub = s.get(Submission, sid)
            if sub is None or sub.account_id != account_id or sub.status != SubStatus.SENDING:
                return
            sub.progress = str(msg.get("stage", ""))[:200]
            s.add(sub)
            s.commit()
            events.notify("submission_updated", self.submission_payload(s, sub))

    # ---- manual actions ---------------------------------------------------
    def retry(self, s: Session, sid: int) -> Submission:
        sub = s.get(Submission, sid)
        if sub is None:
            raise SendError("submission not found", 404)
        if sub.status != SubStatus.FAILED:
            raise SendError("only failed submissions can be retried")
        acc = s.get(Account, sub.account_id)
        if acc and acc.paused:
            raise SendError("account is paused; resume it first")
        if acc and today_count(s, acc.id) >= acc.daily_limit:
            raise SendError("daily limit reached for this account")
        sub.status = SubStatus.QUEUED
        sub.error = None
        sub.progress = None
        sub.dispatched_at = None
        sub.requested_at = utcnow()
        s.add(sub)
        job = s.get(Job, sub.job_id)
        if job:
            s.flush()
            job_state.refresh(s, job)
            job.last_error = None
            s.add(job)
        s.commit()
        s.refresh(sub)
        return sub

    def release(self, s: Session, sid: int) -> Submission:
        """End an auto-send review window now ("Send now")."""
        sub = s.get(Submission, sid)
        if sub is None:
            raise SendError("submission not found", 404)
        if sub.status != SubStatus.QUEUED:
            raise SendError("only queued submissions can be released")
        sub.hold_until = None
        s.add(sub)
        s.commit()
        s.refresh(sub)
        return sub

    def active(self, s: Session) -> list[Submission]:
        return s.exec(select(Submission).where(Submission.status.in_([SubStatus.QUEUED, SubStatus.SENDING]))
                      .order_by(Submission.requested_at)).all()

    def mark_sent(self, s: Session, sid: int) -> Submission:
        """Human confirmation: the proposal IS on Workana although the extension could not verify it."""
        sub = s.get(Submission, sid)
        if sub is None:
            raise SendError("submission not found", 404)
        if sub.status == SubStatus.SENT:
            return sub
        sub.status = SubStatus.SENT
        sub.sent_at = sub.sent_at or utcnow()
        sub.error = None
        sub.progress = "marked as sent manually"
        s.add(sub)
        job = s.get(Job, sub.job_id)
        if job:
            s.flush()
            job_state.refresh(s, job)
            job.last_error = None
            s.add(job)
        s.commit()
        s.refresh(sub)
        return sub

    def cancel(self, s: Session, sid: int) -> tuple[Optional[Job], Optional[str]]:
        """Delete a queued / sending / failed submission so it can be redone.

        Returns (job, account_id_to_notify): when it was already 'sending', the caller tells that account's
        extension to stop (it then clicks nothing more on the page).
        """
        sub = s.get(Submission, sid)
        if sub is None:
            raise SendError("submission not found", 404)
        if sub.status == SubStatus.SENT:
            raise SendError("this proposal was already sent - it can't be cancelled from here")
        notify = sub.account_id if sub.status == SubStatus.SENDING else None
        job = s.get(Job, sub.job_id)
        s.delete(sub)
        if job:
            s.flush()
            job_state.refresh(s, job)
            job.last_error = None
            s.add(job)
        s.commit()
        if job:
            s.refresh(job)
        return job, notify
