from __future__ import annotations

import re
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, delete, select

from .. import events
from ..db import get_session
from ..models import Account, Job, Submission
from ..serialize import account_dict, iso
from ..services.submission_queue import last_dispatch, today_count
from ..ws.connection_manager import manager

router = APIRouter(prefix="/api", tags=["accounts"])

_ID_RE = re.compile(r"^[a-z0-9_\-]{2,32}$")


def account_payload(s: Session, acc: Account) -> dict:
    last = last_dispatch(s, acc.id)
    return account_dict(acc, {
        "ext_connected": manager.is_workana_connected(acc.id),
        "today_count": today_count(s, acc.id),
        "last_dispatch_at": iso(last),
        "next_allowed_at": iso(last + timedelta(seconds=acc.min_delay_seconds)) if last else None,
    })


class AccountIn(BaseModel):
    display_name: Optional[str] = None
    chrome_profile: Optional[str] = None
    profile_text: Optional[str] = None
    prompt_template: Optional[str] = None
    categories: Optional[list[str]] = None
    min_budget: Optional[float] = None
    default_rate: Optional[float] = None
    currency: Optional[str] = None
    daily_limit: Optional[int] = Field(default=None, ge=0, le=200)
    min_delay_seconds: Optional[int] = Field(default=None, ge=0, le=86400)
    active: Optional[bool] = None
    auto_generate: Optional[bool] = None


class AccountCreate(AccountIn):
    id: str


def _apply(acc: Account, body: AccountIn) -> None:
    data = body.model_dump(exclude_unset=True)
    data.pop("id", None)
    if "currency" in data:
        from ..services.currency import CURRENCIES
        cur = str(data["currency"] or "USD").upper()
        if cur not in CURRENCIES:
            raise HTTPException(422, f"currency must be one of {', '.join(CURRENCIES)}")
        data["currency"] = cur
    if "categories" in data and data["categories"] is not None:
        data["categories"] = [c.strip() for c in data["categories"] if c and c.strip()]
    for k, v in data.items():
        setattr(acc, k, v)


@router.get("/accounts")
def list_accounts(s: Session = Depends(get_session)):
    return [account_payload(s, a) for a in s.exec(select(Account).order_by(Account.id)).all()]


@router.post("/accounts", status_code=201)
def create_account(body: AccountCreate, s: Session = Depends(get_session)):
    aid = body.id.strip().lower()
    if not _ID_RE.match(aid):
        raise HTTPException(422, "id must be 2-32 chars: a-z, 0-9, _ or -")
    if s.get(Account, aid):
        raise HTTPException(409, "account id already exists")
    acc = Account(id=aid)
    _apply(acc, body)
    acc.display_name = acc.display_name or aid
    s.add(acc)
    s.commit()
    s.refresh(acc)
    events.log("system", f"account {aid} created", account_id=aid)
    payload = account_payload(s, acc)
    events.notify("account_updated", payload)
    return payload


@router.patch("/accounts/{account_id}")
def update_account(account_id: str, body: AccountIn, s: Session = Depends(get_session)):
    acc = s.get(Account, account_id)
    if acc is None:
        raise HTTPException(404, "account not found")
    _apply(acc, body)
    s.add(acc)
    s.commit()
    s.refresh(acc)
    payload = account_payload(s, acc)
    events.notify("account_updated", payload)
    return payload


@router.post("/accounts/{account_id}/resume")
def resume_account(account_id: str, s: Session = Depends(get_session)):
    acc = s.get(Account, account_id)
    if acc is None:
        raise HTTPException(404, "account not found")
    acc.paused = False
    acc.pause_reason = None
    s.add(acc)
    s.commit()
    s.refresh(acc)
    events.log("system", f"account {account_id} resumed", account_id=account_id)
    payload = account_payload(s, acc)
    events.notify("account_updated", payload)
    return payload


def _history(s: Session, account_id: str) -> dict[str, int]:
    from sqlalchemy import func

    from ..models import Draft, Notice

    def n(model, col) -> int:
        return s.exec(select(func.count()).select_from(model).where(col == account_id)).one()

    return {"submissions": n(Submission, Submission.account_id), "drafts": n(Draft, Draft.account_id),
            "notices": n(Notice, Notice.account_id)}


@router.get("/accounts/{account_id}/history")
def account_history(account_id: str, s: Session = Depends(get_session)):
    if s.get(Account, account_id) is None:
        raise HTTPException(404, "account not found")
    return _history(s, account_id)


async def _disconnect_ext(account_id: str, reason: str) -> None:
    conn = manager.get_workana(account_id)
    if conn is None:
        return
    try:
        await conn.send({"type": "register_error", "error": reason})
        await conn.ws.close(code=4404)
    except Exception:  # noqa: BLE001
        pass
    from ..ws.ext_ws import on_disconnect

    await on_disconnect(conn, reason="account renamed or deleted")


def _busy(s: Session, account_id: str) -> Optional[str]:
    from ..models import SubStatus
    from ..state import generation

    if s.exec(select(Submission.id).where(Submission.account_id == account_id,
                                          Submission.status == SubStatus.SENDING)).first():
        return "a proposal of this account is being sent right now - wait or cancel it first"
    if generation.current and generation.current[1] == account_id:
        return "ChatGPT is writing for this account right now - wait or stop it first"
    return None


class RenameBody(BaseModel):
    new_id: str


@router.post("/accounts/{account_id}/rename")
async def rename_account(account_id: str, body: RenameBody, s: Session = Depends(get_session)):
    """Change an account's ID everywhere (jobs, drafts, bids, logs, notices). The Workana extension popup of that
    profile must then use the new ID."""
    from ..services import notices, settings_store
    from ..state import generation

    acc = s.get(Account, account_id)
    if acc is None:
        raise HTTPException(404, "account not found")
    new = body.new_id.strip().lower()
    if new == account_id:
        return account_payload(s, acc)
    if not _ID_RE.match(new):
        raise HTTPException(422, "id must be 2-32 chars: a-z, 0-9, _ or -")
    if s.get(Account, new):
        raise HTTPException(409, f"account id '{new}' already exists")
    if why := _busy(s, account_id):
        raise HTTPException(409, why)
    await _disconnect_ext(account_id, f"account id changed to '{new}' - update the Account ID in this popup")
    conn = s.connection()
    for table, col in (("accounts", "id"), ("drafts", "account_id"), ("submissions", "account_id"), ("events", "account_id"),
                       ("notices", "account_id"), ("conversations", "account_id"), ("messages", "account_id"),
                       ("jobs", "assigned_account_id")):
        conn.exec_driver_sql(f"UPDATE {table} SET {col} = ? WHERE {col} = ?", (new, account_id))
    s.commit()
    s.expire_all()
    for job in s.exec(select(Job)).all():
        if account_id not in (job.target_accounts or []):
            continue
        job.target_accounts = [new if a == account_id else a for a in job.target_accounts or []]
        s.add(job)
    rules = settings_store.get(s, "auto_send")
    if account_id in (rules.get("autopilot_accounts") or []):
        rules["autopilot_accounts"] = [new if a == account_id else a for a in rules["autopilot_accounts"]]
        settings_store.set_many(s, {"auto_send": rules})
    s.commit()
    generation.rename_account(account_id, new)
    notices.rename(account_id, new)
    from ..services import inbox
    inbox.rename(account_id, new)
    acc = s.get(Account, new)
    events.log("system", f"account '{account_id}' renamed to '{new}' - set Account ID = {new} in that profile's "
                         "Workana extension popup", "warn", account_id=new)
    events.notify("account_deleted", {"id": account_id})
    payload = account_payload(s, acc)
    events.notify("account_updated", payload)
    events.notify("reload", {"reason": "account renamed"})
    return payload


@router.delete("/accounts/{account_id}")
async def delete_account(account_id: str, purge: bool = False, s: Session = Depends(get_session)):
    """Delete an account. With purge=true its bids, drafts and notices are deleted too (job history of other
    accounts stays). Without purge an account that has bids is refused."""
    from ..models import Draft, Notice
    from ..services import job_state
    from ..state import generation

    acc = s.get(Account, account_id)
    if acc is None:
        raise HTTPException(404, "account not found")
    hist = _history(s, account_id)
    if hist["submissions"] and not purge:
        raise HTTPException(409, f"account has {hist['submissions']} bid(s) in its history - "
                                 "delete it together with its history, or deactivate it instead")
    if why := _busy(s, account_id):
        raise HTTPException(409, why)
    generation.drop_account(account_id)
    await _disconnect_ext(account_id, f"account '{account_id}' was deleted on the dashboard")
    touched: list[Job] = []
    for job in s.exec(select(Job)).all():
        if job.assigned_account_id != account_id and account_id not in (job.target_accounts or []):
            continue
        job.target_accounts = [a for a in (job.target_accounts or []) if a != account_id]
        if job.assigned_account_id == account_id:
            job.assigned_account_id = job.target_accounts[0] if job.target_accounts else None
        s.add(job)
        touched.append(job)
    s.exec(delete(Submission).where(Submission.account_id == account_id))
    s.exec(delete(Draft).where(Draft.account_id == account_id))
    s.exec(delete(Notice).where(Notice.account_id == account_id))
    from ..services import inbox
    inbox.drop_account(s, account_id)
    s.delete(acc)
    s.flush()
    for job in touched:
        job_state.refresh(s, job)
        s.add(job)
    s.commit()
    extra = f" together with {hist['submissions']} bid(s) and {hist['drafts']} draft(s)" if purge else ""
    events.log("system", f"account {account_id} deleted{extra}")
    events.notify("account_deleted", {"id": account_id})
    if touched or hist["submissions"]:
        events.notify("reload", {"reason": "account deleted"})
    return {"deleted": account_id, **hist}
