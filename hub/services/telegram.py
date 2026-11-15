"""Optional Telegram alerts for new jobs (Fetcher page -> Telegram)."""
from __future__ import annotations

import asyncio
import html
from typing import Any, Iterable

import httpx
from sqlmodel import Session

from .. import events
from ..config import config
from ..db import engine
from ..models import Account, Job
from . import settings_store

API = "https://api.telegram.org/bot{token}/sendMessage"


def chat_list(raw: str) -> list[str]:
    return [c.strip() for c in (raw or "").split(",") if c.strip()]


async def send(token: str, chat_ids: list[str], text: str) -> dict[str, str]:
    """Send to every chat. Returns {chat_id: "ok" | error}."""
    results: dict[str, str] = {}
    async with httpx.AsyncClient(timeout=15) as client:
        for cid in chat_ids:
            payload = {"chat_id": cid, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
            for attempt in range(3):
                try:
                    r = await client.post(API.format(token=token), json=payload)
                except httpx.HTTPError as e:
                    results[cid] = f"network error: {e}"
                    await asyncio.sleep(2 ** attempt)
                    continue
                if r.status_code == 200:
                    results[cid] = "ok"
                    break
                if r.status_code == 429:
                    try:
                        wait = float(r.json()["parameters"]["retry_after"])
                    except Exception:
                        wait = 5.0
                    await asyncio.sleep(wait + 0.5)
                    continue
                try:
                    results[cid] = r.json().get("description", f"HTTP {r.status_code}")
                except ValueError:
                    results[cid] = f"HTTP {r.status_code}"
                break
            await asyncio.sleep(0.4)
    return results


def job_message(job: Job, account: Account | None) -> str:
    e = html.escape
    ci: dict[str, Any] = job.client_info or {}
    desc = (job.description or "").strip()
    if len(desc) > 400:
        desc = desc[:397].rstrip() + "..."
    kind = "⏱ Hourly" if ci.get("hourly") else "🔒 Fixed"
    lines = [f'🆕 <b><a href="{e(job.url)}">{e(job.title)}</a></b>']
    if desc:
        lines += ["", e(desc)]
    lines += ["", f"💰 <b>Budget:</b> {e(job.budget_text or '—')}  <i>({kind})</i>"]
    if ci.get("country"):
        lines.append(f"🌎 <b>Country:</b> {e(str(ci['country']))}")
    if ci.get("language"):
        lines.append(f"🗣 <b>Language:</b> {e(str(ci['language']).upper())}")
    if job.category:
        lines.append(f"📂 <b>Category:</b> {e(job.category)}")
    if job.skills:
        lines.append(f"🏷 <b>Skills:</b> {e(', '.join(job.skills[:6]))}")
    client_bits = []
    if ci.get("member_since_text"):
        client_bits.append(f"since {ci['member_since_text']}")
    if ci.get("published") is not None:
        client_bits.append(f"{ci['published']} published")
    if ci.get("paid") is not None:
        client_bits.append(f"{ci['paid']} paid")
    if client_bits:
        lines.append(f"👤 <b>Client:</b> {e(', '.join(client_bits))}")
    if ci.get("bids") is not None:
        lines.append(f"📊 <b>Bids so far:</b> {e(str(ci['bids']))}")
    who = (account.display_name or account.id) if account else "unassigned"
    lines += ["", f"👥 <b>Assigned to:</b> {e(who)}",
              f'🖥 <a href="http://localhost:{config.PORT}/#/jobs/{e(job.id)}">Open in dashboard</a>']
    text = "\n".join(lines)
    return text[:3997] + "..." if len(text) > 4000 else text


async def notify_new_jobs(job_ids: Iterable[str]) -> None:
    ids = list(job_ids)
    if not ids:
        return
    with Session(engine) as s:
        tg = settings_store.get(s, "telegram")
        if not tg.get("enabled") or not tg.get("bot_token") or not chat_list(tg.get("chat_ids", "")):
            return
        messages = []
        for jid in ids:
            job = s.get(Job, jid)
            if job:
                acc = s.get(Account, job.assigned_account_id) if job.assigned_account_id else None
                messages.append((jid, job_message(job, acc)))
    for jid, text in messages:
        res = await send(tg["bot_token"], chat_list(tg["chat_ids"]), text)
        failed = {k: v for k, v in res.items() if v != "ok"}
        if failed:
            events.log("telegram", "delivery failed: " + "; ".join(f"{k}: {v}" for k, v in failed.items()),
                       "warn", job_id=jid)
