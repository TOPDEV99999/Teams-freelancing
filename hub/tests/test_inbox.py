"""Dashboard inbox: conversation list from the extension, reading a thread, replying, notices, page captures."""
import threading
import time

from hub.services import inbox
from hub.tests.test_ws_flow import register

THREAD = {"slug": "proj-1", "title": "Logo nuevo", "name": "Ana P.", "method": "workana", "messages": [
    {"author": "Yo", "mine": True, "text": "Mi propuesta para su logo", "time": "10:00"},
    {"author": "Ana P.", "mine": False, "text": "Hola, tengo una duda sobre los plazos", "time": "10:05"},
]}


def _wait(client, path, cond, tries=60):
    for _ in range(tries):
        r = client.get(path)
        if r.status_code == 200 and cond(r.json()):
            return r.json()
        time.sleep(0.05)
    raise AssertionError(f"condition not met for {path}: {client.get(path).text[:300]}")


def test_read_and_reply(client, tmp_path, monkeypatch):
    monkeypatch.setattr(inbox, "SNAP_DIR", tmp_path)
    with client.websocket_connect("/ws/ext") as wk:
        assert register(wk, "workana", "me")["type"] == "registered"
        wk.send_json({"type": "inbox_list", "items": [
            {"slug": "proj-1", "url": "https://www.workana.com/inbox/proj-1", "name": "Ana P.",
             "snippet": "Hola, tengo una duda", "unread": True}]})
        # A changed conversation is read automatically.
        cmd = wk.receive_json()
        assert cmd["type"] == "inbox_read" and cmd["slug"] == "proj-1"
        wk.send_json({"type": "inbox_result", "id": cmd["id"], "ok": True, "slug": "proj-1", "thread": THREAD})
        th = _wait(client, "/api/inbox/me/proj-1", lambda j: len(j["messages"]) == 2)
        assert th["conversation"]["name"] == "Ana P." and th["messages"][1]["text"].startswith("Hola, tengo")
        assert th["messages"][0]["mine"] and not th["messages"][1]["mine"]
        # The client's message (full text) is on the Inbox notices list.
        notes = client.get("/api/notices").json()["items"]
        assert any(n["kind"] == "message" and "plazos" in n["body"] and n["account_id"] == "me" for n in notes)

        # Reply from the dashboard: the extension receives the text, types it, reports back.
        out = {}
        t = threading.Thread(target=lambda: out.update(r=client.post("/api/inbox/me/proj-1/send", json={"text": "Claro, son 5 dias"})))
        t.start()
        cmd = wk.receive_json()
        assert cmd["type"] == "inbox_send" and cmd["text"] == "Claro, son 5 dias" and cmd["slug"] == "proj-1"
        sent = {**THREAD, "messages": THREAD["messages"] + [{"author": "Yo", "mine": True, "text": "Claro, son 5 dias", "time": "10:07"}]}
        wk.send_json({"type": "inbox_result", "id": cmd["id"], "ok": True, "verified": True, "slug": "proj-1", "thread": sent})
        t.join(10)
        r = out["r"]
        assert r.status_code == 200, r.text
        assert r.json()["verified"] and len(r.json()["messages"]) == 3 and r.json()["conversation"]["unread"] is False

        # A failed send is reported as an error.
        t = threading.Thread(target=lambda: out.update(r=client.post("/api/inbox/me/proj-1/send", json={"text": "otra"})))
        t.start()
        cmd = wk.receive_json()
        wk.send_json({"type": "inbox_result", "id": cmd["id"], "ok": False, "slug": "proj-1", "error": "send button not found"})
        t.join(10)
        assert out["r"].status_code == 502 and "send button" in out["r"].text

        # Page-structure capture is saved for tuning.
        wk.send_json({"type": "snapshot", "page": "thread", "path": "/inbox/proj-1", "reason": "test", "outline": "div.chat\n  p (text 12)"})
        for _ in range(40):
            if list(tmp_path.glob("*_me_thread.txt")):
                break
            time.sleep(0.05)
        assert list(tmp_path.glob("*_me_thread.txt"))

    # Offline account: clear error, nothing hangs.
    r = client.post("/api/inbox/friend_a/proj-1/send", json={"text": "hola"})
    assert r.status_code == 409 and "not connected" in r.text
    convs = client.get("/api/inbox/conversations?account=me").json()["items"]
    assert convs[0]["slug"] == "proj-1" and convs[0]["last"]["text"] == "Claro, son 5 dias"


def test_sent_bids_appear_as_conversations(client, session):
    from hub.models import Job, Submission, SubStatus
    session.add(Job(id="bid-job", url="https://www.workana.com/job/bid-job", title="Tienda online"))
    session.add(Submission(job_id="bid-job", account_id="friend_b", final_text="x", price=100, days=3, status=SubStatus.SENT))
    session.commit()
    convs = client.get("/api/inbox/conversations").json()["items"]
    c = next(c for c in convs if c["slug"] == "bid-job")
    assert c["account_id"] == "friend_b" and c["title"] == "Tienda online" and c["job_id"] == "bid-job"


def test_invalid_slug_rejected(client):
    assert client.post("/api/inbox/me/bad slug!/send", json={"text": "x"}).status_code in (400, 404, 409)


def test_rejected_notification_sets_outcome(client, session):
    from hub.models import Job, Submission, SubStatus
    from hub.services import notices
    session.add(Job(id="hot-1", url="https://www.workana.com/job/hot-1", title="Experto en Hotmart para Configuración Completa de Landing"))
    session.add(Submission(job_id="hot-1", account_id="me", final_text="x", price=100, days=3, status=SubStatus.SENT))
    session.commit()
    notices.add("me", [{"kind": "notification", "key": "bell:1", "title": "Tu propuesta no fue aceptada",
                        "body": "En Experto en Hotmart para Configuración Completa de Lan…", "url": "https://www.workana.com/users/notifications"}])
    subs = client.get("/api/jobs/hot-1").json()["submissions"]
    assert subs[0]["outcome"] == "rejected"
    # Unrelated notifications change nothing.
    notices.add("me", [{"kind": "notification", "key": "bell:2", "title": "Nuevo proyecto", "body": "En Otra cosa distinta"}])
    assert client.get("/api/jobs/hot-1").json()["submissions"][0]["outcome"] == "rejected"


def test_migration_drops_misread_messages(tmp_path):
    import sqlite3
    from sqlalchemy import create_engine
    from hub import db as hubdb
    path = tmp_path / "old.db"
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE conversations (id INTEGER PRIMARY KEY, account_id VARCHAR, slug VARCHAR, name VARCHAR, title VARCHAR, "
              "snippet VARCHAR, unread BOOLEAN, updated_at DATETIME, synced_at DATETIME, last_error VARCHAR)")
    c.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, account_id VARCHAR, slug VARCHAR, key VARCHAR, pos INTEGER, author VARCHAR, "
              "mine BOOLEAN, text VARCHAR, time_text VARCHAR, first_seen DATETIME)")
    c.execute("CREATE TABLE submissions (id INTEGER PRIMARY KEY, job_id VARCHAR, account_id VARCHAR)")
    c.execute("INSERT INTO conversations VALUES (1,'me','p','Nora K.','T','wrong',0,'2026-01-01','2026-01-01','')")
    c.execute("INSERT INTO messages VALUES (1,'me','p','k',0,'Nora K.',0,'Traductor Literario','', '2026-01-01')")
    c.commit(); c.close()
    old = hubdb.engine
    hubdb.engine = create_engine(f"sqlite:///{path.as_posix()}")
    try:
        hubdb._migrate()
        with hubdb.engine.connect() as conn:
            assert conn.exec_driver_sql("SELECT COUNT(*) FROM messages").scalar() == 0
            row = conn.exec_driver_sql("SELECT name, snippet, synced_at, parsed_v FROM conversations").one()
            assert tuple(row) == ("", "", None, 0)
        hubdb._migrate()  # idempotent
    finally:
        hubdb.engine.dispose()
        hubdb.engine = old



def test_unrecognised_page_never_stores_messages(client):
    """A thread read by the generic fallback / an outdated extension (the conversation LIST misread as messages)."""
    from hub.services import inbox as svc
    junk = {"slug": "proj-9", "name": "Nora K.", "method": "heuristic", "messages": [
        {"author": "", "mine": False, "text": "Nora K.\nTraductor Literario", "time": ""}]}
    svc.on_result("me", {"id": "x", "ok": True, "slug": "proj-9", "thread": junk})
    th = client.get("/api/inbox/me/proj-9").json()
    assert th["messages"] == [] and "not recognised" in th["conversation"]["last_error"]
    assert th["conversation"]["name"] != "Nora K."


def test_startup_drops_messages_not_read_with_workana_markup(client, session):
    from hub import db as hubdb
    from hub.models import Conversation, Message
    session.add(Conversation(account_id="friend_b", slug="old-1", name="LUIS G.", parsed_v=1))
    session.add(Message(account_id="friend_b", slug="old-1", key="k", text="Tomas B. Profissional"))
    session.add(Conversation(account_id="me", slug="good-1", name="Jones", parsed_v=2))
    session.add(Message(account_id="me", slug="good-1", key="k2", text="Hola, me interesa"))
    session.commit()
    hubdb._migrate()
    assert client.get("/api/inbox/friend_b/old-1").json()["messages"] == []
    assert client.get("/api/inbox/me/good-1").json()["messages"][0]["text"] == "Hola, me interesa"
