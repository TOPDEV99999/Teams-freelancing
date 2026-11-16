"""Urgent mode: one job jumps ahead, everything else pauses, then the previous order resumes."""
import time
from datetime import timedelta

from sqlmodel import Session

from hub.db import engine
from hub.models import Draft, Job, Submission, SubStatus, utcnow
from hub.services.urgent import urgent
from hub.state import submissions
from hub.tests.test_ws_flow import register


def _job(jid, targets):
    with Session(engine) as s:
        s.add(Job(id=jid, url=f"https://www.workana.com/job/{jid}", title=f"Job {jid}", status="drafted",
                  assigned_account_id=targets[0], target_accounts=list(targets), budget_min=100, budget_max=200,
                  client_info={"published": 3, "paid": 3}))
        for a in targets:
            s.add(Draft(job_id=jid, account_id=a, style="short", text="Hola, propuesta lista para usted.",
                        suggested_price=150, suggested_days=5))
        s.commit()


def _until(fn, tries=80):
    for _ in range(tries):
        v = fn()
        if v:
            return v
        time.sleep(0.1)
    raise AssertionError("condition not met")


def test_urgent_job_jumps_ahead_then_queue_resumes(client):
    client.put("/api/settings", json={"jitter_min_seconds": 60, "jitter_max_seconds": 90,
                                      "auto_send": {"review_seconds": 300}})
    client.patch("/api/accounts/me", json={"min_delay_seconds": 3600})
    _job("normal-1", ["me"])
    _job("hot-1", ["me", "friend_a"])
    with Session(engine) as s:  # a normal proposal waiting in the queue (queued first)
        s.add(Submission(job_id="normal-1", account_id="me", final_text="Hola, propuesta normal.", price=150, days=5,
                         status=SubStatus.QUEUED))
        s.commit()
    # "me" just sent a bid and the global random gap is running: normally nothing would go out for a while.
    with Session(engine) as s:
        s.add(Submission(job_id="normal-1", account_id="friend_b", final_text="x" * 30, price=1, days=1,
                         status=SubStatus.SENT, dispatched_at=utcnow()))
        s.commit()
    submissions.next_global_at = utcnow() + timedelta(minutes=5)

    with client.websocket_connect("/ws/ext") as me, client.websocket_connect("/ws/ext") as fa:
        register(me, "workana", "me")
        register(fa, "workana", "friend_a")
        r = client.post("/api/jobs/hot-1/urgent").json()
        assert sorted(r["queued_now"]) == ["friend_a", "me"] and r["urgent"]["job_id"] == "hot-1"
        st = client.get("/api/status").json()
        assert st["urgent"]["job_id"] == "hot-1"
        # The other job's proposal shows as paused for the urgent job.
        normal = client.get("/api/jobs/normal-1").json()["submissions"]
        assert any("urgent job first" in (x.get("blocked") or "") for x in normal if x["status"] == "queued")

        # Urgent proposals go out right away: no review window, no random gap, no per-account delay.
        got = {}
        for ws in (me, fa):
            cmd = ws.receive_json()
            assert cmd["type"] == "submit" and cmd["job_id"] == "hot-1"
            got[ws] = cmd
        # The normal job's proposal was NOT sent meanwhile; urgent mode is still on until results arrive.
        assert client.get("/api/status").json()["urgent"] is not None
        for ws, cmd in got.items():
            ws.send_json({"type": "result", "submission_id": cmd["submission_id"], "status": "sent"})
        _until(lambda: client.get("/api/status").json()["urgent"] is None)

        # The previous order resumes with the normal rules (here: release the gap/delay to see it go).
        client.patch("/api/accounts/me", json={"min_delay_seconds": 0})
        submissions.next_global_at = None
        cmd = me.receive_json()
        assert cmd["type"] == "submit" and cmd["job_id"] == "normal-1"
    with Session(engine) as s:  # auto-send of the urgent job was switched back off
        assert s.get(Job, "hot-1").auto_send is False
    submissions.next_global_at = None  # don't leave the random gap running for the next test


def test_urgent_generates_first_and_can_be_ended(client):
    from hub.state import generation

    with Session(engine) as s:
        s.add(Job(id="nodraft", url="https://www.workana.com/job/nodraft", title="Job nodraft", status="new",
                  assigned_account_id="me", target_accounts=["me"]))
        s.commit()
    generation.queued.extend([("other-a", "me"), ("other-b", "me")])  # waiting generations of other jobs
    try:
        r = client.post("/api/jobs/nodraft/urgent").json()
        assert r["generating"] == ["me"]
        # Taken first, ahead of the two waiting generations of other jobs (which stay queued).
        _until(lambda: ("nodraft", "me") not in generation.queued)
        assert ("other-a", "me") in generation.queued and ("other-b", "me") in generation.queued
        assert client.delete("/api/urgent").json()["ended"] == "nodraft"
        assert client.get("/api/status").json()["urgent"] is None
    finally:
        generation.queued[:] = [x for x in generation.queued if x[0] not in ("other-a", "other-b", "nodraft")]
        urgent.end("test cleanup")


def test_cancel_everything_ends_urgent(client):
    _job("hot-2", ["me"])
    with Session(engine) as s:
        urgent.start(s, "hot-2")
    assert urgent.job_id == "hot-2"
    client.post("/api/control/cancel-all", json={})
    assert urgent.job_id is None
