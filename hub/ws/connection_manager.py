"""Tracks extension and dashboard WebSocket connections."""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from fastapi import WebSocket

from ..models import utcnow

log = logging.getLogger("hub.ws")


@dataclass(eq=False)
class ExtConn:
    ws: WebSocket
    role: str  # chatgpt | workana
    account: Optional[str] = None
    version: str = ""
    connected_at: datetime = field(default_factory=utcnow)
    last_ping: float = field(default_factory=time.monotonic)
    last_seen_at: datetime = field(default_factory=utcnow)

    async def send(self, msg: dict[str, Any]) -> None:
        await self.ws.send_json(msg)

    def touch(self) -> None:
        self.last_ping = time.monotonic()
        self.last_seen_at = utcnow()


class ConnectionManager:
    def __init__(self) -> None:
        self.chatgpt: Optional[ExtConn] = None
        self.workana: dict[str, ExtConn] = {}
        self.ui: set[WebSocket] = set()

    # ---- extensions -------------------------------------------------------
    def register(self, conn: ExtConn) -> Optional[str]:
        """Returns an error string if the registration must be rejected."""
        if conn.role == "chatgpt":
            if self.chatgpt is not None:
                return "a chatgpt extension is already connected"
            self.chatgpt = conn
        elif conn.role == "workana":
            if not conn.account:
                return "workana registration requires 'account'"
            if conn.account in self.workana:
                return f"account '{conn.account}' already has a connected extension"
            self.workana[conn.account] = conn
        else:
            return f"unknown role '{conn.role}'"
        return None

    def unregister(self, conn: ExtConn) -> bool:
        """Remove conn if it is the currently registered one. Returns True if removed."""
        if conn.role == "chatgpt" and self.chatgpt is conn:
            self.chatgpt = None
            return True
        if conn.role == "workana" and conn.account and self.workana.get(conn.account) is conn:
            del self.workana[conn.account]
            return True
        return False

    def get_workana(self, account_id: str) -> Optional[ExtConn]:
        return self.workana.get(account_id)

    def is_workana_connected(self, account_id: str) -> bool:
        return account_id in self.workana

    def status(self) -> dict[str, Any]:
        def one(c: Optional[ExtConn]) -> dict[str, Any]:
            if c is None:
                return {"connected": False}
            return {
                "connected": True,
                "version": c.version,
                "connected_at": c.connected_at.isoformat() + "Z",
                "last_seen_at": c.last_seen_at.isoformat() + "Z",
            }

        return {
            "chatgpt": one(self.chatgpt),
            "workana": {acc: one(c) for acc, c in self.workana.items()},
        }

    async def watchdog(self, stale_seconds: int) -> None:
        """Close extension sockets that have not pinged recently."""
        while True:
            await asyncio.sleep(10)
            now = time.monotonic()
            conns = ([self.chatgpt] if self.chatgpt else []) + list(self.workana.values())
            for c in conns:
                if now - c.last_ping > stale_seconds:
                    log.warning("closing stale %s connection (%s)", c.role, c.account or "-")
                    try:
                        await c.ws.close(code=4408)
                    except Exception:
                        pass
                    # The receive loop in ext_ws will notice and unregister; make sure anyway.
                    from .ext_ws import on_disconnect

                    await on_disconnect(c, reason="no ping for 60s")

    # ---- dashboard --------------------------------------------------------
    async def broadcast_ui(self, type_: str, data: Any) -> None:
        dead = []
        for ws in list(self.ui):
            try:
                await ws.send_json({"type": type_, "data": data})
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.ui.discard(ws)


manager = ConnectionManager()
