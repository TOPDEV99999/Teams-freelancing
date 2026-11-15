from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlmodel import Session, select

from ..config import config
from ..db import get_session
from ..events import event_dict
from ..models import Event
from ..services import notices, settings_store
from ..services.prompt import DEFAULT_STYLES, DEFAULT_TEMPLATE, TEMPLATE_VARIABLES
from ..state import generation, submissions
from ..serialize import iso
from ..ws.connection_manager import manager

router = APIRouter(prefix="/api", tags=["settings"])


@router.get("/settings")
def get_settings(s: Session = Depends(get_session)):
    return {
        "values": settings_store.get_all(s),
        "template_variables": TEMPLATE_VARIABLES,
        "defaults": {"master_prompt": DEFAULT_TEMPLATE, "styles": DEFAULT_STYLES},
        "env": {
            "fetcher": config.FETCHER,
            "openai_configured": bool(config.OPENAI_API_KEY),
            "generation_timeout_seconds": config.GENERATION_TIMEOUT_SECONDS,
            "submit_timeout_seconds": config.SUBMIT_TIMEOUT_SECONDS,
        },
    }


@router.put("/settings")
def put_settings(updates: dict[str, Any] = Body(...), s: Session = Depends(get_session)):
    try:
        values = settings_store.set_many(s, updates)
    except (ValueError, TypeError, AttributeError) as e:
        raise HTTPException(422, str(e))
    return {"values": values}


@router.get("/logs")
def get_logs(kind: Optional[str] = None, level: Optional[str] = None, limit: int = 500,
             s: Session = Depends(get_session)):
    stmt = select(Event)
    if kind:
        stmt = stmt.where(Event.kind == kind)
    if level:
        stmt = stmt.where(Event.level == level)
    stmt = stmt.order_by(Event.id.desc()).limit(max(1, min(limit, 500)))
    return [event_dict(e) for e in s.exec(stmt).all()]


# Extension version this hub expects (bump together with ext-*/src/config.ts VERSION).
EXPECTED_EXT_VERSION = "1.3.2"  # Workana extension
EXPECTED_CHATGPT_VERSION = "1.2.0"


def _build_id() -> str:
    """Changes whenever the dashboard is rebuilt: an open tab compares it to know it must reload."""
    import hashlib

    f = config.DASHBOARD_DIST / "index.html"
    try:
        return hashlib.sha1(f.read_bytes()).hexdigest()[:12]
    except OSError:
        return "dev"


BUILD_ID = _build_id()


def _fetcher_status() -> dict:
    from ..services.ingest import fetch_control as fc

    return {"running": fc.fetcher is not None, "busy": fc.busy, "last_run_at": iso(fc.last_run_at),
            "last_error": fc.last_error, "total_new": fc.total_new, "restarts": fc.restarts}


def _presence_status() -> dict:
    from ..services.presence import presence

    return presence.status()


@router.get("/status")
def status(s: Session = Depends(get_session)):
    return {
        "build": BUILD_ID,
        "expected_ext_version": EXPECTED_EXT_VERSION,
        "expected_chatgpt_version": EXPECTED_CHATGPT_VERSION,
        "extensions": manager.status(),
        "generation": generation.status(),
        "next_global_dispatch_at": iso(submissions.next_global_at),
        "quiet_hours_active": settings_store.in_quiet_hours(settings_store.get(s, "quiet_hours")),
        "secret_configured": bool(config.SHARED_SECRET) and config.SHARED_SECRET != "change-me",
        "counters": notices.counters,
        "presence": _presence_status(),
        "fetcher": {**_fetcher_status(), "enabled": bool(settings_store.get(s, "fetcher_enabled"))},
        "active_submissions": len(submissions.active(s)),
    }


@router.post("/settings/currency-rates/refresh")
async def refresh_currency_rates(s: Session = Depends(get_session)):
    """Today's BRL/MXN rates per 1 USD from a free public service (nothing about you is sent)."""
    from datetime import datetime, timezone

    from ..services import currency

    try:
        r = await currency.fetch_rates()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"could not get today's rates ({e}) - enter them manually")
    values = settings_store.set_many(s, {"currency_rates": {
        **r, "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"), "source": "open.er-api.com"}})
    return {"currency_rates": values["currency_rates"]}
