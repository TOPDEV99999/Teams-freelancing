"""Per-account bid currency: prices are decided in USD, converted only for the Workana form."""
import time

from sqlmodel import Session

from hub.db import engine
from hub.services import currency
from hub.services.submission_queue import create_submission
from hub.tests.test_v12_features import _generate, add_job
from hub.tests.test_ws_flow import register


def test_conversion_and_rates(client):
    with Session(engine) as s:
        assert currency.to_local(s, 200, "BRL") == 1080 and currency.to_local(s, 200, "MXN") == 3700
        assert currency.to_local(s, 200, "USD") == 200 and currency.to_local(s, 200, "xyz") == 200
    assert client.put("/api/settings", json={"currency_rates": {"BRL": 5.0, "MXN": 20}}).status_code == 200
    with Session(engine) as s:
        assert currency.to_local(s, 200, "BRL") == 1000 and round(currency.to_usd(s, 1000, "BRL")) == 200
    assert client.put("/api/settings", json={"currency_rates": {"BRL": -1, "MXN": 20}}).status_code == 422


def test_account_currency_and_manual_send(client):
    assert client.patch("/api/accounts/friend_a", json={"currency": "brl"}).json()["currency"] == "BRL"
    assert client.patch("/api/accounts/friend_a", json={"currency": "EUR"}).status_code == 422
    add_job("cur-1", targets=("friend_a",))
    with Session(engine) as s:
        sub = create_submission(s, job_id="cur-1", account_id="friend_a", draft_id=None, final_text="Olá, proposta pronta para você.",
                                price=1080, days=5, ext_connected=True)
        assert (sub.price, sub.currency) == (1080, "BRL")


def test_auto_send_converts_after_usd_rules(client):
    """Budget clamp + min/max run in USD; the queued amount is in the account's currency."""
    client.patch("/api/accounts/me", json={"currency": "MXN"})
    client.put("/api/settings", json={"currency_rates": {"BRL": 5.4, "MXN": 18.5},
                                      "auto_send": {"review_seconds": 300, "price_mode": "budget_max_pct", "price_pct": 90,
                                                    "max_price": 240}})
    client.post("/api/jobs", json=[{"id": "mx-1", "url": "https://www.workana.com/job/mx-1", "title": "A", "description": "d",
                                    "budget_text": "USD 100 - 250", "client_info": {"published": 4, "paid": 3}}])
    with client.websocket_connect("/ws/ext") as gpt, client.websocket_connect("/ws/ext") as wk:
        register(gpt, "chatgpt")
        register(wk, "workana", "me")
        client.post("/api/jobs/batch", json={"job_ids": ["mx-1"], "account_ids": ["me"], "auto_send": True, "auto_style": ""})
        client.put("/api/settings", json={"generation_pause_min_seconds": 0, "generation_pause_max_seconds": 0})
        _generate(client, gpt, "mx-1")
        for _ in range(60):
            j = client.get("/api/jobs/mx-1").json()
            if j["submissions"]:
                break
            time.sleep(0.1)
    sub = j["submissions"][0]
    # 90% of USD 250 = USD 225 (below the USD 240 maximum, so allowed) -> MX$ 4,163 typed into Workana.
    assert sub["currency"] == "MXN" and sub["price"] == round(225 * 18.5)


def test_refresh_rates(client, monkeypatch):
    async def fake():
        return {"BRL": 5.12, "MXN": 17.9}
    monkeypatch.setattr(currency, "fetch_rates", fake)
    r = client.post("/api/settings/currency-rates/refresh").json()["currency_rates"]
    assert r["BRL"] == 5.12 and r["MXN"] == 17.9 and r["source"] == "open.er-api.com"
