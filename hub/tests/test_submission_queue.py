import asyncio
import random
from datetime import timedelta

import pytest
from sqlmodel import Session, select

from hub.db import engine
from hub.models import Account, Draft, Job, JobStatus, Submission, SubStatus, utcnow
from hub.services import settings_store
from hub.services.submission_queue import SendError, SubmissionQueue, create_submission


class FakeConn:
    def __init__(self):
        self.sent = []

    async def send(self, msg):
        self.sent.append(msg)


class FakeManager:
    def __init__(self, accounts=()):
        self.conns = {a: FakeConn() for a in accounts}

    def get_workana(self, a):
        return self.conns.get(a)

    def is_workana_connected(self, a):
        return a in self.conns


def add_job(s, jid, account="me", locked=False):
    s.add(Job(id=jid, url=f"https://www.workana.com/job/{jid}", title=jid, assigned_account_id=account,
              status=JobStatus.DRAFTED, locked=locked))
    s.add(Draft(job_id=jid, account_id=account or "me", style="short", text="x" * 30))
    s.commit()
    return s.exec(select(Draft).where(Draft.job_id == jid)).first().id


def send(s, jid, account="me", draft_id=None, connected=True, text="Hello client, " * 3):
    return create_submission(s, job_id=jid, account_id=account, draft_id=draft_id, final_text=text,
                             price=100, days=5, ext_connected=connected)


# ---------------------------------------------------------------- validation

def test_send_creates_queued_and_locks(session):
    d = add_job(session, "j1")
    sub = send(session, "j1", draft_id=d)
    assert sub.status == SubStatus.QUEUED and sub.style == "short"
    assert session.get(Job, "j1").locked


def test_second_send_rejected(session):
    add_job(session, "j1")
    send(session, "j1")
    with pytest.raises(SendError, match="already has a proposal"):
        send(session, "j1")


def test_send_from_other_account_rejected(session):
    add_job(session, "j1", account="me")
    with pytest.raises(SendError, match="not selected"):
        send(session, "j1", account="friend_a")


def test_db_unique_constraint_blocks_duplicate(session, monkeypatch):
    add_job(session, "j1")
    send(session, "j1")
    from hub.services import job_state
    monkeypatch.setattr(job_state, "submission_for", lambda *a: None)  # simulate a logic bug skipping the check
    with pytest.raises(SendError, match="already has a proposal"):
        send(session, "j1")


def test_not_connected_paused_inactive(session):
    add_job(session, "j1")
    with pytest.raises(SendError, match="not connected"):
        send(session, "j1", connected=False)
    acc = session.get(Account, "me")
    acc.paused, acc.pause_reason = True, "captcha"
    session.add(acc)
    session.commit()
    with pytest.raises(SendError, match="paused"):
        send(session, "j1")
    acc.paused, acc.active = False, False
    session.add(acc)
    session.commit()
    with pytest.raises(SendError, match="inactive"):
        send(session, "j1")


def test_daily_limit(session):
    acc = session.get(Account, "me")
    acc.daily_limit = 2
    session.add(acc)
    session.commit()
    for i in range(2):
        add_job(session, f"j{i}")
        send(session, f"j{i}")
    add_job(session, "j9")
    with pytest.raises(SendError, match="daily limit"):
        send(session, "j9")


def test_draft_from_other_job_rejected(session):
    d1 = add_job(session, "j1")
    add_job(session, "j2")
    with pytest.raises(SendError, match="draft"):
        send(session, "j2", draft_id=d1)


# ---------------------------------------------------------------- dispatching

def run(coro):
    return asyncio.run(coro)


def test_dispatch_routes_only_to_assigned_account(session):
    add_job(session, "j1", account="friend_a")
    send(session, "j1", account="friend_a")
    mgr = FakeManager(["me", "friend_a"])
    q = SubmissionQueue(mgr, rng=random.Random(1))
    run(q.tick())
    assert mgr.conns["me"].sent == []
    assert len(mgr.conns["friend_a"].sent) == 1
    msg = mgr.conns["friend_a"].sent[0]
    assert msg["type"] == "submit" and msg["job_id"] == "j1" and msg["price"] == 100
    with Session(engine) as s:
        assert s.exec(select(Submission)).one().status == SubStatus.SENDING


def test_global_jitter_and_min_delay(session):
    for jid, acc in (("j1", "me"), ("j2", "friend_a"), ("j3", "me")):
        add_job(session, jid, account=acc)
        send(session, jid, account=acc)
    mgr = FakeManager(["me", "friend_a"])
    q = SubmissionQueue(mgr, rng=random.Random(1))
    t0 = utcnow()
    run(q.tick(t0))
    assert len(mgr.conns["me"].sent) == 1
    jitter = (q.next_global_at - t0).total_seconds()
    assert 20 <= jitter <= 90

    run(q.tick(t0 + timedelta(seconds=5)))  # inside jitter window -> nothing
    assert len(mgr.conns["friend_a"].sent) == 0

    run(q.tick(t0 + timedelta(seconds=91)))  # friend_a may go now
    assert len(mgr.conns["friend_a"].sent) == 1

    # "me" has j3 queued but j1 is still 'sending' -> busy; finish it
    sid1 = mgr.conns["me"].sent[0]["submission_id"]
    q.handle_result("me", {"submission_id": sid1, "status": "sent"})
    run(q.tick(t0 + timedelta(seconds=200)))  # min_delay 300s not yet elapsed for "me"
    assert len(mgr.conns["me"].sent) == 1
    run(q.tick(t0 + timedelta(seconds=301)))
    assert len(mgr.conns["me"].sent) == 2


def test_quiet_hours_block_dispatch(session):
    add_job(session, "j1")
    send(session, "j1")
    settings_store.set_many(session, {"quiet_hours": {"enabled": True, "start": "00:00", "end": "23:59"}})
    mgr = FakeManager(["me"])
    q = SubmissionQueue(mgr)
    run(q.tick())
    assert mgr.conns["me"].sent == []


def test_disconnected_extension_waits(session):
    add_job(session, "j1")
    send(session, "j1")
    mgr = FakeManager([])
    q = SubmissionQueue(mgr)
    run(q.tick())
    with Session(engine) as s:
        sub = s.exec(select(Submission)).one()
        assert sub.status == SubStatus.QUEUED
        assert q.queue_info(s, sub)["blocked"] == "extension disconnected"


# ---------------------------------------------------------------- results

def _dispatch_one(session, account="me", jid="j1"):
    add_job(session, jid, account=account)
    send(session, jid, account=account)
    mgr = FakeManager([account])
    q = SubmissionQueue(mgr)
    run(q.tick())
    return q, mgr.conns[account].sent[0]["submission_id"]


def test_result_sent_marks_job_sent(session):
    q, sid = _dispatch_one(session)
    q.handle_result("me", {"submission_id": sid, "status": "sent"})
    with Session(engine) as s:
        assert s.get(Submission, sid).status == SubStatus.SENT
        assert s.get(Job, "j1").status == JobStatus.SENT


def test_result_from_wrong_account_ignored(session):
    q, sid = _dispatch_one(session)
    q.handle_result("friend_a", {"submission_id": sid, "status": "sent"})
    with Session(engine) as s:
        assert s.get(Submission, sid).status == SubStatus.SENDING


@pytest.mark.parametrize("code,pauses", [("captcha", True), ("not_logged_in", True), ("no_credits", True),
                                         ("job_closed", False), ("form_not_found", False)])
def test_failure_codes_pause_account(session, code, pauses):
    q, sid = _dispatch_one(session)
    q.handle_result("me", {"submission_id": sid, "status": "failed", "error": code})
    with Session(engine) as s:
        sub = s.get(Submission, sid)
        assert sub.status == SubStatus.FAILED and sub.error.startswith(code)
        acc = s.get(Account, "me")
        assert acc.paused is pauses
        assert s.get(Job, "j1").locked  # still locked; human decides retry/cancel


def test_timeout_marks_failed(session):
    q, sid = _dispatch_one(session)
    run(q.tick(utcnow() + timedelta(hours=2)))
    with Session(engine) as s:
        assert s.get(Submission, sid).error.startswith("timeout")


def test_retry_and_cancel(session):
    q, sid = _dispatch_one(session)
    q.handle_result("me", {"submission_id": sid, "status": "failed", "error": "form_not_found"})
    with Session(engine) as s:
        sub = q.retry(s, sid)
        assert sub.status == SubStatus.QUEUED
        job, notify = q.cancel(s, sid)
        assert notify is None and not job.locked and job.status == JobStatus.DRAFTED
        assert s.get(Submission, sid) is None


# ---------------------------------------------------------------- multi-account

def test_multi_account_each_sends_once(session):
    add_job(session, "j1", account="me")
    job = session.get(Job, "j1")
    job.target_accounts = ["me", "friend_a"]
    session.add(job)
    session.commit()
    send(session, "j1", account="me")
    assert not session.get(Job, "j1").locked  # friend_a still to go
    send(session, "j1", account="friend_a")
    assert session.get(Job, "j1").locked
    with pytest.raises(SendError, match="already has a proposal"):
        send(session, "j1", account="friend_a")
    with pytest.raises(SendError, match="not selected"):
        send(session, "j1", account="friend_b")


def test_cancel_while_sending_and_mark_sent(session):
    q, sid = _dispatch_one(session)
    with Session(engine) as s:
        assert s.get(Submission, sid).status == SubStatus.SENDING
        job, notify = q.cancel(s, sid)
        assert notify == "me" and s.get(Submission, sid) is None and not job.locked
    q2, sid2 = _dispatch_one(session, jid="j2")
    q2.handle_result("me", {"submission_id": sid2, "status": "failed", "error": "timeout"})
    with Session(engine) as s:
        sub = q2.mark_sent(s, sid2)
        assert sub.status == SubStatus.SENT and s.get(Job, "j2").status == JobStatus.SENT
        with pytest.raises(SendError, match="already sent"):
            q2.cancel(s, sid2)


def test_dispatch_carries_attempt(session):
    q, sid = _dispatch_one(session)
    msg = q.manager.conns["me"].sent[-1]
    assert msg["submission_id"] == sid and msg["attempt"]
