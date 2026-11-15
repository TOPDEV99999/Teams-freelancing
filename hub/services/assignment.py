"""Auto-assignment of jobs to accounts by keyword/category overlap + budget fit."""
from __future__ import annotations

import re
from typing import Any, Iterable

DISQUALIFIED = -1.0


def _norm(s: str) -> str:
    return (s or "").lower()


def _count(kw: str, text: str, cap: int) -> int:
    pattern = r"(?<!\w)" + re.escape(kw) + r"(?!\w)"
    return min(cap, len(re.findall(pattern, text)))


def score_account(job: Any, account: Any) -> float:
    """Higher is better. DISQUALIFIED if the budget is clearly below the account minimum."""
    if account.min_budget and job.budget_max is not None and job.budget_max < account.min_budget:
        return DISQUALIFIED

    title = _norm(job.title)
    desc = _norm(job.description)
    category = _norm(job.category or "")
    skills = {_norm(s).strip() for s in (job.skills or [])}

    score = 0.0
    for raw_kw in account.categories or []:
        kw = _norm(raw_kw).strip()
        if not kw:
            continue
        if kw in skills:
            score += 3
        if category and kw in category:
            score += 2
        score += 2 * _count(kw, title, 2)
        score += 1 * _count(kw, desc, 3)

    if score > 0 and account.min_budget and job.budget_min is not None and job.budget_min >= account.min_budget:
        score += 0.5
    return score


def choose_account(job: Any, accounts: Iterable[Any], threshold: float = 1.0) -> tuple[str | None, dict[str, float]]:
    scores: dict[str, float] = {}
    for acc in accounts:
        if not acc.active:
            continue
        scores[acc.id] = score_account(job, acc)
    if not scores:
        return None, scores
    # Highest score wins; ties broken alphabetically by account id (deterministic).
    best_id, best = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))[0]
    if best < max(threshold, 0.0001):
        return None, scores
    return best_id, scores


_NUM_RE = re.compile(r"\d[\d.,]*")
_LESS = ("less than", "menos de", "menos que", "até", "ate ", "up to", "hasta", "under")
_MORE = ("more than", "más de", "mas de", "mais de", "over", "above")


def _to_float(tok: str) -> float | None:
    tok = tok.strip(".,")
    if re.fullmatch(r"\d{1,3}([.,]\d{3})+", tok):
        tok = re.sub(r"[.,]", "", tok)  # thousands separators: 3.000 / 3,000
    else:
        tok = tok.replace(",", ".")
    try:
        return float(tok)
    except ValueError:
        return None


def parse_budget(text: str) -> tuple[float | None, float | None]:
    """Parse strings like 'USD 50 - 100', 'Menos de USD 50', 'Más de USD 3.000'."""
    if not text:
        return None, None
    low = text.lower()
    nums = [n for n in (_to_float(t) for t in _NUM_RE.findall(low)) if n is not None]
    if not nums:
        return None, None
    if any(w in low for w in _LESS):
        return None, nums[0]
    if any(w in low for w in _MORE):
        return nums[0], None
    if len(nums) >= 2:
        return min(nums[0], nums[1]), max(nums[0], nums[1])
    return nums[0], nums[0]
