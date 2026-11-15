"""v1.2: trust, notices, account rename/delete, history deletion, cancel-all, auto-send rules, translation helpers."""
import time
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from hub.db import engine
from hub.main import app
from hub.models import Draft, Event, Job, Notice, Submission, SubStatus, utcnow
from hub.services.trust import client_trust, meets

from test_ws_flow import GEN_REPLY, register  # noqa: E402 (tests dir is on sys.path)


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def add_job(jid, targets=("me",), status="drafted", **ci):
    with Session(engine) as s:
        s.add(Job(id=jid, url=f"https://www.workana.com/job/{jid}", title=f"Job {jid}", status=status,
                  assigned_account_id=targets[0], target_accounts=list(targets), budget_min=100, budget_max=200,
                  client_info=ci))
        for a in targets:
            s.add(Draft(job_id=jid, account_id=a, style="short", text="Hola, propuesta lista para usted.",
                        suggested_price=150, suggested_days=5))
        s.commit()


def add_sub(jid, account="me", status=SubStatus.SENT):
    with Session(engine) as s:
        sub = Submission(job_id=jid, account_id=account, final_text="Hola, propuesta lista.", price=150, days=5,
                         status=status)
        s.add(sub)
        s.commit()
        return sub.id


# ---------------------------------------------------------------- trust

def test_trust_tiers():
    today = date(2026, 11, 15)
    assert client_trust({}, today)["tier"] == "unknown"
    assert client_trust({"published": 1, "paid": 0}, today)["tier"] == "new"
    assert client_trust({"published": 4, "paid": 0}, today)["tier"] == "low"
    assert client_trust({"published": 10, "paid": 1}, today)["tier"] == "low"
    assert client_trust({"published": 6, "paid": 2}, today)["tier"] == "fair"
    assert client_trust({"published": 3, "paid": 2}, today)["tier"] == "good"
    hi = client_trust({"published": 8, "paid": 7, "member_since_text": "March 2023"}, today)
    assert hi["tier"] == "high" and hi["months"] == 44 and hi["score"] > 70
    assert meets("good", "fair") and not meets("new", "good") and meets("low", "any")


def test_job_payload_has_trust(client):
    add_job("t1", published=5, paid=5)
    assert client.get("/api/jobs").json()[0]["trust"]["tier"] == "high"


# ---------------------------------------------------------------- notices

def test_only_client_messages_become_alerts(client):
    """Alerts = client messages read from the conversation (li.other). The extension's list-watcher items and
    Workana's own notifications never become dashboard alerts; 'not accepted' still marks the bid rejected."""
    from hub.services import inbox

    add_job("logo-web")
    sid = add_sub("logo-web")
    list_item = {"kind": "message", "key": "logo-web|Hola", "title": "Cliente X", "body": "Hola",
                 "url": "https://www.workana.com/inbox/logo-web"}
    bell = {"kind": "notification", "key": "bell:1", "title": "Tu propuesta no fue aceptada",
            "body": "En Job logo-web", "url": "https://www.workana.com/users/notifications"}
    with client.websocket_connect("/ws/ext") as wk:
        assert register(wk, "workana", "me")["type"] == "registered"
        wk.send_json({"type": "notice", "items": [list_item, bell]})
        wk.send_json({"type": "counters", "messages": 2, "notifications": 1, "source": "tab"})
        wk.send_json({"type": "ping"})
        assert wk.receive_json() == {"type": "pong"}
    r = client.get("/api/notices").json()
    assert r["items"] == [] and r["counters"]["me"]["messages"] == 2
    with Session(engine) as s:
        assert s.get(Submission, sid).outcome == "rejected"

    # A client message read from the conversation is an alert (with its full text); your own reply is not.
    with Session(engine) as s:
        s.get(Submission, sid).outcome = "none"
        s.commit()
    th = {"slug": "logo-web", "method": "workana", "name": "Ana", "messages": [
        {"author": "", "mine": True, "text": "Mi propuesta", "time": "1"},
        {"author": "Ana", "mine": False, "text": "Hola, ¿podemos hablar mañana?", "time": "2"}]}
    inbox.on_result("me", {"id": "a", "ok": True, "slug": "logo-web", "thread": th})  # first read: baseline
    th["messages"].append({"author": "Ana", "mine": False, "text": "¿Le parece a las 10?", "time": "3"})
    th["messages"].append({"author": "", "mine": True, "text": "Sí, perfecto", "time": "4"})
    inbox.on_result("me", {"id": "b", "ok": True, "slug": "logo-web", "thread": th})
    items = client.get("/api/notices").json()["items"]
    assert [n["body"] for n in items] == ["¿Le parece a las 10?"] and items[0]["job_id"] == "logo-web"
    with Session(engine) as s:
        assert s.get(Submission, sid).outcome == "replied"
    assert client.post("/api/notices/read", json={"all": True}).json()["updated"] == 1
    assert client.post("/api/notices/test", json={}).json()["created"] == 1
    assert client.delete("/api/notices").json()["deleted"] == 2


def test_foreign_urls_are_dropped(client):
    from hub.services import notices

    out = notices.add("me", [{"kind": "message", "key": "k", "title": "x", "url": "https://evil.example/inbox/a"}])
    assert out[0]["url"] == ""


# ---------------------------------------------------------------- accounts

def test_rename_account_moves_everything(client):
    add_job("r1", targets=("me", "friend_a"))
    sid = add_sub("r1", "me")
    r = client.post("/api/accounts/me/rename", json={"new_id": "nate"})
    assert r.status_code == 200, r.text
    assert r.json()["id"] == "nate"
    job = client.get("/api/jobs/r1").json()
    assert job["targets"] == ["nate", "friend_a"] and job["assigned_account_id"] == "nate"
    assert "nate" in job["drafts_by_account"]
    with Session(engine) as s:
        assert s.get(Submission, sid).account_id == "nate"
    ids = [a["id"] for a in client.get("/api/accounts").json()]
    assert "me" not in ids and "nate" in ids
    assert client.post("/api/accounts/nate/rename", json={"new_id": "friend_a"}).status_code == 409
    assert client.post("/api/accounts/nate/rename", json={"new_id": "Bad Id!"}).status_code == 422


def test_delete_account_with_history(client):
    add_job("d1", targets=("friend_b", "friend_a"))
    add_sub("d1", "friend_b")
    assert client.delete("/api/accounts/friend_b").status_code == 409  # has bids
    assert client.get("/api/accounts/friend_b/history").json()["submissions"] == 1
    r = client.delete("/api/accounts/friend_b?purge=true")
    assert r.status_code == 200 and r.json()["submissions"] == 1
    job = client.get("/api/jobs/d1").json()
    assert job["targets"] == ["friend_a"] and job["submissions"] == []


def test_cannot_delete_account_while_sending(client):
    add_job("d2", targets=("friend_c",))
    add_sub("d2", "friend_c", SubStatus.SENDING)
    assert client.delete("/api/accounts/friend_c?purge=true").status_code == 409


# ---------------------------------------------------------------- history deletion

def test_delete_jobs_and_busy_protection(client):
    add_job("x1")
    add_job("x2")
    add_sub("x2", status=SubStatus.QUEUED)
    assert client.delete("/api/jobs/x1").status_code == 200
    assert client.delete("/api/jobs/x2").status_code == 409
    r = client.post("/api/jobs/delete", json={"job_ids": ["x2", "nope"]}).json()
    assert r["deleted"] == [] and set(r["kept"]) == {"x2", "nope"}
    with Session(engine) as s:
        assert s.get(Job, "x1") is None and not s.exec(select(Draft).where(Draft.job_id == "x1")).all()


def test_purge_jobs_keeps_sent_and_logs_clear(client):
    add_job("old-new", status="new")
    add_job("old-sent", status="sent")
    add_sub("old-sent")
    r = client.post("/api/maintenance/jobs/purge", json={"older_than_days": 0, "statuses": ["new", "sent"],
                                                        "keep_sent": True}).json()
    assert r["deleted"] == 1
    st = client.get("/api/maintenance/stats").json()
    assert st["jobs"] == 1 and st["logs"] > 0
    assert client.post("/api/maintenance/logs/clear", json={"older_than_days": 0}).json()["deleted"] > 0
    with Session(engine) as s:
        assert s.exec(select(Event)).all() == []


def test_purge_drafts_and_backup_and_retention(client):
    add_job("fin", status="sent")
    add_sub("fin")
    assert client.post("/api/maintenance/drafts/purge", json={"older_than_days": 0}).json()["deleted"] == 1
    r = client.get("/api/maintenance/backup")
    assert r.status_code == 200 and r.content[:16] == b"SQLite format 3\x00"
    client.put("/api/settings", json={"retention": {"enabled": True, "logs_days": 0, "jobs_days": 0, "notices_days": 0}})
    assert client.post("/api/maintenance/retention/run").json() == {"logs": 0, "jobs": 0, "notices": 0}


# ---------------------------------------------------------------- cancel-all + auto-send rules

def test_cancel_all_and_activity(client):
    add_job("c1")
    add_sub("c1", status=SubStatus.QUEUED)
    with Session(engine) as s:
        j = s.get(Job, "c1")
        j.auto_send = True
        s.add(j)
        s.commit()
    act = client.get("/api/activity").json()
    assert len(act["submissions"]) == 1 and act["auto_jobs"][0]["job_id"] == "c1"
    r = client.post("/api/control/cancel-all", json={}).json()
    assert r["submissions"] == 1 and r["auto_send_off"] == 1
    assert r["activity"]["submissions"] == [] and r["activity"]["auto_jobs"] == []


def _generate(client, gpt, jid):
    gen = gpt.receive_json()
    assert gen["type"] == "generate" and gen["temporary_chat"] is True and gen["delete_after"] is True
    gpt.send_json({"type": "generated", "request_id": gen["request_id"], "raw_text": GEN_REPLY})


def test_auto_send_review_window_and_guards(client):
    client.put("/api/settings", json={"auto_send": {"review_seconds": 300, "price_mode": "budget_max_pct",
                                                    "price_pct": 90, "min_trust": "fair"}})
    jobs = [{"id": "ok-client", "url": "https://www.workana.com/job/ok-client", "title": "A", "description": "d",
             "budget_text": "USD 100 - 250", "client_info": {"published": 4, "paid": 3}},
            {"id": "new-client", "url": "https://www.workana.com/job/new-client", "title": "B", "description": "d",
             "budget_text": "USD 100 - 250", "client_info": {"published": 1, "paid": 0}}]
    client.post("/api/jobs", json=jobs)
    with client.websocket_connect("/ws/ext") as gpt, client.websocket_connect("/ws/ext") as wk:
        register(gpt, "chatgpt")
        register(wk, "workana", "me")
        r = client.post("/api/jobs/batch", json={"job_ids": ["ok-client", "new-client"], "account_ids": ["me"],
                                                 "auto_send": True, "auto_style": ""})
        assert r.json()["generations_queued"] == 2
        client.put("/api/settings", json={"generation_pause_min_seconds": 0, "generation_pause_max_seconds": 0})
        _generate(client, gpt, "ok-client")
        _generate(client, gpt, "new-client")
        for _ in range(60):
            a = client.get("/api/jobs/ok-client").json()
            b = client.get("/api/jobs/new-client").json()
            if a["submissions"] and b["last_error"]:
                break
            time.sleep(0.1)
        sub = a["submissions"][0]
        assert sub["auto"] and sub["price"] == 225 and sub["status"] == "queued"  # 90% of 250
        assert "below the minimum" in b["last_error"] and b["submissions"] == []
        q = client.get("/api/activity").json()["submissions"][0]
        assert q["review_until"]  # held: nothing dispatched yet
        # "Send now" ends the review window -> dispatched
        assert client.post(f"/api/submissions/{sub['id']}/release").status_code == 200
        cmd = wk.receive_json()
        assert cmd["type"] == "submit" and cmd["submission_id"] == sub["id"]


def test_stop_cancels_running_generation(client):
    add_job("run1", status="new")
    with Session(engine) as s:
        s.exec(Draft.__table__.delete().where(Draft.job_id == "run1"))
        s.commit()
    with client.websocket_connect("/ws/ext") as gpt:
        register(gpt, "chatgpt")
        assert client.post("/api/jobs/run1/generate").status_code == 200
        gen = gpt.receive_json()
        r = client.post("/api/jobs/run1/stop-generation").json()
        assert r["current"] == 1
        cancel = gpt.receive_json()
        assert cancel == {"type": "cancel_generate", "request_id": gen["request_id"]}
        gpt.send_json({"type": "generated", "request_id": gen["request_id"], "raw_text": GEN_REPLY})  # too late
        for _ in range(30):
            job = client.get("/api/jobs/run1").json()
            if not job["generating_accounts"]:
                break
            time.sleep(0.1)
        assert job["drafts_by_account"] == {} and job["status"] == "new"


def test_delete_chatgpt_chats_command(client):
    import threading

    with client.websocket_connect("/ws/ext") as gpt:
        register(gpt, "chatgpt")
        out = {}
        t = threading.Thread(target=lambda: out.update(r=client.post("/api/maintenance/chatgpt/delete-chats", json={})))
        t.start()
        cmd = gpt.receive_json()
        assert cmd["type"] == "delete_chats"
        gpt.send_json({"type": "command_result", "request_id": cmd["request_id"], "deleted": 3, "failed": 0})
        t.join(10)
    assert out["r"].status_code == 200 and out["r"].json()["deleted"] == 3


# ---------------------------------------------------------------- translation helpers

def test_translation_helpers():
    from hub.api.translate import _chunks, plain

    assert plain("𝐇𝐨𝐥𝐚 𝗣𝗹𝗮𝗻") == "Hola Plan"
    long = ("párrafo " * 300 + "\n") * 5
    parts = _chunks(long)
    assert "".join(parts) == long and all(len(p) <= 4000 for p in parts)


def test_settings_validation(client):
    assert client.put("/api/settings", json={"auto_send": {"style_mode": "nope"}}).status_code == 422
    assert client.put("/api/settings", json={"translation": {"provider": "google", "target": "ko"}}).status_code == 200
    assert client.put("/api/settings", json={"retention": {"job_statuses": ["bogus"]}}).status_code == 422
    v = client.get("/api/settings").json()["values"]
    assert v["auto_send"]["review_seconds"] == 120 and v["chatgpt"]["delete_after_reply"] is True
    assert "retention_last_run" not in v
    _ = utcnow, Notice
