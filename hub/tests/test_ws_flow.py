"""End-to-end over real WebSockets: register, generate, send, result."""
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from hub.main import app

GEN_REPLY = ('```json\n{"formal":"Estimado cliente, propuesta formal detallada.","friendly":"Hola! propuesta amigable.",'
             '"short":"Propuesta corta y directa para usted.","technical":"Enfoque técnico paso a paso.",'
             '"price":180,"days":6}\n```')


def register(ws, role, account=None, token="test-secret"):
    msg = {"type": "register", "role": role, "token": token, "version": "test"}
    if account:
        msg["account"] = account
    ws.send_json(msg)
    r = ws.receive_json()
    if r.get("type") == "registered" and role == "workana":
        cfg = ws.receive_json()  # the hub sends the inbox setting right after registration
        assert cfg["type"] == "inbox_config"
    return r


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def test_bad_token_rejected(client):
    with client.websocket_connect("/ws/ext") as ws:
        r = register(ws, "chatgpt", token="wrong")
        assert r["type"] == "register_error"
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_unknown_account_rejected(client):
    with client.websocket_connect("/ws/ext") as ws:
        assert register(ws, "workana", "nobody")["type"] == "register_error"


def test_duplicate_workana_rejected(client):
    with client.websocket_connect("/ws/ext") as ws1:
        assert register(ws1, "workana", "me")["type"] == "registered"
        with client.websocket_connect("/ws/ext") as ws2:
            r = register(ws2, "workana", "me")
            assert r["type"] == "register_error" and "already" in r["error"]


def test_ping_pong(client):
    with client.websocket_connect("/ws/ext") as ws:
        register(ws, "chatgpt")
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}


def test_full_flow(client):
    # No random 20-90 s gap between bids here: it made this test fail by chance when the gap exceeded 60 s.
    client.put("/api/settings", json={"jitter_min_seconds": 0, "jitter_max_seconds": 0})
    from hub.state import submissions
    submissions.next_global_at = None
    client.patch("/api/accounts/friend_a", json={"categories": ["wordpress", "elementor"],
                                                 "profile_text": "WordPress dev"})
    r = client.post("/api/jobs", json=[{
        "id": "wp-landing", "url": "https://www.workana.com/job/wp-landing", "title": "Landing en WordPress",
        "description": "Landing con Elementor", "budget_text": "USD 100 - 250", "skills": ["WordPress"]}])
    assert r.json()["inserted"] == ["wp-landing"]
    job = client.get("/api/jobs/wp-landing").json()
    assert job["assigned_account_id"] == "friend_a"
    assert job["budget_min"] == 100 and job["budget_max"] == 250

    with client.websocket_connect("/ws/ext") as gpt, client.websocket_connect("/ws/ext") as wk_a, \
            client.websocket_connect("/ws/ext") as wk_me:
        assert register(gpt, "chatgpt")["type"] == "registered"
        assert register(wk_a, "workana", "friend_a")["type"] == "registered"
        assert register(wk_me, "workana", "me")["type"] == "registered"

        # Generate -> ChatGPT extension gets the prompt
        assert client.post("/api/jobs/wp-landing/generate").status_code == 200
        gen = gpt.receive_json()
        assert gen["type"] == "generate" and "WordPress dev" in gen["prompt"]
        gpt.send_json({"type": "generated", "request_id": gen["request_id"], "raw_text": GEN_REPLY})

        for _ in range(50):
            job = client.get("/api/jobs/wp-landing").json()
            if job["status"] == "drafted":
                break
            time.sleep(0.1)
        assert job["status"] == "drafted"
        assert {d["style"] for d in job["drafts"]} == {"formal", "friendly", "short", "technical"}
        draft = next(d for d in job["drafts"] if d["style"] == "short")
        assert draft["suggested_price"] == 180 and draft["suggested_days"] == 6

        # Wrong account -> rejected
        bad = client.post("/api/jobs/wp-landing/send", json={
            "account_id": "me", "draft_id": draft["id"], "final_text": draft["text"] + " extra", "price": 180, "days": 6})
        assert bad.status_code == 409

        ok = client.post("/api/jobs/wp-landing/send", json={
            "account_id": "friend_a", "draft_id": draft["id"], "final_text": draft["text"] + " extra",
            "price": 180, "days": 6})
        assert ok.status_code == 200, ok.text

        # Second send -> rejected
        again = client.post("/api/jobs/wp-landing/send", json={
            "account_id": "friend_a", "draft_id": draft["id"], "final_text": draft["text"] + " extra",
            "price": 180, "days": 6})
        assert again.status_code == 409

        # Only friend_a's extension receives the submit command
        cmd = wk_a.receive_json()
        assert cmd["type"] == "submit" and cmd["job_id"] == "wp-landing" and cmd["price"] == 180
        wk_a.send_json({"type": "result", "submission_id": cmd["submission_id"], "status": "sent"})
        for _ in range(50):
            job = client.get("/api/jobs/wp-landing").json()
            if job["status"] == "sent":
                break
            time.sleep(0.1)
        assert job["status"] == "sent" and job["submission"]["status"] == "sent"

        wk_me.send_json({"type": "ping"})
        assert wk_me.receive_json() == {"type": "pong"}  # 'me' never got a submit


def test_trusted_host_blocks_foreign_host(client):
    r = client.get("/api/accounts", headers={"host": "evil.example.com"})
    assert r.status_code == 400


def _wait(client, path, cond, tries=60):
    for _ in range(tries):
        data = client.get(path).json()
        if cond(data):
            return data
        time.sleep(0.1)
    return data


def test_batch_multi_account_sequential_auto_send(client):
    jobs = [{"id": f"multi-{i}", "url": f"https://www.workana.com/job/multi-{i}", "title": f"Multi {i}",
             "description": "Necesito una web", "budget_text": "USD 100 - 250"} for i in (1, 2)]
    client.post("/api/jobs", json=jobs)
    client.put("/api/settings", json={"generation_pause_min_seconds": 0, "generation_pause_max_seconds": 0,
                                      "auto_send": {"review_seconds": 0}})

    with client.websocket_connect("/ws/ext") as gpt, client.websocket_connect("/ws/ext") as wk_me, \
            client.websocket_connect("/ws/ext") as wk_a:
        register(gpt, "chatgpt")
        register(wk_me, "workana", "me")
        register(wk_a, "workana", "friend_a")

        r = client.post("/api/jobs/batch", json={"job_ids": ["multi-1", "multi-2"], "account_ids": ["me", "friend_a"],
                                                 "auto_send": True, "auto_style": "short"})
        assert r.status_code == 200 and r.json()["generations_queued"] == 4
        job = client.get("/api/jobs/multi-1").json()
        assert job["targets"] == ["me", "friend_a"] and job["auto_send"] and job["status"] == "generating"

        # ChatGPT gets ONE prompt at a time, job by job, account by account.
        order = []
        for _ in range(4):
            gen = gpt.receive_json()
            assert gen["type"] == "generate"
            order.append((gen["job_id"], gen["account_id"]))
            gpt.send_json({"type": "generated", "request_id": gen["request_id"], "raw_text": GEN_REPLY})
        assert order == [("multi-1", "me"), ("multi-1", "friend_a"), ("multi-2", "me"), ("multi-2", "friend_a")]

        # Each account's drafts are kept separately and auto-send queued one submission per (job, account).
        job = _wait(client, "/api/jobs/multi-2", lambda j: len(j["submissions"]) == 2)
        assert set(job["drafts_by_account"]) == {"me", "friend_a"}
        assert {x["account_id"] for x in job["submissions"]} == {"me", "friend_a"}
        # price 180 suggested, clamped into the job's budget (USD 100 - 250) -> stays 180
        assert all(x["style"] == "short" and x["price"] == 180 for x in job["submissions"])
        assert job["locked"]  # every selected account has its proposal

        # The queue dispatches to the right profile; cancel while sending tells that extension to stop.
        from hub.state import submissions
        submissions.next_global_at = None  # skip the global jitter left over from earlier tests
        cmd = wk_me.receive_json()
        assert cmd["type"] == "submit" and cmd["attempt"]
        c = client.post(f"/api/submissions/{cmd['submission_id']}/cancel")
        assert c.status_code == 200
        assert wk_me.receive_json() == {"type": "cancel", "submission_id": cmd["submission_id"]}
        job = client.get(f"/api/jobs/{cmd['job_id']}").json()
        assert not job["locked"] and "me" not in {x["account_id"] for x in job["submissions"]}

        # Removing an account from the targets is refused for accounts that already have a submission.
        j = client.patch("/api/jobs/multi-2", json={"target_accounts": ["me"]}).json()
        assert set(j["targets"]) == {"me", "friend_a"}


def test_generation_pause_recovery_and_matching(client):
    from hub.db import engine
    from hub.models import Job
    from hub.state import generation
    from sqlmodel import Session

    # Pause settings are validated
    assert client.put("/api/settings", json={"generation_pause_min_seconds": 50, "generation_pause_max_seconds": 10}).status_code == 422
    assert client.put("/api/settings", json={"generation_pause_min_seconds": 15, "generation_pause_max_seconds": 45}).status_code == 200

    # New job matching two accounts -> both pre-selected, best first
    client.patch("/api/accounts/me", json={"categories": ["python"]})
    client.patch("/api/accounts/friend_b", json={"categories": ["python", "django"]})
    client.post("/api/jobs", json=[{"id": "py-1", "url": "https://www.workana.com/job/py-1", "title": "Python Django API",
                                     "description": "python django", "budget_text": "USD 100 - 250", "skills": ["Python"]}])
    job = client.get("/api/jobs/py-1").json()
    assert job["assigned_account_id"] == "friend_b" and job["targets"] == ["friend_b", "me"]

    # A job left 'generating' by a crash is reset on startup
    with Session(engine) as s:
        j = s.get(Job, "py-1")
        j.status = "generating"
        s.add(j)
        s.commit()
    generation.recover_on_startup()
    job = client.get("/api/jobs/py-1").json()
    assert job["status"] == "new" and "restart" in job["last_error"]

    # Stop generation drops queued items
    generation.queued.extend([("py-1", "me"), ("py-1", "friend_b")])
    r = client.post("/api/jobs/py-1/stop-generation").json()
    assert r["dropped"] == 2 and not generation.queued


def test_serializers_never_send_empty_rows(client):
    """Regression: a row expired by commit() serialized to {} and showed up as a blank job in the dashboard."""
    from sqlmodel import Session
    from hub.db import engine
    from hub.models import Account, Job
    from hub.serialize import account_dict, job_dict

    client.post("/api/jobs", json=[{"id": "exp-1", "url": "https://www.workana.com/job/exp-1", "title": "Expired row"}])
    with Session(engine) as s:
        job = s.get(Job, "exp-1")
        job.auto_send = True
        s.add(job)
        s.commit()  # expires job
        d = job_dict(job, s)
        assert d["id"] == "exp-1" and d["title"] == "Expired row"
        acc = s.get(Account, "me")
        acc.paused = False
        s.add(acc)
        s.commit()
        assert account_dict(acc)["id"] == "me"
