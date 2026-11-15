"""WebSocket endpoint for the dashboard: /ws/ui (server -> browser live updates)."""
from __future__ import annotations

from urllib.parse import urlparse

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .connection_manager import manager

router = APIRouter()

_ALLOWED_HOSTS = {"127.0.0.1", "localhost"}


@router.websocket("/ws/ui")
async def ui_ws(ws: WebSocket) -> None:
    origin = ws.headers.get("origin")
    if origin and urlparse(origin).hostname not in _ALLOWED_HOSTS:
        await ws.close(code=4403)
        return
    await ws.accept()
    manager.ui.add(ws)
    await ws.send_json({"type": "ext_status", "data": manager.status()})
    try:
        while True:
            await ws.receive_text()  # dashboard doesn't send anything meaningful
    except WebSocketDisconnect:
        pass
    finally:
        manager.ui.discard(ws)
