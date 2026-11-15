"""View-only translation (job details / proposals shown in your language; nothing sent is translated).

The dashboard first tries the browser's built-in, on-device translator (Chrome's Translator API). When that
is unavailable it calls this endpoint, which uses Google Translate's public web endpoint.
"""
from __future__ import annotations

import re
import unicodedata
from collections import OrderedDict
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api", tags=["translate"])

GOOGLE = "https://translate.googleapis.com/translate_a/single"
_CACHE: "OrderedDict[tuple[str, str], tuple[str, str]]" = OrderedDict()
_CACHE_MAX = 500
CHUNK = 4000


class TranslateBody(BaseModel):
    texts: list[str] = Field(..., max_length=20)
    target: str = "en"
    source: Optional[str] = None


def plain(text: str) -> str:
    """Unicode "font changer" letters (𝐇𝐨𝐥𝐚, 𝗣𝗹𝗮𝗻) -> normal letters so they can be translated."""
    return unicodedata.normalize("NFKC", text or "")


def _chunks(text: str) -> list[str]:
    if len(text) <= CHUNK:
        return [text]
    out, cur = [], ""
    for para in re.split(r"(\n+)", text):
        if len(cur) + len(para) > CHUNK and cur:
            out.append(cur)
            cur = ""
        while len(para) > CHUNK:
            out.append(para[:CHUNK])
            para = para[CHUNK:]
        cur += para
    if cur:
        out.append(cur)
    return out


async def _google(client: httpx.AsyncClient, text: str, target: str, source: str) -> tuple[str, str]:
    r = await client.post(GOOGLE, params={"client": "gtx", "sl": source, "tl": target, "dt": "t"},
                          data={"q": text})
    if r.status_code != 200:
        raise HTTPException(502, f"translation service answered HTTP {r.status_code}")
    data = r.json()
    translated = "".join(seg[0] for seg in (data[0] or []) if seg and seg[0])
    detected = data[2] if len(data) > 2 and isinstance(data[2], str) else source
    return translated, detected


@router.post("/translate")
async def translate(body: TranslateBody):
    target = body.target.strip() or "en"
    if not re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?", target):
        raise HTTPException(422, "target must be a language code such as en, ko, ja, zh-CN")
    source = (body.source or "auto").strip() or "auto"
    out: list[str] = []
    detected = None
    try:
        async with httpx.AsyncClient(timeout=20, headers={"User-Agent": "Mozilla/5.0"}) as client:
            for text in body.texts:
                text = plain(text)
                if not text.strip():
                    out.append("")
                    continue
                key = (target, text)
                if key in _CACHE:
                    _CACHE.move_to_end(key)
                    t, det = _CACHE[key]
                else:
                    parts = [await _google(client, c, target, source) for c in _chunks(text)]
                    t, det = "".join(p[0] for p in parts), parts[0][1]
                    _CACHE[key] = (t, det)
                    if len(_CACHE) > _CACHE_MAX:
                        _CACHE.popitem(last=False)
                out.append(t)
                detected = detected or det
    except httpx.HTTPError as e:
        raise HTTPException(502, f"could not reach the translation service: {e}")
    except (ValueError, IndexError, TypeError):
        raise HTTPException(502, "unexpected answer from the translation service")
    return {"translations": out, "detected": detected, "target": target, "provider": "google"}
