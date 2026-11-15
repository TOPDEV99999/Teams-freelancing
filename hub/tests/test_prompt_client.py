from types import SimpleNamespace

from hub.services.prompt import build_prompt

STYLES = [{"key": "short", "instructions": "x"}]
ACC = SimpleNamespace(id="me", profile_text="p", display_name="Me", default_rate=None)


def job(ci):
    return SimpleNamespace(title="T", description="D", budget_text="USD 100", skills=[], category="", url="",
                           client_info=ci)


def test_client_variables():
    ci = {"country": "Argentina", "client": "Secret Name", "hourly": False, "language": "es",
          "payment_verified": True, "rating": 4.8, "published": 8, "paid": 7, "bids": 12,
          "client_profile": "/e/x", "member_since_text": "Abril 2023"}
    out = build_prompt("{job.client}|{job.client_json}|{job.client_name}", job(ci), ACC, STYLES)
    text, js, name = out.split("|", 2)
    assert text.startswith("- Name: Secret Name") and '"name": "Secret Name"' in js and name == "Secret Name"
    assert "- Country: Argentina" in text and "paid 7 of 8" in text and "Proposals already sent: 12" in text
    assert "Payment method verified: yes" in text and "4.8/5" in text and "fixed price" in text
    assert '"projects_paid": 7' in js and '"country": "Argentina"' in js
    assert "/e/x" not in out


def test_client_empty():
    assert build_prompt("{job.client}", job({}), ACC, STYLES) == "(no client information available)"
    assert build_prompt("{job.client_json}", job(None), ACC, STYLES) == "{}"
    assert build_prompt("Hi {job.client_name}!", job({}), ACC, STYLES) == "Hi !"
