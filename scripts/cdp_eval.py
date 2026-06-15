#!/usr/bin/env python3
"""Evaluate JS in a live page over RAW CDP (no Playwright).

Why not Playwright: `connect_over_cdp` against a win_chrome instance that already
has `cdp_capture.py` attached reliably crashes the session (target auto-attach
conflict → WS 1006 → Chrome dies). A direct Runtime.evaluate on the page target
coexists with the passive monitor and never closes the browser.

Usage:
    python3 scripts/cdp_eval.py <cdp-url> '<js-expression>' [url-substr]
    # picks the newest page target whose URL contains url-substr (default: ihg.com)

The expression may be async / return a Promise; the result is JSON-printed.
"""
from __future__ import annotations

import json
import sys
import urllib.request

import asyncio
import websockets


def pick_page(cdp: str, url_substr: str) -> str:
    targets = json.load(urllib.request.urlopen(cdp.rstrip("/") + "/json", timeout=5))
    pages = [t for t in targets if t.get("type") == "page" and url_substr in t.get("url", "")]
    if not pages:
        pages = [t for t in targets if t.get("type") == "page"]
    if not pages:
        sys.exit(f"no page target matching {url_substr!r}")
    return pages[0]["webSocketDebuggerUrl"]


async def evaluate(ws_url: str, expr: str):
    async with websockets.connect(ws_url, max_size=None) as ws:
        await ws.send(json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expr,
                "awaitPromise": True,
                "returnByValue": True,
                "allowUnsafeEvalBlockedByCSP": True,
            },
        }))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("id") == 1:
                if "error" in msg:
                    return {"_cdp_error": msg["error"]}
                res = msg["result"]
                if res.get("exceptionDetails"):
                    return {"_exception": res["exceptionDetails"].get("text"),
                            "_detail": str(res["exceptionDetails"])[:300]}
                return res.get("result", {}).get("value")


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit("usage: cdp_eval.py <cdp-url> '<js>' [url-substr]")
    cdp, expr = sys.argv[1], sys.argv[2]
    url_substr = sys.argv[3] if len(sys.argv) > 3 else "ihg.com"
    ws_url = pick_page(cdp, url_substr)
    out = asyncio.run(evaluate(ws_url, expr))
    print(json.dumps(out, indent=1, ensure_ascii=True))


if __name__ == "__main__":
    main()
