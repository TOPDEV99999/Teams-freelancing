import json

from hub.fetcher import workana_fetcher as wf
from hub.services import settings_store

# Trimmed copies of the structure seen on live job pages (Nov 2026).
OPEN_PAGE = """<section class="project-view-v3"> <header id="productName">
  <span class="pry label rounded open">Evaluating bids</span> <h1 class="h3 title">X</h1></header>
  <div class="item-data"><p class="h4">3</p> <p>Published projects</p></div>
  <div class="item-data"><p class="h4">2</p> <p>Projects paid</p></div>
  <div class="item-data"><p>Member since: March 2024</p></div>
  <p class="h4">Project activity</p><div class="item-data"><p class="h4">19</p> <p>Bids</p></div>"""
ESCROW_PAGE = OPEN_PAGE.replace("pry label rounded open", "pry label rounded escrowing").replace(
    "Evaluating bids", "Waiting for escrow")


def project(slug, budget="USD 250 - 500", hourly=False, skills=("wordpress",), featured=False):
    return {
        "slug": slug,
        "title": f'<a href="/job/{slug}"><span title="Title {slug}">Title {slug}</span></a>',
        "authorName": "O. P.",
        "description": "Necesito una web.<br/>\n<br /><br />Category: <strong>IT &amp; Programming</strong>"
                       "<br />Subcategory: <strong>Web development</strong><br />",
        "budget": budget, "isHourly": hourly, "isSearchFeatured": featured, "postedDate": "5 minutes ago",
        "skills": [{"anchorText": s.title(), "anchorLink": f"https://www.workana.com/jobs?skills={s}"} for s in skills],
    }


def test_parse_job_page():
    info = wf.parse_job_page(OPEN_PAGE)
    assert info["is_open"] is True and info["status"] == "Evaluating bids"
    assert info["member_since"] == "2024-03" and info["published"] == 3 and info["paid"] == 2 and info["bids"] == 19
    closed = wf.parse_job_page(ESCROW_PAGE)
    assert closed["is_open"] is False and closed["status_key"] == "escrowing"


def test_split_description_and_budget():
    desc, cat, sub = wf.split_description(project("a")["description"])
    assert desc == "Necesito una web." and cat == "IT & Programming" and sub == "Web development"
    assert wf.parse_budget("USD 1.000 - 3.000") == (1000, 3000)
    assert wf.parse_budget("Más de USD 3.000") == (3000, None)
    assert wf.parse_budget("Menos de USD 50") == (0.0, 50)
    assert wf.parse_budget("USD 500 - 1,000") == (500, 1000)
    assert wf.parse_budget("Over USD 3,000") == (3000, None)
    assert wf.parse_budget("USD 15 - 45 / hour") == (15, 45)
    assert wf._to_number("1.000,50") == 1000.5 and wf._to_number("1,000.50") == 1000.5 and wf._to_number("12,5") == 12.5


def test_filters():
    f = dict(settings_store.DEFAULT_WORKANA_FILTERS, min_budget=250, skills=["wordpress"])
    assert wf.budget_ok(project("a"), f)[0]
    assert not wf.budget_ok(project("a", budget="USD 100 - 250"), f)[0]
    assert not wf.budget_ok(project("a", hourly=True, budget="USD 5 - 10 / hora"), dict(f, min_hourly_rate=15))[0]
    assert not wf.budget_ok(project("a", hourly=True), dict(f, allow_hourly=False))[0]
    assert wf.skills_ok(project("a"), f) and not wf.skills_ok(project("a", skills=("python",)), f)
    assert not wf.client_ok(wf.parse_job_page(ESCROW_PAGE), f)[0]
    assert not wf.client_ok(wf.parse_job_page(OPEN_PAGE), dict(f, min_client_since="2024-01"))[0]
    assert wf.client_ok(wf.parse_job_page(OPEN_PAGE), dict(f, min_client_since="2025-01"))[0]
    assert not wf.client_ok(wf.parse_job_page(OPEN_PAGE), dict(f, min_paid_ratio=0.9))[0]


def test_filters_validation():
    v = settings_store._workana_filters({"languages": ["ES", "pt"], "skills": "WordPress, python", "min_client_since": "2026-9"})
    assert v["languages"] == ["es", "pt"] and v["skills"] == ["python", "wordpress"] and v["min_client_since"] == "2026-09"


def test_cycle_seeds_then_returns_new_jobs(tmp_path, monkeypatch):
    f = wf.WorkanaFetcher(state_file=tmp_path / "seen.json")
    listing = {"es": [project("old-1"), project("old-2")]}
    pages = {"new-ok": OPEN_PAGE, "new-closed": ESCROW_PAGE}
    monkeypatch.setattr(f, "_get_list", lambda lang, imp: listing.get(lang, []))
    monkeypatch.setattr(f, "_job_page", lambda slug, imp: wf.parse_job_page(pages.get(slug, OPEN_PAGE)))
    monkeypatch.setattr(wf.time, "sleep", lambda s: None)

    assert f._cycle() == []  # first run only records what's listed
    assert f.h["seeded"] and json.loads((tmp_path / "seen.json").read_text())["seeded_langs"] == ["es", "pt"]

    listing["es"] = [project("new-ok"), project("new-closed"), project("new-cheap", budget="USD 10 - 30"),
                     project("promo", featured=True), project("old-1")]
    jobs = f._cycle()
    assert [j.id for j in jobs] == ["new-ok"]
    j = jobs[0]
    assert j.title == "Title new-ok" and j.category == "IT & Programming" and j.budget_min == 250
    assert j.client_info["language"] == "es" and j.client_info["bids"] == 19
    assert f._cycle() == []  # nothing new the second time

    f2 = wf.WorkanaFetcher(state_file=tmp_path / "seen.json")  # state survives restarts
    assert f2.h["seeded"] and "new-ok" in f2.seen_set

    # Adding a language later: its existing listing is recorded, not imported.
    monkeypatch.setattr(settings_store, "get", lambda s, k: dict(settings_store.DEFAULT_WORKANA_FILTERS, languages=["es", "en"]))
    listing["en"] = [project("english-old")]
    assert f._cycle() == [] and "english-old" in f.seen_set and f.seeded_langs == {"es", "pt", "en"}
    listing["en"].append(project("english-new"))
    assert [j.id for j in f._cycle()] == ["english-new"]


def test_account_prompt_overrides_master(client):
    r = client.patch("/api/accounts/me", json={"prompt_template": "MY PROMPT {job.title} {json_format}"})
    assert r.status_code == 200 and r.json()["prompt_template"].startswith("MY PROMPT")
    p = client.post("/api/prompts/preview", json={"account_id": "me"}).json()
    assert p["source"] == "account" and p["prompt"].startswith("MY PROMPT ") and "{json_format}" not in p["prompt"]
    p2 = client.post("/api/prompts/preview", json={"account_id": "friend_a"}).json()
    assert p2["source"] == "master" and p2["warnings"] == []
    p3 = client.post("/api/prompts/preview", json={"account_id": "me", "template": "no vars"}).json()
    assert len(p3["warnings"]) == 2


def test_fetcher_settings_api(client):
    r = client.put("/api/settings", json={"workana_filters": {"languages": ["xx"]}})
    assert r.status_code == 422
    r = client.put("/api/settings", json={"workana_filters": {"languages": ["en"], "min_budget": 50}})
    assert r.status_code == 200 and r.json()["values"]["workana_filters"]["min_budget"] == 50
    assert r.json()["values"]["workana_filters"]["skip_closed"] is True  # defaults merged
    assert client.put("/api/settings", json={"telegram": {"enabled": True}}).status_code == 422
    assert client.get("/api/fetcher").json()["enabled"] is True
    assert client.post("/api/fetcher/stop").json()["enabled"] is False
    assert client.post("/api/fetcher/start").json()["enabled"] is True


def test_parse_job_page_spanish_and_portuguese():
    es = ('<header id="productName"><span class="pry label rounded open">Evaluando propuestas</span></header>'
          '<p class="h4">614</p> <p>Proyectos publicados</p><p class="h4">607</p> <p>Proyectos pagos</p>'
          '<p>Miembro desde: Febrero, 2020</p><p class="h4">22</p> <p>Propuestas</p>')
    info = wf.parse_job_page(es)
    assert info == {**info, "is_open": True, "published": 614, "paid": 607, "member_since": "2020-02", "bids": 22}
    pt = '<p>Membro desde: Fevereiro 2020</p><p class="h4">5</p> <p>Projetos pagos</p>'
    assert wf.parse_job_page(pt)["member_since"] == "2020-02" and wf.parse_job_page(pt)["paid"] == 5
