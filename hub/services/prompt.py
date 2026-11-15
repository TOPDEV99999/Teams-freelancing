"""Prompt template rendering and robust parsing of the model's JSON reply."""
from __future__ import annotations

import json
import re
from typing import Any

DEFAULT_STYLES: list[dict[str, str]] = [
    {"key": "formal", "instructions": "professional, structured, 120–180 words"},
    {"key": "friendly", "instructions": "warm, conversational, 100–150 words"},
    {"key": "short", "instructions": "direct, under 70 words"},
    {"key": "technical", "instructions": "focuses on approach, tools and steps, 120–200 words"},
]

DEFAULT_TEMPLATE = """You are writing Workana proposals for a freelancer.

FREELANCER PROFILE:
{account.profile_text}

JOB:
Title: {job.title}
Budget: {job.budget_text}
Skills: {job.skills}
Description:
{job.description}

Write {style_count} proposals in the SAME LANGUAGE as the job description, one per style:
{styles}

Rules:
- Reference specific details from the job description.
- Only claim skills/experience present in the freelancer profile. Never invent experience.
- No placeholders like [Name]. No generic filler.
- End with one relevant question for the client.
- Suggest a price within the budget and a delivery time in days.

Return ONLY valid JSON, no markdown fences:
{json_format}"""

TEMPLATE_VARIABLES = [
    "account.profile_text", "account.display_name", "account.default_rate",
    "job.title", "job.description", "job.budget_text", "job.skills", "job.category", "job.url",
    "job.client", "job.client_json", "job.client_name",
    "styles", "style_count", "json_format",
]

RETRY_SUFFIX = "\n\nIMPORTANT: Return only valid JSON. No prose, no markdown fences."

_VAR_RE = re.compile(r"\{([a-z_]+(?:\.[a-z_]+)?)\}")


_LANGS = {"es": "Spanish", "pt": "Portuguese", "en": "English", "fr": "French", "it": "Italian", "de": "German"}


def client_facts(ci: dict | None) -> dict[str, Any]:
    """The client facts that help write a proposal (name, country, history...), without internal fields."""
    from .trust import client_trust

    ci = ci or {}
    out: dict[str, Any] = {}
    name = str(ci.get("client") or "").strip()
    if name:
        out["name"] = name
    if ci.get("country"):
        out["country"] = ci["country"]
    if ci.get("language"):
        out["job_language"] = _LANGS.get(ci["language"], ci["language"])
    if "hourly" in ci:
        out["job_type"] = "hourly" if ci.get("hourly") else "fixed price"
    if isinstance(ci.get("payment_verified"), bool):
        out["payment_verified"] = ci["payment_verified"]
    if isinstance(ci.get("rating"), (int, float)) and not isinstance(ci.get("rating"), bool) and ci["rating"] > 0:
        out["rating"] = round(float(ci["rating"]), 2)
    tr = client_trust(ci)
    if tr["tier"] != "unknown":
        out["projects_published"] = tr["published"]
        out["projects_paid"] = tr["paid"]
        out["trust"] = tr["label"].split(" · ")[0]
    if ci.get("member_since_text") or ci.get("member_since"):
        out["member_since"] = ci.get("member_since_text") or ci.get("member_since")
    if tr.get("months") is not None:
        out["member_months"] = tr["months"]
    for k, name in (("bids", "proposals_already_sent"), ("interested", "freelancers_interested")):
        v = ci.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[name] = int(v)
    return out


_CLIENT_LABELS = {
    "name": "Name",
    "country": "Country", "job_language": "Job language", "job_type": "Job type",
    "payment_verified": "Payment method verified", "rating": "Rating from freelancers",
    "trust": "Payment reliability", "member_since": "Member since",
    "proposals_already_sent": "Proposals already sent", "freelancers_interested": "Freelancers interested",
}


def client_text(facts: dict[str, Any]) -> str:
    if not facts:
        return "(no client information available)"
    lines = []
    for k, v in facts.items():
        if k not in _CLIENT_LABELS:
            continue
        if k == "payment_verified":
            v = "yes" if v else "no"
        elif k == "rating":
            v = f"{v}/5"
        elif k == "trust":
            v = f"{v} (paid {facts['projects_paid']} of {facts['projects_published']} published projects)"
        elif k == "member_since" and facts.get("member_months") is not None:
            v = f"{v} ({facts['member_months']} months)"
        lines.append(f"- {_CLIENT_LABELS[k]}: {v}")
    return "\n".join(lines)


def json_format_for(style_keys: list[str]) -> str:
    obj: dict[str, Any] = {k: "..." for k in style_keys}
    obj["price"] = 0
    obj["days"] = 0
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def build_prompt(template: str, job: Any, account: Any, styles: list[dict[str, str]]) -> str:
    keys = [s["key"] for s in styles]
    facts = client_facts(getattr(job, "client_info", None))
    values = {
        "account.profile_text": (account.profile_text or "").strip() or "(no profile provided)",
        "account.display_name": account.display_name or account.id,
        "account.default_rate": "" if account.default_rate is None else f"{account.default_rate:g}",
        "job.title": job.title or "",
        "job.description": job.description or "",
        "job.budget_text": job.budget_text or "not specified",
        "job.skills": ", ".join(job.skills or []) or "not specified",
        "job.category": job.category or "",
        "job.url": job.url or "",
        "job.client": client_text(facts),
        "job.client_json": json.dumps(facts, ensure_ascii=False),
        "job.client_name": facts.get("name", ""),
        "styles": "\n".join(f"- {s['key']}: {s.get('instructions', '')}" for s in styles),
        "style_count": str(len(styles)),
        "json_format": json_format_for(keys),
    }
    # Only known {var} tokens are replaced, so literal JSON braces stay intact.
    return _VAR_RE.sub(lambda m: values.get(m.group(1), m.group(0)), template)


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        m = re.search(r"\d+(?:[.,]\d+)?", v.replace(" ", ""))
        if m:
            return float(m.group(0).replace(",", "."))
    return None


def parse_generation(raw: str, style_keys: list[str]) -> dict[str, Any] | None:
    """Return {"texts": {style: text}, "price": float|None, "days": int|None} or None."""
    if not raw:
        return None
    s = raw.strip()
    s = re.sub(r"^```(?:json)?\s*", "", s, flags=re.I)
    s = re.sub(r"\s*```\s*$", "", s)
    i, j = s.find("{"), s.rfind("}")
    if i < 0 or j <= i:
        return None
    try:
        obj = json.loads(s[i : j + 1], strict=False)  # strict=False tolerates raw newlines
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    lower = {str(k).strip().lower(): v for k, v in obj.items()}
    texts = {
        k: lower[k].strip()
        for k in style_keys
        if isinstance(lower.get(k), str) and lower[k].strip()
    }
    if not texts:
        return None
    price = _num(lower.get("price"))
    days_f = _num(lower.get("days"))
    days = int(round(days_f)) if days_f else None
    return {"texts": texts, "price": price if price else None, "days": days if days and days > 0 else None}
