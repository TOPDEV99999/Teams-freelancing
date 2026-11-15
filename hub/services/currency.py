"""Per-account bid currency (US$, R$, MX$).

Everything that DECIDES a price works in US dollars: ChatGPT's suggestion, the client's budget (the fetcher
reads budgets in USD), the budget clamp and the auto-send minimum/maximum. Only the final amount typed into
Workana's proposal form is converted to the account's currency, with the rates from Settings.
"""
from __future__ import annotations

from typing import Any, Optional

from sqlmodel import Session

from . import settings_store

CURRENCIES: dict[str, str] = {"USD": "US$", "BRL": "R$", "MXN": "MX$"}
DEFAULT_RATES: dict[str, float] = {"BRL": 5.4, "MXN": 18.5}  # units per 1 USD (edit in Settings)
RATES_URL = "https://open.er-api.com/v6/latest/USD"


def norm(code: Optional[str]) -> str:
    c = str(code or "USD").strip().upper()
    return c if c in CURRENCIES else "USD"


def rates(s: Session) -> dict[str, float]:
    r = settings_store.get(s, "currency_rates") or {}
    out = {"USD": 1.0}
    for k, dv in DEFAULT_RATES.items():
        try:
            v = float(r.get(k) or dv)
        except (TypeError, ValueError):
            v = dv
        out[k] = v if v > 0 else dv
    return out


def to_local(s: Session, usd: float, code: str) -> float:
    """USD -> amount in the account's currency, rounded to a whole number (what is typed into Workana)."""
    code = norm(code)
    v = float(usd) * rates(s)[code]
    return float(round(v)) if code != "USD" else float(round(v, 2) if v < 10 else round(v))


def to_usd(s: Session, amount: float, code: str) -> float:
    return float(amount) / rates(s)[norm(code)]


def fmt(amount: float, code: str) -> str:
    return f"{CURRENCIES[norm(code)]} {amount:,.0f}" if amount >= 10 else f"{CURRENCIES[norm(code)]} {amount:g}"


def validate_rates(v: Any) -> dict[str, float]:
    if not isinstance(v, dict):
        raise ValueError("currency_rates must be an object")
    out: dict[str, float] = {}
    for k, dv in DEFAULT_RATES.items():
        try:
            x = float(v.get(k) or dv)
        except (TypeError, ValueError):
            raise ValueError(f"exchange rate for {k} must be a number")
        if not 0.01 <= x <= 100000:
            raise ValueError(f"exchange rate for {k} looks wrong ({x})")
        out[k] = round(x, 4)
    out["updated_at"] = str(v.get("updated_at") or "")[:40]
    out["source"] = str(v.get("source") or "manual")[:40]
    return out


async def fetch_rates() -> dict[str, float]:
    """Today's rates from a free public API (no key, nothing about you is sent)."""
    import httpx

    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(RATES_URL, headers={"User-Agent": "rates-client"})
        r.raise_for_status()
        data = r.json()
    rr = data.get("rates") or {}
    out = {k: float(rr[k]) for k in DEFAULT_RATES if k in rr}
    if len(out) != len(DEFAULT_RATES):
        raise ValueError("the rates service did not return BRL/MXN")
    return out
