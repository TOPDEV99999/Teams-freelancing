"""Job ingestion (dedupe + assignment + broadcast) and the background fetch loop."""
from __future__ import annotations

import asyncio
import random
from datetime import datetime, timedelta
from typing import Callable, Iterable

from sqlmodel import Session, select

from .. import events
from ..db import engine
from ..fetcher.base import JobFetcher, JobIn
from ..models import Account, Job, JobStatus, utcnow
from ..serialize import iso, job_dict
from . import settings_store
from .assignment import choose_account, parse_budget


def ingest(jobs_in: Iterable[JobIn], enqueue_generation: Callable[[str], bool] | None = None) -> list[str]:
    """Insert new jobs, auto-assign, broadcast. Returns IDs of newly inserted jobs."""
    new_ids: list[str] = []
    auto_gen: list[str] = []
    with Session(engine) as s:
        accounts = s.exec(select(Account).where(Account.active == True)).all()  # noqa: E712
        threshold = float(settings_store.get(s, "assign_threshold"))
        rules = settings_store.get(s, "auto_send")
        notes: list[tuple[str, str]] = []
        seen: set[str] = set()
        for j in jobs_in:
            jid = str(j.id).strip()
            if not jid or jid in seen or s.get(Job, jid) is not None:
                continue
            seen.add(jid)
            bmin, bmax = j.budget_min, j.budget_max
            if bmin is None and bmax is None:
                bmin, bmax = parse_budget(j.budget_text)
            job = Job(
                id=jid, url=j.url, title=j.title, description=j.description, budget_text=j.budget_text,
                budget_min=bmin, budget_max=bmax, category=j.category, skills=list(j.skills or []),
                client_info=dict(j.client_info or {}), posted_at=j.posted_at, status=JobStatus.NEW,
            )
            best, scores = choose_account(job, accounts, threshold)
            job.assigned_account_id = best
            if best:
                # Pre-select every account that matches (best first) for multi-account bidding.
                matching = sorted((a for a, sc in scores.items() if sc >= max(threshold, 0.0001)),
                                  key=lambda a: (-scores[a], a))
                job.target_accounts = matching if len(matching) > 1 else []
            s.add(job)
            new_ids.append(jid)
            if best and rules.get("autopilot") and _autopilot(s, job, scores, threshold, rules, accounts, notes):
                auto_gen.append(jid)
            elif best and any(a.id == best and a.auto_generate for a in accounts):
                auto_gen.append(jid)
        s.commit()
        for jid in new_ids:
            job = s.get(Job, jid)
            events.notify("job_new", job_dict(job, s))
    if new_ids:
        events.log("fetch", f"{len(new_ids)} new job(s)")
    for msg, jid in notes:
        events.log("fetch", msg, job_id=jid)
    if enqueue_generation:
        for jid in auto_gen:
            enqueue_generation(jid)
    return new_ids


def _autopilot(s: Session, job: Job, scores: dict[str, float], threshold: float, rules: dict,
               accounts: list[Account], notes: list) -> bool:
    """Auto-pilot (Settings → Automation): new matching jobs get generated and auto-sent without a click.
    Returns True when the job was set up (the caller queues the generation)."""
    from .generation import auto_send_guard

    allowed = set(rules.get("autopilot_accounts") or []) or {a.id for a in accounts}
    picked = sorted((a for a, sc in scores.items() if sc >= max(threshold, 0.0001) and a in allowed),
                    key=lambda a: (-scores[a], a))
    if not picked:
        return False
    why = auto_send_guard(s, job, rules)
    if why:
        notes.append((f"auto-pilot skipped this job: {why}", job.id))
        return False
    job.target_accounts = picked
    job.assigned_account_id = picked[0]
    job.auto_send = True
    notes.append((f"auto-pilot: generating + auto-sending for {', '.join(picked)}", job.id))
    return True


class FetchControl:
    """Lets the dashboard pause/resume the fetcher and trigger an immediate check."""

    def __init__(self) -> None:
        self.fetcher: JobFetcher | None = None
        self.name = "none"
        self.busy = False
        self.last_run_at: datetime | None = None
        self.next_run_at: datetime | None = None
        self.last_error: str | None = None
        self.last_new = 0
        self.total_new = 0
        self._wake: asyncio.Event | None = None
        self._manual = False
        self.restarts = 0  # watchdog: hung cycles replaced by a fresh fetcher
        self.factory: Callable[[], JobFetcher] | None = None

    def wake(self) -> None:
        """Re-read settings now (after Start/Stop)."""
        if self._wake is not None:
            self._wake.set()

    def check_now(self) -> None:
        self._manual = True
        if self._wake is not None:
            self._wake.set()

    def status(self) -> dict:
        with Session(engine) as s:
            enabled = bool(settings_store.get(s, "fetcher_enabled"))
        health = getattr(self.fetcher, "health", None)
        return {
            "name": self.name,
            "enabled": enabled,
            "running": self.fetcher is not None,
            "busy": self.busy,
            "last_run_at": iso(self.last_run_at),
            "next_run_at": iso(self.next_run_at) if enabled else None,
            "last_error": self.last_error,
            "last_new": self.last_new,
            "total_new": self.total_new,
            "health": health() if callable(health) else {},
            "watchdog_restarts": self.restarts,
        }


fetch_control = FetchControl()


async def _wait(delay: float) -> None:
    wake = fetch_control._wake
    try:
        await asyncio.wait_for(wake.wait(), timeout=delay)
    except asyncio.TimeoutError:
        pass
    wake.clear()


def _cycle_timeout(interval: int) -> float:
    """A normal cycle takes seconds (a few minutes with many job pages); anything longer is a hang."""
    return max(240.0, interval * 4.0)


async def fetch_supervisor(factory: Callable[[], JobFetcher], enqueue_generation: Callable[[str], bool], name: str) -> None:
    """Keeps the fetch loop alive: if it ever crashes, a fresh fetcher is started after a short pause."""
    fetch_control.factory = factory
    while True:
        try:
            await fetch_loop(factory(), enqueue_generation, name)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            fetch_control.restarts += 1
            events.log("fetch", f"fetch loop crashed ({e!r}) - restarting it in 10 s", "error")
            await asyncio.sleep(10)


async def fetch_loop(fetcher: JobFetcher, enqueue_generation: Callable[[str], bool], name: str = "") -> None:
    from . import telegram

    fc = fetch_control
    fc.fetcher, fc.name, fc._wake = fetcher, name or type(fetcher).__name__, asyncio.Event()
    failures = 0
    while True:
        with Session(engine) as s:
            interval = max(15, int(settings_store.get(s, "fetch_interval_seconds")))
            enabled = bool(settings_store.get(s, "fetcher_enabled"))
        if not enabled:
            fc.next_run_at = None
            await _wait(3600)  # until "Start" or "Check now" wakes us
            with Session(engine) as s:
                if not settings_store.get(s, "fetcher_enabled") and not fc._manual:
                    continue
        fc._manual = False
        fc.busy = True
        restarted = False
        try:
            try:
                jobs = await asyncio.wait_for(fetcher.fetch_new(), timeout=_cycle_timeout(interval))
            except asyncio.TimeoutError:
                # Hung request / stuck session: abandon it and continue with a brand-new fetcher (new session,
                # new lock). Same effect as restarting the bot, without stopping anything else.
                fc.restarts += 1
                restarted = True
                if fc.factory is not None:
                    fetcher = fc.factory()
                    fc.fetcher = fetcher
                raise RuntimeError(f"fetch cycle hung for {int(_cycle_timeout(interval))} s - started a fresh fetcher "
                                   f"(restart #{fc.restarts})")
            failures = 0
            fc.last_error = None
            new_ids = ingest(jobs, enqueue_generation)
            fc.last_new = len(new_ids)
            fc.total_new += len(new_ids)
            if new_ids:
                asyncio.create_task(telegram.notify_new_jobs(new_ids))
        except Exception as e:
            failures += 1
            fc.last_error = str(e) or repr(e)
            events.log("fetch", f"fetcher error #{failures}: {e!r}", "error")
        finally:
            fc.busy = False
            fc.last_run_at = utcnow()
        delay = interval if failures == 0 else min(interval * (2 ** failures), 900)
        delay *= random.uniform(0.85, 1.15)  # less metronomic polling
        if restarted:
            failures = 0
            delay = 3.0  # the fresh fetcher checks right away
        fc.next_run_at = utcnow() + timedelta(seconds=delay)
        await _wait(delay)
