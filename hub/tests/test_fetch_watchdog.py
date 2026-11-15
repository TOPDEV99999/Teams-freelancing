"""The fetch loop survives hung cycles and crashes; bulk Generate without picked accounts uses each job's matches."""
import asyncio

import pytest

from hub.fetcher.base import JobFetcher, JobIn
from hub.services import ingest


class HangingFetcher(JobFetcher):
    async def fetch_new(self):
        await asyncio.sleep(3600)  # a request that never returns


class OneJobFetcher(JobFetcher):
    def __init__(self):
        self.calls = 0

    async def fetch_new(self):
        self.calls += 1
        return [JobIn(id=f"wd-{self.calls}", url="https://www.workana.com/job/wd", title="Watchdog job")]


def test_hung_cycle_is_replaced_by_fresh_fetcher(monkeypatch):
    monkeypatch.setattr(ingest, "_cycle_timeout", lambda interval: 0.2)
    fresh = OneJobFetcher()
    made = iter([HangingFetcher(), fresh])

    async def run():
        task = asyncio.create_task(ingest.fetch_supervisor(lambda: next(made, fresh), lambda _j: False, "test"))
        for _ in range(100):
            await asyncio.sleep(0.05)
            if fresh.calls:
                break
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    from hub.db import engine
    from sqlmodel import Session
    from hub.services import settings_store
    with Session(engine) as s:
        settings_store.set_many(s, {"fetch_interval_seconds": 15})
    asyncio.run(run())
    assert ingest.fetch_control.restarts >= 1 and fresh.calls >= 1
    assert ingest.fetch_control.fetcher is fresh


def test_batch_without_accounts_uses_matching(client):
    client.patch("/api/accounts/friend_a", json={"categories": ["wordpress"]})
    client.post("/api/jobs", json=[
        {"id": "m-wp", "url": "https://www.workana.com/job/m-wp", "title": "Sitio WordPress", "description": "wordpress"},
        {"id": "m-none", "url": "https://www.workana.com/job/m-none", "title": "Nada", "description": "zzz"}])
    r = client.post("/api/jobs/batch", json={"job_ids": ["m-wp", "m-none"], "account_ids": [], "auto_send": False,
                                             "auto_style": "", "generate": False}).json()
    assert r["jobs"] == ["m-wp"] and r["skipped"] == ["m-none"]
    assert client.get("/api/jobs/m-wp").json()["targets"] == ["friend_a"]
