from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


class JobIn(BaseModel):
    """Normalized job posting. Your fetcher must return these."""

    id: str  # Workana job ID or slug - must be unique and stable
    url: str
    title: str
    description: str = ""
    budget_text: str = ""  # raw, e.g. "USD 50 - 100"
    budget_min: Optional[float] = None  # parsed automatically from budget_text if omitted
    budget_max: Optional[float] = None
    category: Optional[str] = None
    skills: list[str] = Field(default_factory=list)
    client_info: dict[str, Any] = Field(default_factory=dict)  # country, rating, hires...
    posted_at: Optional[datetime] = None


class JobFetcher(ABC):
    @abstractmethod
    async def fetch_new(self) -> list[JobIn]:
        """Return recently posted jobs. Returning already-seen jobs is fine: the hub dedupes by id."""


class NullFetcher(JobFetcher):
    async def fetch_new(self) -> list[JobIn]:
        return []


STUB_MARKER = "TODO: replace with your existing logic"


def _is_stub(path) -> bool:
    try:
        return STUB_MARKER in path.read_text(encoding="utf-8")
    except OSError:
        return True


def make_fetcher(name: str) -> JobFetcher:
    """FETCHER=workana (built-in, default) | mine (my_fetcher.py) | demo | none."""
    import logging
    from pathlib import Path

    from ..config import FROZEN, config

    lg = logging.getLogger("hub.fetcher")
    if name == "demo":
        from .demo_fetcher import DemoFetcher

        return DemoFetcher()
    if name == "mine":
        external = FROZEN and config.EXTERNAL_FETCHER.exists()
        src = config.EXTERNAL_FETCHER if external else Path(__file__).with_name("my_fetcher.py")
        if _is_stub(src):
            lg.info("my_fetcher.py is still the empty template - using the built-in Workana fetcher")
            name = "workana"
        elif external:
            import importlib.util

            spec = importlib.util.spec_from_file_location("user_my_fetcher", config.EXTERNAL_FETCHER)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            lg.info("using external fetcher %s", config.EXTERNAL_FETCHER)
            return mod.MyFetcher()
        else:
            from .my_fetcher import MyFetcher

            return MyFetcher()
    if name == "workana":
        from .workana_fetcher import WorkanaFetcher

        return WorkanaFetcher()
    return NullFetcher()
