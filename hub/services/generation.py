"""Proposal generation queue (single worker) + providers (ChatGPT web extension / OpenAI API)."""
from __future__ import annotations

import asyncio
import random
import uuid
from datetime import timedelta
from typing import Any, Optional

import httpx
from sqlmodel import Session, delete, select

from .. import events
from ..config import config
from ..db import engine
from ..models import Account, Draft, Job, JobStatus, utcnow
from ..serialize import iso, job_dict
from . import job_state, settings_store
from .prompt import RETRY_SUFFIX, build_prompt, parse_generation


class GenerationError(Exception):
    pass


class ChatGPTWebProvider:
    """Sends the prompt to the ChatGPT Chrome extension and awaits its reply."""

    def __init__(self, manager) -> None:
        self.manager = manager
        self.pending: dict[str, asyncio.Future] = {}
        self.current_rid: Optional[str] = None

    async def generate(self, prompt: str, job_id: str, account_id: str, timeout: int) -> str:
        conn = self.manager.chatgpt
        if conn is None:
            raise GenerationError("ChatGPT extension is not connected")
        with Session(engine) as s:
            opts = settings_store.get(s, "chatgpt")
        rid = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        self.current_rid = rid
        try:
            await conn.send({
                "type": "generate", "request_id": rid, "job_id": job_id,
                "account_id": account_id, "prompt": prompt,
                "temporary_chat": bool(opts.get("temporary_chat", True)),
                "delete_after": bool(opts.get("delete_after_reply", True)),
            })
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise GenerationError(f"timed out after {timeout}s waiting for ChatGPT")
        finally:
            self.pending.pop(rid, None)
            if self.current_rid == rid:
                self.current_rid = None

    async def command(self, msg: dict[str, Any], timeout: int = 60) -> dict[str, Any]:
        """Send a command to the ChatGPT extension and wait for its {"type": "command_result"} reply."""
        conn = self.manager.chatgpt
        if conn is None:
            raise GenerationError("ChatGPT extension is not connected")
        rid = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        try:
            await conn.send({**msg, "request_id": rid})
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise GenerationError(f"no answer from the ChatGPT extension after {timeout}s "
                                  "(reload the extension: version 1.2.0 or newer is needed)")
        finally:
            self.pending.pop(rid, None)

    def on_command_result(self, rid: str, data: dict[str, Any]) -> None:
        fut = self.pending.get(rid)
        if fut and not fut.done():
            fut.set_result(data)

    async def cancel_current(self) -> bool:
        """Abort the prompt ChatGPT is answering now (the extension clicks ChatGPT's Stop button)."""
        rid = self.current_rid
        if not rid:
            return False
        fut = self.pending.get(rid)
        if fut and not fut.done():
            fut.set_exception(GenerationError("cancelled from the dashboard"))
        conn = self.manager.chatgpt
        if conn is not None:
            try:
                await conn.send({"type": "cancel_generate", "request_id": rid})
            except Exception:  # noqa: BLE001 - extension gone
                pass
        return True

    def on_generated(self, rid: str, raw: str) -> None:
        fut = self.pending.get(rid)
        if fut and not fut.done():
            fut.set_result(raw or "")

    def on_error(self, rid: str, error: str) -> None:
        fut = self.pending.get(rid)
        if fut and not fut.done():
            fut.set_exception(GenerationError(f"ChatGPT extension: {error}"))

    def fail_all(self, reason: str) -> None:
        for fut in list(self.pending.values()):
            if not fut.done():
                fut.set_exception(GenerationError(reason))


class OpenAIProvider:
    async def generate(self, prompt: str, job_id: str, account_id: str, timeout: int) -> str:
        if not config.OPENAI_API_KEY:
            raise GenerationError("OPENAI_API_KEY is not set in .env")
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                r = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {config.OPENAI_API_KEY}"},
                    json={
                        "model": config.OPENAI_MODEL,
                        "messages": [{"role": "user", "content": prompt}],
                        "response_format": {"type": "json_object"},
                    },
                )
        except httpx.HTTPError as e:
            raise GenerationError(f"OpenAI request failed: {e!r}")
        if r.status_code != 200:
            raise GenerationError(f"OpenAI API error {r.status_code}: {r.text[:300]}")
        return r.json()["choices"][0]["message"]["content"]


class GenerationService:
    """One worker, one (job, account) pair at a time: with several target accounts the next account's
    prompt starts as soon as the previous reply is in."""

    def __init__(self, manager) -> None:
        self.queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
        self.queued: list[tuple[str, str]] = []
        self.current: Optional[tuple[str, str]] = None
        self.next_at = None  # when the next prompt may start (pause between prompts)
        self.rng = random.Random()
        self.chatgpt = ChatGPTWebProvider(manager)
        self.openai = OpenAIProvider()
        self.cancelled: set[tuple[str, str]] = set()  # (job, account) whose running prompt was cancelled

    def busy_for(self, job_id: str) -> list[str]:
        """Accounts of this job that are queued or generating right now."""
        items = list(self.queued) + ([self.current] if self.current else [])
        return [a for j, a in items if j == job_id]

    def enqueue(self, job_id: str, account_ids: Optional[list[str]] = None) -> list[str]:
        """Queue generation for these accounts (default: all target accounts). Returns the accounts queued."""
        added: list[str] = []
        with Session(engine) as s:
            job = s.get(Job, job_id)
            if job is None or job.status == JobStatus.SKIPPED:
                return []
            wanted = account_ids if account_ids is not None else job_state.targets(job)
            busy = set(self.busy_for(job_id))
            for acc_id in dict.fromkeys(wanted):
                if acc_id in busy or s.get(Account, acc_id) is None:
                    continue
                if job_state.submission_for(s, job_id, acc_id):  # already sent/queued for this account
                    continue
                added.append(acc_id)
            if not added:
                return []
            job_state.refresh(s, job, generating=True)
            job.last_error = None
            s.add(job)
            s.commit()
            events.notify("job_updated", job_dict(job, s))
        for acc_id in added:
            self.queued.append((job_id, acc_id))
            self.queue.put_nowait((job_id, acc_id))
        return added

    def cancel_job(self, job_id: str) -> int:
        """Drop queued (not yet started) generations for a job."""
        before = len(self.queued)
        self.queued = [x for x in self.queued if x[0] != job_id]
        dropped = before - len(self.queued)
        if dropped:
            self._settle(job_id)
        return dropped

    async def stop_job(self, job_id: str) -> dict[str, int]:
        """Cancel everything for this job: queued accounts AND the prompt ChatGPT is writing now."""
        dropped = self.cancel_job(job_id)
        current = 0
        if self.current and self.current[0] == job_id:
            self.cancelled.add(self.current)
            await self._abort_current()
            current = 1
        return {"dropped": dropped, "current": current}

    async def stop_all(self) -> dict[str, int]:
        jobs = {j for j, _ in self.queued}
        dropped = len(self.queued)
        self.queued = []
        for j in jobs:
            self._settle(j)
        current = 0
        if self.current:
            self.cancelled.add(self.current)
            await self._abort_current()
            current = 1
        return {"dropped": dropped, "current": current}

    async def _abort_current(self) -> None:
        with Session(engine) as s:
            provider = settings_store.get(s, "generation_provider")
        if provider != "openai_api":  # OpenAI replies are simply discarded when they arrive (see _run)
            await self.chatgpt.cancel_current()

    def rename_account(self, old: str, new: str) -> None:
        self.queued = [(j, new if a == old else a) for j, a in self.queued]

    def drop_account(self, account_id: str) -> int:
        before = len(self.queued)
        jobs = {j for j, a in self.queued if a == account_id}
        self.queued = [x for x in self.queued if x[1] != account_id]
        for j in jobs:
            self._settle(j)
        if self.current and self.current[1] == account_id:
            self.cancelled.add(self.current)
        return before - len(self.queued)

    def recover_on_startup(self) -> None:
        """The queue lives in memory: jobs left 'generating' by a restart go back to their real state."""
        with Session(engine) as s:
            stuck = s.exec(select(Job).where(Job.status == JobStatus.GENERATING)).all()
            for job in stuck:
                job_state.refresh(s, job, generating=False)
                job.last_error = "Generation was interrupted by a restart - click Generate again"
                s.add(job)
            s.commit()
        if stuck:
            events.log("generate", f"{len(stuck)} job(s) were generating when the hub stopped - reset", "warn")

    async def _pause_between(self) -> None:
        """Random pause before the next prompt (only when something is waiting)."""
        with Session(engine) as s:
            lo = int(settings_store.get(s, "generation_pause_min_seconds"))
            hi = int(settings_store.get(s, "generation_pause_max_seconds"))
            provider = settings_store.get(s, "generation_provider")
        if provider == "openai_api" or hi <= 0:
            return
        delay = self.rng.uniform(lo, max(lo, hi))
        self.next_at = utcnow() + timedelta(seconds=delay)
        try:
            await asyncio.sleep(delay)
        finally:
            self.next_at = None

    async def worker(self) -> None:
        # (Re)create the queue inside the running loop - asyncio queues bind to one loop.
        self.queue = asyncio.Queue()
        self.queued.clear()
        self.current = None
        from .urgent import urgent

        while True:
            item = await self.queue.get()
            # Urgent mode: the urgent job's accounts go first; other jobs wait until urgent mode ends.
            if urgent.job_id:
                pick = next((x for x in self.queued if x[0] == urgent.job_id), None)
                if pick is None:
                    if item in self.queued:
                        self.queue.put_nowait(item)  # keeps its turn
                        await asyncio.sleep(1)
                    continue
                if pick != item:
                    if item in self.queued:
                        self.queue.put_nowait(item)
                    item = pick
            if item not in self.queued:  # cancelled while waiting
                continue
            self.queued.remove(item)
            self.cancelled.discard(item)
            self.current = item
            job_id, account_id = item
            try:
                await self._run(job_id, account_id)
            except Exception as e:
                self._fail(job_id, account_id, f"unexpected error: {e!r}")
            finally:
                self.current = None
                self.cancelled.discard(item)
                self._settle(job_id)
            if self.queued and not (urgent.job_id and any(j == urgent.job_id for j, _ in self.queued)):
                await self._pause_between()  # no pause before the next account of an urgent job

    def _provider(self, name: str):
        return self.openai if name == "openai_api" else self.chatgpt

    def _settle(self, job_id: str) -> None:
        """After one account finishes: leave 'generating' once no account of this job is pending."""
        with Session(engine) as s:
            job = s.get(Job, job_id)
            if job is None:
                return
            job_state.refresh(s, job, generating=bool(self.busy_for(job_id)))
            s.add(job)
            s.commit()
            events.notify("job_updated", job_dict(job, s))

    def _fail(self, job_id: str, account_id: str, message: str) -> None:
        with Session(engine) as s:
            job = s.get(Job, job_id)
            if job is None:
                return
            job.last_error = f"Generation failed ({account_id}): {message}"
            s.add(job)
            s.commit()
            events.notify("job_updated", job_dict(job, s))
        events.log("generate", f"generation failed: {message}", "error", job_id=job_id, account_id=account_id)

    async def _run(self, job_id: str, account_id: str) -> None:
        with Session(engine) as s:
            job = s.get(Job, job_id)
            if job is None or job.status == JobStatus.SKIPPED:
                return
            if job_state.submission_for(s, job_id, account_id):
                return
            acc = s.get(Account, account_id)
            if acc is None:
                return self._fail(job_id, account_id, "account not found")
            styles = settings_store.get(s, "styles")
            template = (acc.prompt_template or "").strip() or settings_store.get(s, "master_prompt")
            provider_name = settings_store.get(s, "generation_provider")
            prompt = build_prompt(template, job, acc, styles)
            default_price = acc.default_rate or job.budget_min
        keys = [st["key"] for st in styles]
        provider = self._provider(provider_name)
        timeout = config.GENERATION_TIMEOUT_SECONDS
        events.log("generate", f"generating {len(keys)} drafts for {account_id} via {provider_name}",
                   job_id=job_id, account_id=account_id)

        try:
            raw = await provider.generate(prompt, job_id, account_id, timeout)
            if (job_id, account_id) in self.cancelled:
                raise GenerationError("cancelled from the dashboard")
            parsed = parse_generation(raw, keys)
            if parsed is None:
                events.log("generate", "reply was not valid JSON; retrying once", "warn", job_id=job_id, account_id=account_id)
                raw = await provider.generate(prompt + RETRY_SUFFIX, job_id, account_id, timeout)
                parsed = parse_generation(raw, keys)
            if parsed is None:
                raise GenerationError("could not parse JSON from the model reply")
        except GenerationError as e:
            if (job_id, account_id) in self.cancelled or "cancelled from the dashboard" in str(e):
                events.log("generate", f"generation for {account_id} cancelled", "warn", job_id=job_id, account_id=account_id)
                return None
            return self._fail(job_id, account_id, str(e))
        if (job_id, account_id) in self.cancelled:
            events.log("generate", f"generation for {account_id} cancelled", "warn", job_id=job_id, account_id=account_id)
            return None

        with Session(engine) as s:
            job = s.get(Job, job_id)
            if job is None:
                return
            if job_state.submission_for(s, job_id, account_id) or account_id not in job_state.targets(job):
                events.log("generate", f"drafts for {account_id} discarded (already sent, or account removed meanwhile)",
                           "warn", job_id=job_id, account_id=account_id)
                return
            s.exec(delete(Draft).where(Draft.job_id == job_id, Draft.account_id == account_id))
            for key in keys:
                if key in parsed["texts"]:
                    s.add(Draft(
                        job_id=job_id, account_id=account_id, style=key, text=parsed["texts"][key],
                        suggested_price=parsed["price"] or default_price, suggested_days=parsed["days"],
                    ))
            job.last_error = None
            job_state.refresh(s, job, generating=bool(self.busy_for(job_id)))
            s.add(job)
            s.commit()
            s.refresh(job)
            auto = job.auto_send
            events.notify("drafts_ready", {**job_dict(job, s, full=True), "account_id": account_id})
            events.notify("job_updated", job_dict(job, s))
        events.log("generate", f"{len(parsed['texts'])} drafts ready for {account_id}", job_id=job_id, account_id=account_id)
        if auto:
            self._auto_send(job_id, account_id)

    def _auto_send(self, job_id: str, account_id: str) -> None:
        """Pre-assigned pipeline: queue this account's proposal right away, following the Automation settings
        (style, price, guards, review window). The submission queue then applies daily limits, per-account
        delay, global jitter and quiet hours before dispatching."""
        from ..state import submissions  # runtime imports: state/submission_queue import this module
        from .submission_queue import SendError, create_submission

        with Session(engine) as s:
            job = s.get(Job, job_id)
            if job is None or not job.auto_send:
                return
            rules = settings_store.get(s, "auto_send")
            drafts = s.exec(select(Draft).where(Draft.job_id == job_id, Draft.account_id == account_id)
                            .order_by(Draft.id)).all()
            if not drafts:
                return
            acc = s.get(Account, account_id)
            from .urgent import urgent
            is_urgent = urgent.active_for(job_id)
            why = None if is_urgent else auto_send_guard(s, job, rules)  # urgent: you decided
            draft = pick_auto_draft(s, job, account_id, drafts, rules, self.rng)
            # Decided in USD (budget clamp, min/max), converted to the account's currency only for Workana.
            price = auto_price(job, draft, acc, rules)
            max_price = float(rules.get("max_price") or 0)
            if not why and not is_urgent and max_price and price > max_price:
                why = f"price US${price:g} is above the auto-send maximum US${max_price:g}"
            from . import currency
            cur = currency.norm(acc.currency if acc else "USD")
            local_price = currency.to_local(s, price, cur)
            if not why and local_price <= 0:
                why = "price is 0 after conversion - check the exchange rates in Settings"
            if why:
                job.last_error = f"Auto-send skipped for {account_id}: {why}. The drafts are ready - send manually if you want."
                s.add(job)
                s.commit()
                events.log("submit", f"auto-send skipped: {why}", "warn", job_id=job_id, account_id=account_id)
                events.notify("job_updated", job_dict(job, s))
                return
            days = draft.suggested_days or 7
            hold = 0 if is_urgent else int(rules.get("review_seconds") or 0)
            try:
                sub = create_submission(
                    s, job_id=job_id, account_id=account_id, draft_id=draft.id, final_text=draft.text,
                    price=float(local_price), days=int(days), ext_connected=True,  # the queue waits for the extension
                    auto=True, hold_seconds=hold,
                )
            except SendError as e:
                job = s.get(Job, job_id)
                job.last_error = f"Auto-send ({account_id}) not queued: {e}"
                s.add(job)
                s.commit()
                events.log("submit", f"auto-send not queued: {e}", "warn", job_id=job_id, account_id=account_id)
                events.notify("job_updated", job_dict(job, s))
                return
            note = f", review window {hold}s" if hold else ""
            events.log("submit", f"auto-send: submission #{sub.id} queued for {account_id} "
                                 f"({draft.style}, {currency.fmt(local_price, cur)}"
                                 f"{f' = US${float(price):g}' if cur != 'USD' else ''}, {days}d{note})", job_id=job_id, account_id=account_id)
            events.notify("submission_updated", submissions.submission_payload(s, sub))
            events.notify("job_updated", job_dict(s.get(Job, job_id), s))

    def status(self) -> dict[str, Any]:
        cur = self.current
        return {
            "current": cur[0] if cur else None,
            "current_account": cur[1] if cur else None,
            "queued": [f"{j}:{a}" for j, a in self.queued],
            "next_at": iso(self.next_at),
        }


# ---------------------------------------------------------------- auto-send rules (shared with ingest)

def auto_send_guard(s: Session, job: Job, rules: dict[str, Any]) -> Optional[str]:
    """Why this job must NOT be auto-sent (None = ok)."""
    from sqlalchemy import func

    from ..models import Submission
    from .submission_queue import local_day_start_utc
    from .trust import client_trust, meets

    minimum = rules.get("min_trust") or "any"
    tr = client_trust(job.client_info)
    if not meets(tr["tier"], minimum):
        return f"client trust '{tr['tier']}' is below the minimum '{minimum}'"
    max_bids = int(rules.get("max_bids") or 0)
    bids = (job.client_info or {}).get("bids")
    if max_bids and isinstance(bids, int) and bids > max_bids:
        return f"{bids} bids already (limit {max_bids})"
    cap = int(rules.get("daily_cap") or 0)
    if cap:
        n = s.exec(select(func.count()).select_from(Submission).where(
            Submission.auto == True, Submission.requested_at >= local_day_start_utc())).one()  # noqa: E712
        if n >= cap:
            return f"daily auto-send cap reached ({cap})"
    return None


def pick_auto_draft(s: Session, job: Job, account_id: str, drafts: list[Draft], rules: dict[str, Any],
                    rng: random.Random) -> Draft:
    from ..models import Submission

    mode = rules.get("style_mode") or "fixed"
    if mode == "random":
        return rng.choice(drafts)
    if mode == "rotate":
        last = s.exec(select(Submission.style).where(Submission.account_id == account_id, Submission.auto == True)  # noqa: E712
                      .order_by(Submission.id.desc())).first()
        styles = [d.style for d in drafts]
        if last in styles:
            return drafts[(styles.index(last) + 1) % len(drafts)]
        return drafts[0]
    return next((d for d in drafts if d.style == job.auto_style), drafts[0])


def auto_price(job: Job, draft: Draft, acc: Optional[Account], rules: dict[str, Any]) -> float:
    lo, hi = job.budget_min, job.budget_max
    mode = rules.get("price_mode") or "suggested"
    suggested = draft.suggested_price or (acc.default_rate if acc else None) or lo or 0
    if mode == "budget_min" and lo:
        price = lo
    elif mode == "budget_mid" and lo is not None and hi:
        price = (lo + hi) / 2
    elif mode == "budget_max_pct" and hi:
        price = hi * int(rules.get("price_pct") or 90) / 100
    else:
        price = suggested
    # Keep the automatic price inside the client's budget range.
    if hi:
        price = min(price, hi)
    if lo:
        price = max(price, lo)
    if rules.get("min_price"):
        price = max(price, float(rules["min_price"]))
    return float(round(price))
