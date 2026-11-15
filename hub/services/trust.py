"""Client trustworthiness from the public job page (projects published / paid, member since).

Tiers (best first): high · good · fair · new · low · unknown. `score` (0-100) is only for sorting.
"""
from __future__ import annotations

import re
from datetime import date
from typing import Any, Optional

TIERS = ("high", "good", "fair", "new", "low", "unknown")
# Order used by "minimum trust" filters: a tier passes when its rank >= the minimum's rank.
RANK = {"unknown": 0, "low": 0, "new": 1, "fair": 2, "good": 3, "high": 4}

_MONTHS = {m: i + 1 for i, m in enumerate(
    "january february march april may june july august september october november december".split())}
_MONTHS.update({m: i + 1 for i, m in enumerate(
    "enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre".split())})
_MONTHS.update({m: i + 1 for i, m in enumerate(
    "janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro".split())})


def _int(v: Any) -> Optional[int]:
    try:
        return None if v is None or v == "" else int(v)
    except (TypeError, ValueError):
        return None


def member_months(ci: dict[str, Any], today: Optional[date] = None) -> Optional[int]:
    """Months since the client joined (from member_since 'YYYY-MM' or member_since_text 'November 2026')."""
    today = today or date.today()
    y = m = None
    ms = str(ci.get("member_since") or "")
    if re.fullmatch(r"\d{4}-\d{2}", ms):
        y, m = int(ms[:4]), int(ms[5:])
    else:
        t = re.match(r"\s*([A-Za-zÀ-ÿ]+)\s+(?:de\s+)?(\d{4})", str(ci.get("member_since_text") or ""))
        if t and t.group(1).lower() in _MONTHS:
            y, m = int(t.group(2)), _MONTHS[t.group(1).lower()]
    if y is None:
        return None
    return max(0, (today.year - y) * 12 + today.month - m)


def client_trust(ci: Optional[dict[str, Any]], today: Optional[date] = None) -> dict[str, Any]:
    ci = ci or {}
    pub, paid = _int(ci.get("published")), _int(ci.get("paid"))
    months = member_months(ci, today)
    verified = ci.get("payment_verified")
    if pub is None and paid is None:
        return {"tier": "unknown", "score": 0, "label": "no client data",
                "reasons": ["the job page was not checked (Fetcher → 'check job page')"]}
    pub = max(pub or 0, paid or 0)
    paid = paid or 0
    ratio = paid / pub if pub else 0.0
    reasons = [f"{paid} of {pub} published project{'s' if pub != 1 else ''} paid"]
    if months is not None:
        reasons.append(f"member for {months} month{'s' if months != 1 else ''}")
    if verified is True:
        reasons.append("payment method verified")
    elif verified is False:
        reasons.append("payment method NOT verified")
    rating = ci.get("rating")
    if isinstance(rating, (int, float)) and rating > 0:
        reasons.append(f"rated {rating:.2f}/5 by freelancers")

    if pub >= 3 and paid == 0:
        tier = "low"
        reasons.append("has published several projects but never paid one")
    elif pub >= 5 and ratio < 0.2:
        tier = "low"
        reasons.append("pays very few of the projects it publishes")
    elif paid == 0:
        tier = "new"
        reasons.append("no payment history yet (new client)")
    elif (paid >= 5 and ratio >= 0.6) or (paid >= 10 and ratio >= 0.4):
        tier = "high"
    elif ratio >= 0.4:
        tier = "good"
    else:
        tier = "fair"

    score = min(paid, 10) * 5 + ratio * 30 + (min(months, 24) / 24 * 15 if months is not None else 0) \
        + (5 if verified is True else 0) + (max(0.0, float(rating) - 4) * 5 if isinstance(rating, (int, float)) else 0)
    if tier == "low":
        score = min(score, 15)
    label = {"high": "very reliable", "good": "reliable", "fair": "pays sometimes", "new": "new client",
             "low": "risky"}[tier]
    return {"tier": tier, "score": round(score), "label": f"{label} · paid {paid}/{pub}", "reasons": reasons,
            "paid": paid, "published": pub, "months": months}


def meets(tier: str, minimum: str) -> bool:
    """minimum: any | new | fair | good | high."""
    if not minimum or minimum == "any":
        return True
    return RANK.get(tier, 0) >= RANK.get(minimum, 0)
