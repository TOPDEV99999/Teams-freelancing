"""FastAPI app: REST API, WebSockets, background tasks, dashboard static files."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import events
from .api import (accounts, fetcher as fetcher_api, jobs, maintenance, notices as notices_api, prompts, settings, stats,
                  submissions as submissions_api, translate)
from .api import inbox as inbox_api
from .config import config
from .db import init_db
from .fetcher.base import make_fetcher
from .services.ingest import fetch_supervisor
from .state import generation, submissions
from .ws import ext_ws, ui_ws
from .ws.connection_manager import manager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


async def _trim_loop() -> None:
    from .services.cleanup import run_retention

    await asyncio.sleep(60)
    while True:
        await asyncio.to_thread(events.trim)
        try:
            await asyncio.to_thread(run_retention)
        except Exception as e:  # noqa: BLE001
            events.log("system", f"automatic clean-up failed: {e!r}", "error")
        await asyncio.sleep(3600)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    events.set_loop(asyncio.get_running_loop())
    submissions.recover_on_startup()
    generation.recover_on_startup()
    if not config.SHARED_SECRET or config.SHARED_SECRET == "change-me":
        events.log("system", "HUB_SHARED_SECRET is not set in .env - extensions will be rejected", "error")
    tasks = [
        asyncio.create_task(manager.watchdog(config.EXT_STALE_SECONDS)),
        asyncio.create_task(generation.worker()),
        asyncio.create_task(submissions.run()),
        asyncio.create_task(_trim_loop()),
    ]
    if config.FETCHER != "none":
        from .services.presence import presence

        tasks.append(asyncio.create_task(presence.loop()))
        fetcher = make_fetcher(config.FETCHER)
        tasks.append(asyncio.create_task(fetch_supervisor(lambda: make_fetcher(config.FETCHER), generation.enqueue,
                                                          type(fetcher).__name__)))
    events.log("system", f"hub started (fetcher={config.FETCHER})")
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="Workana Assistant Hub", lifespan=lifespan)
# Blocks DNS-rebinding: only requests addressed to localhost are accepted.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])

for r in (jobs.router, accounts.router, fetcher_api.router, prompts.router, submissions_api.router, stats.router, settings.router,
          maintenance.router, notices_api.router, inbox_api.router, translate.router, ext_ws.router, ui_ws.router):
    app.include_router(r)

if (config.DASHBOARD_DIST / "index.html").exists():
    app.mount("/", StaticFiles(directory=config.DASHBOARD_DIST, html=True), name="dashboard")
else:
    @app.get("/", response_class=HTMLResponse)
    def _no_dashboard():
        return ("<h2>Workana Assistant hub is running.</h2><p>The dashboard is not built yet. Run:</p>"
                "<pre>cd dashboard\nnpm install\nnpm run build</pre><p>then restart the hub. "
                "API docs: <a href='/docs'>/docs</a></p>")
