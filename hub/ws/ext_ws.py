"""WebSocket endpoint for the Chrome extensions: /ws/ext"""
from __future__ import annotations

import asyncio
import hmac
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlmodel import Session

from .. import events
from ..config import config
from ..db import engine
from ..models import Account, utcnow
from ..serialize import account_dict
from .connection_manager import ExtConn, manager

router = APIRouter()


def _token_ok(token: object) -> bool:
    if not config.SHARED_SECRET or config.SHARED_SECRET == "change-me":
        return False
    return isinstance(token, str) and hmac.compare_digest(token, config.SHARED_SECRET)


def _set_account_connected(account_id: str, connected: bool) -> None:
    with Session(engine) as s:
        acc = s.get(Account, account_id)
        if acc is None:
            return
        acc.ext_connected = connected
        acc.last_seen_at = utcnow()
        s.add(acc)
        s.commit()
        s.refresh(acc)
        events.notify("account_updated", account_dict(acc))


def _broadcast_status() -> None:
    events.notify("ext_status", manager.status())


async def on_disconnect(conn: ExtConn, reason: str = "disconnected") -> None:
    if not manager.unregister(conn):
        return
    if conn.role == "workana" and conn.account:
        _set_account_connected(conn.account, False)
    if conn.role == "chatgpt":
        from ..state import generation

        generation.chatgpt.fail_all(f"ChatGPT extension {reason}")
    events.log("ext", f"{conn.role} extension {('(' + conn.account + ') ') if conn.account else ''}{reason}", "warn",
               account_id=conn.account)
    _broadcast_status()


@router.websocket("/ws/ext")
async def ext_ws(ws: WebSocket) -> None:
    from ..state import generation, submissions

    await ws.accept()
    try:
        first = await asyncio.wait_for(ws.receive_json(), timeout=10)
    except Exception:
        await ws.close(code=4400)
        return

    async def reject(code: int, error: str) -> None:
        events.log("ext", f"rejected extension registration: {error}", "warn")
        try:
            await ws.send_json({"type": "register_error", "error": error})
            await ws.close(code=code)
        except Exception:
            pass

    if not isinstance(first, dict) or first.get("type") != "register":
        return await reject(4400, "first message must be 'register'")
    if not _token_ok(first.get("token")):
        return await reject(4401, "invalid or missing token (set the shared secret in the extension popup)")

    role = first.get("role")
    account = first.get("account") if role == "workana" else None
    if role == "workana":
        with Session(engine) as s:
            if not account or s.get(Account, account) is None:
                return await reject(4404, f"unknown account id '{account}' - create it on the Accounts page")

    conn = ExtConn(ws=ws, role=str(role), account=account, version=str(first.get("version", "")))
    err = manager.register(conn)
    if err:
        return await reject(4409, err)

    await conn.send({"type": "registered", "role": conn.role, "account": conn.account})
    if conn.account:
        _set_account_connected(conn.account, True)
    events.log("ext", f"{conn.role} extension connected" + (f" ({conn.account})" if conn.account else ""),
               account_id=conn.account)
    _broadcast_status()

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            conn.touch()
            t = msg.get("type")
            if t == "ping":
                await conn.send({"type": "pong"})
            elif t == "generated" and conn.role == "chatgpt":
                generation.chatgpt.on_generated(str(msg.get("request_id")), str(msg.get("raw_text", "")))
            elif t == "generate_error" and conn.role == "chatgpt":
                generation.chatgpt.on_error(str(msg.get("request_id")), str(msg.get("error", "unknown")))
            elif t == "command_result" and conn.role == "chatgpt":
                generation.chatgpt.on_command_result(str(msg.get("request_id")), msg)
            elif t == "notice" and conn.role == "workana":
                # Dashboard alerts are ONLY client messages, and those come from reading the conversation (li.other),
                # never from the extension's list watcher (which can't tell your own replies apart). Workana's own
                # notifications are not shown; "proposal not accepted" still updates that bid's outcome.
                from ..services import notices

                items = msg.get("items")
                if isinstance(items, list) and items:
                    notices.workana_notifications(conn.account, [i for i in items if isinstance(i, dict)
                                                                 and i.get("kind") == "notification"])
            elif t == "inbox_list" and conn.role == "workana":
                from ..services import inbox

                if isinstance(msg.get("items"), list):
                    inbox.on_list(conn.account, msg["items"])
            elif t == "inbox_result" and conn.role == "workana":
                from ..services import inbox

                inbox.on_result(conn.account, msg)
            elif t == "snapshot" and conn.role == "workana":
                from ..services import inbox

                inbox.save_snapshot(conn.account, msg)
            elif t == "counters" and conn.role == "workana":
                from ..services import notices

                notices.set_counters(conn.account, msg)
            elif t == "result" and conn.role == "workana":
                submissions.handle_result(conn.account, msg)
            elif t == "progress" and conn.role == "workana":
                submissions.handle_progress(conn.account, msg)
            elif t == "log":
                events.log("ext", f"[{conn.account or conn.role}] {str(msg.get('message', ''))[:500]}",
                           str(msg.get("level", "info")) if msg.get("level") in ("info", "warn", "error") else "info",
                           account_id=conn.account)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        events.log("ext", f"extension socket error: {e!r}", "warn", account_id=conn.account)
    finally:
        await on_disconnect(conn)
