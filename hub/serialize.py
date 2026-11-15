"""Convert DB rows to JSON-friendly dicts (datetimes as ISO-8601 UTC with 'Z')."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from sqlalchemy import inspect
from sqlmodel import Session, select

from .models import Account, Draft, Job, Notice, Submission


def iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() + "Z" if dt else None


def _dump(obj: Any) -> dict[str, Any]:
    d = obj.model_dump()
    for k, v in d.items():
        if isinstance(v, datetime):
            d[k] = iso(v)
    return d


def submission_dict(sub: Submission, extra: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    d = _dump(_fresh(sub))
    if extra:
        d.update(extra)
    return d


def draft_dict(d: Draft) -> dict[str, Any]:
    return _dump(_fresh(d))


def _fresh(obj: Any) -> Any:
    """After a commit SQLAlchemy expires loaded rows; model_dump() would then return {} (an empty job
    reached the dashboard as a blank row). Reload expired rows before serializing."""
    st = inspect(obj)
    if st.persistent and st.expired_attributes and st.session is not None:
        st.session.refresh(obj)
    return obj


def job_dict(job: Job, s: Session, full: bool = False) -> dict[str, Any]:
    from .services.job_state import targets  # local import: job_state imports models only
    from .services.trust import client_trust

    d = _dump(_fresh(job))
    d["trust"] = client_trust(job.client_info)
    tg = targets(job)
    d["targets"] = tg
    subs = s.exec(select(Submission).where(Submission.job_id == job.id).order_by(Submission.id)).all()
    d["submissions"] = [submission_dict(x) for x in subs]
    focus = next((x for x in subs if x.account_id == job.assigned_account_id), None)
    d["submission"] = submission_dict(focus) if focus else None
    drafts = s.exec(select(Draft).where(Draft.job_id == job.id).order_by(Draft.id)).all()
    d["draft_accounts"] = sorted({x.account_id for x in drafts})
    if not full:
        desc = d.pop("description", "") or ""
        d["snippet"] = desc[:240]
        d["draft_count"] = sum(1 for x in drafts if x.account_id == job.assigned_account_id)
    else:
        by_acc: dict[str, list[dict[str, Any]]] = {}
        for x in drafts:
            by_acc.setdefault(x.account_id, []).append(draft_dict(x))
        d["drafts_by_account"] = by_acc
        d["drafts"] = by_acc.get(job.assigned_account_id or "", [])
    return d


def account_dict(acc: Account, extra: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    d = _dump(_fresh(acc))
    if extra:
        d.update(extra)
    return d


def notice_dict(n: Notice) -> dict[str, Any]:
    return _dump(_fresh(n))
