"""
PASTE YOUR EXISTING WORKANA FETCHER HERE.

Contract:
  * `fetch_new()` returns a list of `JobIn` (see base.py). Return whatever is currently
    on the listing page - the hub dedupes by `id`, so repeats are harmless.
  * The hub calls it every `fetch_interval_seconds` (Settings page, default 60s) and backs
    off exponentially when it raises. Do NOT add your own fast polling loop.
  * If your existing code is synchronous (requests, BeautifulSoup, ...), keep it sync and
    wrap it with `asyncio.to_thread(...)` as shown below so it doesn't block the hub.
  * If your bot used to send notifications (Telegram etc.), drop that part - the dashboard
    does notifications now.

Example of the shape you need to produce:

    JobIn(
        id="desarrollo-de-landing-page-en-wordpress",   # slug or numeric id
        url="https://www.workana.com/job/desarrollo-de-landing-page-en-wordpress",
        title="Desarrollo de landing page en WordPress",
        description="Necesito una landing...",
        budget_text="USD 100 - 250",
        category="IT & Programming",
        skills=["WordPress", "HTML", "CSS"],
        client_info={"country": "Argentina", "rating": 4.8, "hires": 12},
        posted_at=None,
    )
"""
from __future__ import annotations

import asyncio
import logging

from hub.fetcher.base import JobFetcher, JobIn

log = logging.getLogger("hub.fetcher")


def _fetch_sync() -> list[dict]:
    """TODO: replace with your existing logic. Return a list of dicts (or JobIn)."""
    return []


class MyFetcher(JobFetcher):
    _warned = False

    async def fetch_new(self) -> list[JobIn]:
        rows = await asyncio.to_thread(_fetch_sync)
        if not rows and not MyFetcher._warned:
            MyFetcher._warned = True
            log.info("my_fetcher.py returned no jobs - paste your fetcher logic into hub/fetcher/my_fetcher.py")
        return [r if isinstance(r, JobIn) else JobIn(**r) for r in rows]
