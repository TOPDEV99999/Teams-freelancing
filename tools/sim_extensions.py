"""
Simulate the Chrome extensions against a running hub (no Chrome needed).

    .venv\\Scripts\\python tools\\sim_extensions.py                 # ChatGPT + all 4 Workana accounts
    .venv\\Scripts\\python tools\\sim_extensions.py --fail captcha  # Workana sims report a captcha error
    .venv\\Scripts\\python tools\\sim_extensions.py --no-chatgpt --accounts me friend_a

The fake ChatGPT returns canned proposals after ~2 s; fake Workana profiles report "sent"
(or the --fail code) after ~3 s. Reads HUB_SHARED_SECRET / HUB_PORT from .env.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from pathlib import Path

import websockets
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
URL = f"ws://127.0.0.1:{os.getenv('HUB_PORT', '8766')}/ws/ext"
TOKEN = os.getenv("HUB_SHARED_SECRET", "")


def fake_reply(prompt: str) -> str:
    keys = ["formal", "friendly", "short", "technical"]
    m = re.search(r"(\{\"[a-z_]+\":\"\.\.\.\".*?\})\s*$", prompt, re.S)
    if m:
        try:
            keys = [k for k in json.loads(m.group(1)) if k not in ("price", "days")]
        except json.JSONDecodeError:
            pass
    title = re.search(r"Title: (.*)", prompt)
    t = title.group(1).strip() if title else "your project"
    body = {k: f"[{k}] Simulated proposal for '{t}'. I have read your requirements carefully and can deliver "
               f"a clean, tested result. Which deadline matters most to you?" for k in keys}
    body.update(price=150, days=5)
    return "```json\n" + json.dumps(body, ensure_ascii=False) + "\n```"


async def heartbeat(ws):
    while True:
        await asyncio.sleep(20)
        await ws.send(json.dumps({"type": "ping"}))


async def run_ext(role: str, account: str | None, fail: str | None):
    label = account or role
    backoff = [1, 2, 5, 10]
    attempt = 0
    while True:
        try:
            async with websockets.connect(URL) as ws:
                reg = {"type": "register", "role": role, "token": TOKEN, "version": "sim"}
                if account:
                    reg["account"] = account
                await ws.send(json.dumps(reg))
                ack = json.loads(await ws.recv())
                if ack.get("type") != "registered":
                    print(f"[{label}] rejected: {ack.get('error')}")
                    return
                print(f"[{label}] connected")
                attempt = 0
                hb = asyncio.create_task(heartbeat(ws))
                try:
                    async for raw in ws:
                        msg = json.loads(raw)
                        t = msg.get("type")
                        if t == "generate":
                            print(f"[{label}] generate job={msg['job_id']} ({len(msg['prompt'])} chars)")
                            await asyncio.sleep(2)
                            await ws.send(json.dumps({"type": "generated", "request_id": msg["request_id"],
                                                      "raw_text": fake_reply(msg["prompt"])}))
                        elif t == "submit":
                            sid = msg["submission_id"]
                            print(f"[{label}] submit #{sid} job={msg['job_id']} price={msg['price']} days={msg['days']}")
                            await ws.send(json.dumps({"type": "progress", "submission_id": sid,
                                                      "stage": "filling form (simulated)"}))
                            await asyncio.sleep(3)
                            res = {"type": "result", "submission_id": sid, "status": "failed" if fail else "sent"}
                            if fail:
                                res["error"] = fail
                            await ws.send(json.dumps(res))
                            print(f"[{label}] -> {res['status']} {fail or ''}")
                finally:
                    hb.cancel()
        except (OSError, websockets.ConnectionClosed) as e:
            delay = backoff[min(attempt, len(backoff) - 1)]
            attempt += 1
            print(f"[{label}] disconnected ({e.__class__.__name__}); retry in {delay}s")
            await asyncio.sleep(delay)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--accounts", nargs="*", default=["me", "friend_a", "friend_b", "friend_c"])
    ap.add_argument("--no-chatgpt", action="store_true")
    ap.add_argument("--fail", help="error code the Workana sims report, e.g. captcha, job_closed")
    a = ap.parse_args()
    tasks = [run_ext("workana", acc, a.fail) for acc in a.accounts]
    if not a.no_chatgpt:
        tasks.append(run_ext("chatgpt", None, None))
    await asyncio.gather(*tasks)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
