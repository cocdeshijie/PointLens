"""Raw-CDP capture daemon — lighter alternative to scripts/browser.py.

Why: Playwright in attached mode forces Network/Page/Runtime/Target/Inspector
domains on, dispatches every Chrome event through Chrome → CDP WS → Playwright
Node driver → Python pipe → user handler. On a tracker-heavy page (300+ reqs),
that path adds enough per-request latency to feel like throttled internet.

This script bypasses Playwright entirely: opens its own WebSocket to Chrome's
/devtools/browser endpoint, enables only the domains we actually want
(Network per target by default), and writes events into the same JSONL file
shape scripts/browser.py uses, so the monitor + downstream tooling work
unchanged.

Usage:
    python cdp_capture.py <slug> --connect http://127.0.0.1:9333
        [--enable-runtime]      # enables Runtime.enable per target so drive.py's
                                #   evaluate / fill / click / cookies work.
                                #   Caveat: Runtime.enable is detectable by
                                #   bot-detection (CF/HUMAN/DataDome).
        [--enable-page]         # adds Page.enable for navigation + lifecycle
                                #   events. Same caveat.
        [--capture-bodies]      # fetch response bodies via Network.getResponseBody
                                #   (CDP round-trip per body, expensive).
        [--storage-hook]        # inject scripts/storage_hook.js as init script.
                                #   Requires --enable-page (uses Page.addScript-
                                #   ToEvaluateOnNewDocument).

DDX_SESSIONS env var overrides the sessions root (use a Windows-native path
when running on Windows with WSL drive.py reading via /mnt/c).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import signal
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
SESSIONS = (
    Path(os.environ["DDX_SESSIONS"]) if os.environ.get("DDX_SESSIONS") else ROOT / "sessions"
)
STORAGE_HOOK = SCRIPTS / "storage_hook.js"
STEALTH_EXTRAS = SCRIPTS / "stealth_extras.js"

# Body capture: noise endpoints to skip. Each captured body is a CDP round-
# trip; this list saves dozens of pointless calls per page on tracker-heavy
# sites. (Same patterns scripts/browser.py used.)
BODY_SKIP_HOSTS = (
    "google-analytics.com", "googletagmanager.com", "googleadservices.com",
    "doubleclick.net", "googlesyndication.com", "g.doubleclick.net",
    "googletagservices.com",
    "facebook.com/tr", "facebook.net", "fbcdn.net",
    "pinterest.com/v3", "ct.pinterest.com",
    "linkedin.com/wa", "ads.linkedin.com", "px.ads.linkedin.com",
    "clarity.ms", "twitter.com/i/adsct", "analytics.twitter.com", "t.co/i/adsct",
    "amplitude.com/2/", "api.amplitude.com",
    "segment.io/v1", "cdn.segment.com",
    "sentry.io/api", "ingest.sentry.io",
    "snapchat.com/p/", "cm.tiktok.com",
    "reddit.com/pixel", "ads-pixel.reddit.com",
    "/cdn-cgi/rum", "/cdn-cgi/challenge-platform/",
    "/ccm/collect", "/rmkt/collect", "/pagead/", "/g/collect",
)
BODY_SKIP_TYPES = {"Image", "Font", "Media", "Stylesheet"}
MAX_BODY_BYTES = 50 * 1024 * 1024
# Cap concurrent body fetches so a burst of 200 responses doesn't queue 200
# in-flight CDP getResponseBody calls and starve other event traffic.
BODY_CONCURRENCY = 6


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def discover_browser_ws(connect_url: str) -> str:
    """Hit /json/version, return the WebSocket URL Chrome reports."""
    if not connect_url.endswith("/"):
        connect_url = connect_url + "/"
    with urllib.request.urlopen(connect_url + "json/version", timeout=5) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
    return data["webSocketDebuggerUrl"]


class CDP:
    """Tiny multiplexing CDP client. One WebSocket → many target sessions."""

    def __init__(self, ws):
        self.ws = ws
        self._next_id = 1
        self._pending: dict[int, asyncio.Future] = {}
        self._handlers: dict[str, list] = {}

    async def call(self, method: str, params: dict | None = None, session_id: str | None = None):
        msg_id = self._next_id
        self._next_id += 1
        msg = {"id": msg_id, "method": method, "params": params or {}}
        if session_id:
            msg["sessionId"] = session_id
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        await self.ws.send(json.dumps(msg))
        try:
            return await asyncio.wait_for(fut, timeout=15)
        except asyncio.TimeoutError:
            self._pending.pop(msg_id, None)
            raise

    def on(self, method: str, handler):
        self._handlers.setdefault(method, []).append(handler)

    async def reader(self):
        async for raw in self.ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if "id" in msg and msg["id"] in self._pending:
                fut = self._pending.pop(msg["id"])
                if "error" in msg:
                    fut.set_exception(RuntimeError(msg["error"]))
                else:
                    fut.set_result(msg.get("result"))
            else:
                method = msg.get("method")
                if method:
                    params = msg.get("params") or {}
                    sid = msg.get("sessionId")
                    for h in self._handlers.get(method, []):
                        try:
                            h(params, sid)
                        except Exception as e:
                            sys.stderr.write(f"[handler {method}] {type(e).__name__}: {e}\n")


async def main_async(args) -> None:
    # --- Capture dir + JSONL setup ---
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    site_dir = SESSIONS / args.slug
    capture_dir = site_dir / ts
    capture_dir.mkdir(parents=True, exist_ok=True)
    bodies_dir = capture_dir / "bodies"
    bodies_dir.mkdir(exist_ok=True)
    requests_path = capture_dir / "requests.jsonl"
    console_path = capture_dir / "console.log"
    requests_f = requests_path.open("w", buffering=1)  # line-buffered
    console_f = console_path.open("w", buffering=1)

    # latest pointer (txt fallback for Windows where symlinks need admin)
    latest_link = site_dir / "latest"
    try:
        if latest_link.is_symlink() or latest_link.exists():
            latest_link.unlink()
        latest_link.symlink_to(ts)
    except Exception:
        try:
            (site_dir / "latest.txt").write_text(ts)
        except Exception as e:
            sys.stderr.write(f"[cdp_capture] could not write latest pointer: {e}\n")

    sys.stderr.write(f"[cdp_capture] capture dir: {capture_dir}\n")

    # --- Connect to Chrome's CDP ---
    browser_ws = discover_browser_ws(args.connect)
    sys.stderr.write(f"[cdp_capture] browser ws: {browser_ws}\n")

    async with websockets.connect(browser_ws, max_size=64 * 1024 * 1024) as ws:
        cdp = CDP(ws)
        reader_task = asyncio.create_task(cdp.reader())
        body_sem = asyncio.Semaphore(BODY_CONCURRENCY)
        body_host_allowlist = tuple(
            h.strip() for h in os.environ.get("DDX_BODY_HOST_ALLOWLIST", "").split(",") if h.strip()
        )
        if body_host_allowlist:
            sys.stderr.write(f"[capture] body allowlist active: {list(body_host_allowlist)}\n")

        # --- Per-target attach plan ---
        # session_id -> {target_id, type, url}
        sessions: dict[str, dict] = {}

        def write(obj: dict) -> None:
            try:
                requests_f.write(json.dumps(obj, default=str) + "\n")
            except Exception as e:
                sys.stderr.write(f"[write] {e}\n")

        def write_console(line: str) -> None:
            try:
                console_f.write(line + "\n")
            except Exception:
                pass

        # ----- event handlers -----
        # Network domain — main capture
        def on_request_will_be_sent(p, sid):
            req = p.get("request") or {}
            write({
                "ts": now_iso(),
                "kind": "request",
                "method": req.get("method"),
                "url": req.get("url"),
                "resource_type": p.get("type"),
                "headers": req.get("headers") or {},
                "post_data": req.get("postData"),
                "request_id": p.get("requestId"),
                "frame_id": p.get("frameId"),
                "is_navigation": p.get("type") == "Document",
            })

        def on_response_received(p, sid):
            resp = p.get("response") or {}
            write({
                "ts": now_iso(),
                "kind": "response",
                "status": resp.get("status"),
                "url": resp.get("url"),
                "method": resp.get("requestHeaders", {}).get(":method") or None,
                "headers": resp.get("headers") or {},
                "request_id": p.get("requestId"),
                "mime_type": resp.get("mimeType"),
                "remote_ip": resp.get("remoteIPAddress"),
                "from_cache": resp.get("fromDiskCache") or resp.get("fromServiceWorker"),
            })
            if args.capture_bodies:
                url_l = resp.get("url", "")
                rtype_l = p.get("type", "")
                skip = False
                if rtype_l in BODY_SKIP_TYPES:
                    skip = True
                elif any(s in url_l for s in BODY_SKIP_HOSTS):
                    skip = True
                elif body_host_allowlist and not any(a in url_l for a in body_host_allowlist):
                    skip = True
                if not skip:
                    # Background task — doesn't block the WS reader. Concurrency
                    # limited by body_sem (declared below).
                    asyncio.create_task(_capture_body(cdp, sid, p.get("requestId"), url_l, resp.get("status"), p.get("type"), bodies_dir, write, body_sem))

        def on_response_extra_info(p, sid):
            # Has the actual Set-Cookie header values, separately from
            # responseReceived (Chrome architecture splits them).
            headers = p.get("headers") or {}
            for k, v in headers.items():
                if k.lower() == "set-cookie":
                    for line in str(v).split("\n"):
                        if line.strip():
                            write({
                                "ts": now_iso(),
                                "kind": "set_cookie",
                                "request_id": p.get("requestId"),
                                "value": line,
                            })

        def on_ws_created(p, sid):
            write({"ts": now_iso(), "kind": "ws_open", "request_id": p.get("requestId"), "url": p.get("url")})

        def on_ws_frame_sent(p, sid):
            write({
                "ts": now_iso(),
                "kind": "ws_send",
                "request_id": p.get("requestId"),
                "data": (p.get("response") or {}).get("payloadData", "")[:262144],
                "opcode": (p.get("response") or {}).get("opcode"),
                "mask": (p.get("response") or {}).get("mask"),
            })

        def on_ws_frame_received(p, sid):
            write({
                "ts": now_iso(),
                "kind": "ws_recv",
                "request_id": p.get("requestId"),
                "data": (p.get("response") or {}).get("payloadData", "")[:262144],
                "opcode": (p.get("response") or {}).get("opcode"),
            })

        def on_ws_closed(p, sid):
            write({"ts": now_iso(), "kind": "ws_close", "request_id": p.get("requestId")})

        # Optional: console capture (requires Runtime.enable)
        def on_console_api_called(p, sid):
            try:
                args_summary = []
                for a in (p.get("args") or [])[:8]:
                    if "value" in a:
                        args_summary.append(str(a["value"])[:1000])
                    elif "description" in a:
                        args_summary.append(str(a["description"])[:1000])
                line = f"[{p.get('type','log')}] " + " ".join(args_summary)
                write_console(line)
            except Exception:
                pass

        # ----- additional FREE event subscriptions ---------------------------
        # All emitted by Chrome whenever the Network domain is on; subscribing
        # adds zero round-trips (Chrome ships them anyway).
        def on_request_extra_info(p, sid):
            # Request-side cookies (incl. ones Chrome added from the jar)
            cookies = p.get("associatedCookies") or []
            if cookies:
                write({
                    "ts": now_iso(),
                    "kind": "request_cookies",
                    "request_id": p.get("requestId"),
                    "cookies": [c.get("cookie", {}).get("name") for c in cookies],
                    "blocked": [c.get("blockedReasons") for c in cookies if c.get("blockedReasons")],
                })

        def on_loading_finished(p, sid):
            write({
                "ts": now_iso(),
                "kind": "loading_finished",
                "request_id": p.get("requestId"),
                "encoded_bytes": p.get("encodedDataLength"),
            })

        def on_loading_failed(p, sid):
            # net::ERR_FAILED, ERR_BLOCKED_BY_CLIENT, etc. — invaluable for
            # diagnosing why a request didn't go through.
            write({
                "ts": now_iso(),
                "kind": "loading_failed",
                "request_id": p.get("requestId"),
                "type": p.get("type"),
                "error": p.get("errorText"),
                "blocked_reason": p.get("blockedReason"),
                "canceled": p.get("canceled"),
            })

        def on_served_from_cache(p, sid):
            write({"ts": now_iso(), "kind": "served_from_cache", "request_id": p.get("requestId")})

        def on_event_source_message(p, sid):
            # Server-Sent Events stream messages — chat/notifications style apps
            write({
                "ts": now_iso(),
                "kind": "sse_message",
                "request_id": p.get("requestId"),
                "event_name": p.get("eventName"),
                "event_id": p.get("eventId"),
                "data": (p.get("data") or "")[:65536],
            })

        def on_target_info_changed(p, sid):
            # URL/title change for any attached target — free navigation tracking
            # without enabling the Page domain.
            ti = p.get("targetInfo") or {}
            existing = next(
                (s for s, info in sessions.items() if info["target_id"] == ti.get("targetId")),
                None,
            )
            if existing:
                old_url = sessions[existing].get("url", "")
                new_url = ti.get("url", "")
                if old_url != new_url:
                    sessions[existing]["url"] = new_url
                    write({
                        "ts": now_iso(),
                        "kind": "target_url_changed",
                        "session_id": existing,
                        "old_url": old_url,
                        "new_url": new_url,
                        "title": ti.get("title", ""),
                    })

        cdp.on("Network.requestWillBeSent", on_request_will_be_sent)
        cdp.on("Network.requestWillBeSentExtraInfo", on_request_extra_info)
        cdp.on("Network.responseReceived", on_response_received)
        cdp.on("Network.responseReceivedExtraInfo", on_response_extra_info)
        cdp.on("Network.loadingFinished", on_loading_finished)
        cdp.on("Network.loadingFailed", on_loading_failed)
        cdp.on("Network.requestServedFromCache", on_served_from_cache)
        cdp.on("Network.eventSourceMessageReceived", on_event_source_message)
        cdp.on("Network.webSocketCreated", on_ws_created)
        cdp.on("Network.webSocketFrameSent", on_ws_frame_sent)
        cdp.on("Network.webSocketFrameReceived", on_ws_frame_received)
        cdp.on("Network.webSocketClosed", on_ws_closed)
        cdp.on("Target.targetInfoChanged", on_target_info_changed)
        if args.enable_runtime:
            cdp.on("Runtime.consoleAPICalled", on_console_api_called)

        # ----- target lifecycle -----
        async def attach(target_info: dict):
            t_type = target_info.get("type")
            t_id = target_info.get("targetId")
            if t_type not in ("page", "iframe", "service_worker", "shared_worker", "worker"):
                return
            try:
                r = await cdp.call("Target.attachToTarget", {"targetId": t_id, "flatten": True})
            except Exception as e:
                sys.stderr.write(f"[attach] {t_id}: {e}\n")
                return
            sid = r["sessionId"]
            sessions[sid] = {"target_id": t_id, "type": t_type, "url": target_info.get("url", "")}
            write({"ts": now_iso(), "kind": "target_attached", "type": t_type, "url": target_info.get("url", ""), "session_id": sid})
            try:
                await cdp.call("Network.enable", {}, session_id=sid)
                if args.enable_page and t_type in ("page", "iframe"):
                    await cdp.call("Page.enable", {}, session_id=sid)
                if args.enable_runtime:
                    await cdp.call("Runtime.enable", {}, session_id=sid)
                if args.storage_hook and STORAGE_HOOK.exists() and args.enable_page:
                    src = STORAGE_HOOK.read_text(encoding="utf-8")
                    await cdp.call(
                        "Page.addScriptToEvaluateOnNewDocument",
                        {"source": src, "runImmediately": True},
                        session_id=sid,
                    )
            except Exception as e:
                sys.stderr.write(f"[enable {t_type}] {e}\n")

        def on_target_created(p, sid):
            asyncio.create_task(attach(p["targetInfo"]))

        def on_target_destroyed(p, sid):
            # We don't get sessionId here, but we can drop matching session by target_id.
            tid = p.get("targetId")
            for s, info in list(sessions.items()):
                if info["target_id"] == tid:
                    sessions.pop(s, None)
                    write({"ts": now_iso(), "kind": "target_destroyed", "session_id": s})

        cdp.on("Target.targetCreated", on_target_created)
        cdp.on("Target.targetDestroyed", on_target_destroyed)

        # Discover all current + future targets. flatten=True multiplexes their
        # CDP messages onto our existing WS; no per-target socket.
        await cdp.call("Target.setDiscoverTargets", {"discover": True})
        await cdp.call(
            "Target.setAutoAttach",
            {"autoAttach": True, "waitForDebuggerOnStart": False, "flatten": True},
        )

        # Force-attach to current targets (Target.setAutoAttach only catches NEW ones).
        cur = await cdp.call("Target.getTargets")
        for t in cur.get("targetInfos", []):
            await attach(t)

        sys.stderr.write(f"[cdp_capture] attached to {len(sessions)} target(s); writing → {requests_path}\n")
        sys.stderr.flush()

        # --- Idle until SIGTERM/SIGINT, but also process drive.py command channel ---
        cmd_in = capture_dir / "cmd.in.jsonl"
        cmd_out = capture_dir / "cmd.out.jsonl"
        cmd_in.touch()
        cmd_out.touch()
        cmd_pos = cmd_in.stat().st_size

        stop = asyncio.Event()

        def _stop(*_):
            stop.set()

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, _stop)
            except NotImplementedError:
                # Windows doesn't support add_signal_handler for SIGTERM; rely
                # on KeyboardInterrupt from SIGINT instead.
                pass

        async def cmd_loop():
            nonlocal cmd_pos
            while not stop.is_set():
                try:
                    sz = cmd_in.stat().st_size
                    if sz > cmd_pos:
                        with cmd_in.open() as f:
                            f.seek(cmd_pos)
                            chunk = f.read()
                            cmd_pos = f.tell()
                        for line in chunk.splitlines():
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                cmd = json.loads(line)
                            except Exception as e:
                                _write_cmd_result(cmd_out, {"id": None, "ok": False, "error": f"bad json: {e}"})
                                continue
                            await _handle_cmd(cdp, sessions, cmd, cmd_out, args)
                except Exception as e:
                    sys.stderr.write(f"[cmd loop] {e}\n")
                await asyncio.sleep(0.1)

        cmd_task = asyncio.create_task(cmd_loop())
        try:
            await stop.wait()
        except KeyboardInterrupt:
            pass
        cmd_task.cancel()
        reader_task.cancel()
        try:
            await asyncio.gather(cmd_task, reader_task, return_exceptions=True)
        except Exception:
            pass

    requests_f.close()
    console_f.close()
    sys.stderr.write("[cdp_capture] shut down\n")


async def _capture_body(cdp, sid, request_id, url, status, rtype, bodies_dir, write, sem):
    """Background body fetch — doesn't block the WS reader."""
    if rtype in BODY_SKIP_TYPES or status in (0, 204, 304):
        return
    async with sem:
        try:
            r = await cdp.call("Network.getResponseBody", {"requestId": request_id}, session_id=sid)
            body = r.get("body", "")
            is_b64 = r.get("base64Encoded", False)
            data = base64.b64decode(body) if is_b64 else body.encode("utf-8", "replace")
            truncated = False
            if len(data) > MAX_BODY_BYTES:
                data = data[:MAX_BODY_BYTES]
                truncated = True
            safe = (url or "").split("?", 1)[0].replace("https://", "").replace("http://", "").replace("/", "_")[:100]
            fname = f"{request_id}-{status}-{safe}.bin"
            (bodies_dir / fname).write_bytes(data)
            write({
                "ts": now_iso(),
                "kind": "body",
                "request_id": request_id,
                "url": url,
                "status": status,
                "size": len(data),
                "truncated": truncated,
                "path": f"bodies/{fname}",
            })
        except Exception:
            # Body unavailable (cross-origin opaque, redirect, expired)
            pass


def _write_cmd_result(cmd_out: Path, obj: dict) -> None:
    try:
        with cmd_out.open("a") as f:
            f.write(json.dumps(obj, default=str) + "\n")
    except Exception as e:
        sys.stderr.write(f"[cmd result] {e}\n")


async def _handle_cmd(cdp, sessions, cmd, cmd_out, args):
    """Implement a small subset of drive.py actions via raw CDP."""
    cid = cmd.get("id")
    action = cmd.get("action")
    a = cmd.get("args") or {}

    # Pick first attached page-type session as "active".
    page_sids = [s for s, info in sessions.items() if info["type"] == "page"]
    if not page_sids:
        _write_cmd_result(cmd_out, {"id": cid, "ok": False, "error": "no page session"})
        return
    sid = page_sids[0]

    try:
        if action == "url":
            # Page.getNavigationHistory if Page enabled, else evaluate.
            if args.enable_page:
                r = await cdp.call("Page.getNavigationHistory", {}, session_id=sid)
                entries = r.get("entries", [])
                idx = r.get("currentIndex", 0)
                cur = entries[idx]["url"] if entries else ""
                _write_cmd_result(cmd_out, {"id": cid, "ok": True, "result": cur})
                return
            if not args.enable_runtime:
                _write_cmd_result(cmd_out, {"id": cid, "ok": False, "error": "url requires --enable-page or --enable-runtime"})
                return
            r = await cdp.call("Runtime.evaluate", {"expression": "location.href", "returnByValue": True}, session_id=sid)
            _write_cmd_result(cmd_out, {"id": cid, "ok": True, "result": r.get("result", {}).get("value")})

        elif action == "title":
            if not args.enable_runtime:
                _write_cmd_result(cmd_out, {"id": cid, "ok": False, "error": "title requires --enable-runtime"})
                return
            r = await cdp.call("Runtime.evaluate", {"expression": "document.title", "returnByValue": True}, session_id=sid)
            _write_cmd_result(cmd_out, {"id": cid, "ok": True, "result": r.get("result", {}).get("value")})

        elif action == "evaluate":
            if not args.enable_runtime:
                _write_cmd_result(cmd_out, {"id": cid, "ok": False, "error": "evaluate requires --enable-runtime"})
                return
            r = await cdp.call("Runtime.evaluate", {"expression": a["expr"], "returnByValue": True, "awaitPromise": True}, session_id=sid)
            res = r.get("result", {})
            if res.get("subtype") == "error":
                _write_cmd_result(cmd_out, {"id": cid, "ok": False, "error": res.get("description")})
            else:
                _write_cmd_result(cmd_out, {"id": cid, "ok": True, "result": res.get("value")})

        elif action == "goto":
            r = await cdp.call("Page.navigate", {"url": a["url"]}, session_id=sid)
            _write_cmd_result(cmd_out, {"id": cid, "ok": True, "result": r})

        elif action == "cookies":
            r = await cdp.call("Network.getCookies", {}, session_id=sid)
            _write_cmd_result(cmd_out, {"id": cid, "ok": True, "result": r.get("cookies", [])})

        elif action == "screenshot":
            r = await cdp.call("Page.captureScreenshot", {"format": a.get("format", "png")}, session_id=sid)
            data = base64.b64decode(r["data"])
            path = Path(a["path"])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            _write_cmd_result(cmd_out, {"id": cid, "ok": True, "result": str(path)})

        else:
            _write_cmd_result(cmd_out, {"id": cid, "ok": False, "error": f"unsupported in raw CDP mode: {action}"})

    except Exception as e:
        _write_cmd_result(cmd_out, {"id": cid, "ok": False, "error": f"{type(e).__name__}: {e}"})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--connect", required=True, help="Chrome CDP HTTP base URL, e.g. http://127.0.0.1:9333")
    ap.add_argument("--enable-runtime", action="store_true", help="Enable Runtime per target (needed for evaluate/title/console capture). Detectable.")
    ap.add_argument("--enable-page", action="store_true", help="Enable Page per target (needed for navigation/lifecycle events + Page.addScriptToEvaluateOnNewDocument). Detectable.")
    ap.add_argument("--capture-bodies", action="store_true", help="Fetch response bodies via background tasks. Each body costs a CDP round-trip but doesn't block the reader (unlike Playwright's sync .body()).")
    ap.add_argument("--storage-hook", action="store_true", help="Inject scripts/storage_hook.js as init script. Requires --enable-page.")
    args = ap.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
