"""Client last-seen from public profiles (no network: the HTTP getter is faked)."""
from datetime import datetime

from sqlmodel import Session

from hub.db import engine
from hub.models import Job, utcnow
from hub.services.presence import (PresenceService, client_profile_path, parse_absolute, parse_profile,
                                   parse_relative)

# Same shape as a real public profile (Nov 2026): JSON inside an HTML attribute, HTML-escaped.
PROFILE = ('<div data-props="{&quot;stats&quot;:{&quot;paid&quot;:&quot;Projects paid: 1&quot;,'
           '&quot;lastLogin&quot;:&quot;Last login: \\u003Cstrong title=\\u0022November 14, 2026 04:54\\u0022\\u003E'
           '10 hours ago\\u003C\\/strong\\u003E&quot;,&quot;registeredSince&quot;:&quot;x&quot;},'
           '&quot;hasVerifiedPaymentMethod&quot;:true}"></div>')
JOB_PAGE = ('<article><div class="wk-user-info"><div class="profile-photo">'
            '<a href="/e/7464df820ede49bc1dfd60c3e3970e3f" rel="nofollow"><img></a></div></div></article>')


def test_parsers():
    assert client_profile_path(JOB_PAGE) == "/e/7464df820ede49bc1dfd60c3e3970e3f"
    # Workana time is UTC-3
    assert parse_absolute("November 14, 2026 04:54") == datetime(2026, 11, 14, 7, 54)
    assert parse_absolute("14 de noviembre de 2026 04:54") == datetime(2026, 11, 14, 7, 54)
    assert parse_relative("10 hours ago") == 36000
    assert parse_relative("a minute ago") == 60
    assert parse_relative("hace 3 días") == 3 * 86400
    assert parse_relative("há 2 horas") == 7200
    assert parse_relative("just now") == 0


def test_parse_profile_prefers_exact_time_when_consistent():
    now = datetime(2026, 11, 14, 18, 30)
    p = parse_profile(PROFILE, now)
    assert p["last_login"] == "2026-11-14T07:54:00Z" and p["last_login_text"] == "10 hours ago"
    assert p["payment_verified"] is True
    # Inconsistent absolute time (e.g. a time-zone change) -> the "N ago" text wins
    p2 = parse_profile(PROFILE, datetime(2026, 11, 20, 18, 30))
    assert p2["last_login"] == "2026-11-20T08:30:00Z"


def _job(jid, status="new", **ci):
    with Session(engine) as s:
        s.add(Job(id=jid, url=f"https://www.workana.com/job/{jid}", title=jid, status=status, client_info=ci))
        s.commit()


def test_check_flow_and_selection():
    calls = []

    def fake_get(url):
        calls.append(url)
        return (200, JOB_PAGE) if "/job/" in url else (200, PROFILE)

    svc = PresenceService(get=fake_get)
    _job("open-1")
    _job("sent-1", status="sent")
    import hub.services.presence as pm
    pm.MIN_GAP_S = pm.MAX_GAP_S = 0
    with Session(engine) as s:
        cfg = {"enabled": True, "interval_minutes": 10, "max_age_hours": 48}
        job = svc.due(s, cfg)
        assert job.id == "open-1"  # sent jobs are not polled
    svc.check("open-1")
    assert calls == ["https://www.workana.com/job/open-1", "https://www.workana.com/e/7464df820ede49bc1dfd60c3e3970e3f"]
    with Session(engine) as s:
        ci = s.get(Job, "open-1").client_info
        assert ci["client_profile"].startswith("/e/") and ci["last_login"] and ci["presence_checked_at"]
        assert svc.due(s, cfg) is None  # just checked -> not due again yet
    svc.check("open-1")  # profile link is cached: one request only
    assert len(calls) == 3
    # A sent job opened in the dashboard is refreshed anyway (priority)
    svc.watch("sent-1")
    with Session(engine) as s:
        assert svc.due(s, cfg).id == "sent-1"


def test_block_pauses_service():
    svc = PresenceService(get=lambda url: (403, "Just a moment..."))
    _job("blk", client_profile="/e/abc")
    assert svc.check("blk") is None
    assert svc.status()["paused_s"] > 1700
    with Session(engine) as s:
        assert "presence_checked_at" not in s.get(Job, "blk").client_info


def test_trust_uses_rating_and_verified(client):
    from hub.services.trust import client_trust

    t = client_trust({"published": 3, "paid": 2, "rating": 4.9, "payment_verified": False})
    assert any("rated 4.90" in r for r in t["reasons"]) and any("NOT verified" in r for r in t["reasons"])
    assert client.put("/api/settings", json={"presence": {"enabled": False, "interval_minutes": 1}}).json()[
        "values"]["presence"] == {"enabled": False, "interval_minutes": 5, "max_age_hours": 48}
    _ = utcnow
