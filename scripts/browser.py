"""Shared Playwright harness for AwardViewer.

Opens a persistent Chromium context per site slug so auth cookies survive
across runs. Captures HAR, console output, and a JSONL request log into
sessions/<slug>/<timestamp>/ automatically.

Usage:
    python3 scripts/browser.py <slug> <url>                 # headless
    python3 scripts/browser.py <slug> <url> --headed
    python3 scripts/browser.py <slug> <url> --eval 'EXPR'   # run JS, print result
    python3 scripts/browser.py <slug> <url> --shell         # drop into pdb with `page` bound
    python3 scripts/browser.py <slug> <url> --headed --keep # load and stay alive until killed (SIGTERM/SIGINT)

When --keep is on, a JSONL command channel is exposed at
    sessions/<slug>/<ts>/cmd.in.jsonl   (callers append commands here)
    sessions/<slug>/<ts>/cmd.out.jsonl  (results land here)
so other scripts (see scripts/drive.py) can drive the live page without
relaunching the browser. The latest capture dir is also linked at
    sessions/<slug>/latest -> <ts>
so callers don't need to know the timestamp.

The persistent profile lives at sessions/<slug>/state/. Delete it to reset auth.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Use patchright (stealth-patched Playwright drop-in) by default; fall back to
# stock playwright if patchright isn't installed. patchright fixes the deep CDP
# fingerprints (Runtime.enable leak, --enable-automation, etc.) that Cloudflare
# / Akamai / DataDome bot detection looks at. We layer playwright_stealth's JS
# overrides (navigator.webdriver, plugins, WebGL vendor) on top.
try:
    from patchright.sync_api import sync_playwright  # type: ignore
    _USING_PATCHRIGHT = True
except ImportError:
    from playwright.sync_api import sync_playwright
    _USING_PATCHRIGHT = False

try:
    from playwright_stealth import Stealth  # v2 API
    _STEALTH_AVAILABLE = True
except ImportError:
    Stealth = None  # type: ignore
    _STEALTH_AVAILABLE = False

ROOT = Path(__file__).resolve().parent.parent
# Sessions/captures default to <repo>/sessions/, but can be overridden via
# DDX_SESSIONS env var. Use this when running browser.py on Windows but
# accessing the script from WSL — point sessions at a Windows-native path
# (e.g. C:\Users\28655\AppData\Local\AwardViewer\sessions) so file writes don't
# go through 9P, and drive.py from WSL still reads them via /mnt/c/...
SESSIONS = Path(os.environ.get("DDX_SESSIONS", "")) if os.environ.get("DDX_SESSIONS") else ROOT / "sessions"
SCRIPTS = ROOT / "scripts"

# Location of the user-extracted real Chrome (see README / setup notes).
# We prefer this over patchright/chromium because real Chrome fails fewer
# fingerprint checks (component version strings, User-Agent Client Hints,
# chrome.app internals). Extracted from a .deb to a user-owned dir so no sudo
# was needed.
USER_CHROME = Path.home() / ".local/chrome/opt/google/chrome/google-chrome"

# UA matching installed Chrome 147 (linux). If we fall back to chromium, we
# still override UA to this so fingerprints agree.
REAL_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
)

STEALTH_EXTRAS = SCRIPTS / "stealth_extras.js"
STORAGE_HOOK = SCRIPTS / "storage_hook.js"

# Per-body cap for response body capture. We capture every body but truncate
# anything bigger than this to keep disk usage sane on huge media/streams.
MAX_BODY_BYTES = 50 * 1024 * 1024  # 50 MB
# Per-frame cap for WebSocket frame bodies in the JSONL log.
MAX_WS_FRAME_BYTES = 256 * 1024  # 256 KB
# Per-script cap for JS sources we mirror to disk.
MAX_SCRIPT_BYTES = 8 * 1024 * 1024  # 8 MB


# --- command channel actions ----------------------------------------------

def _act_goto(page, args):
    return page.goto(
        args["url"],
        wait_until=args.get("wait_until", "domcontentloaded"),
        timeout=args.get("timeout", 30_000),
    ) and page.url

def _act_url(page, args):
    return page.url

def _act_title(page, args):
    return page.title()

def _act_evaluate(page, args):
    return page.evaluate(args["expr"])

def _act_fill(page, args):
    page.locator(args["selector"]).first.fill(args["value"], timeout=args.get("timeout", 5000))
    return True

def _act_click(page, args):
    page.locator(args["selector"]).first.click(timeout=args.get("timeout", 5000))
    return True

def _act_press(page, args):
    page.keyboard.press(args["key"])
    return True

def _act_type(page, args):
    page.keyboard.type(args["text"], delay=args.get("delay", 0))
    return True

def _act_wait_for_selector(page, args):
    loc = page.wait_for_selector(
        args["selector"],
        timeout=args.get("timeout", 10_000),
        state=args.get("state", "visible"),
    )
    return bool(loc)

def _act_wait_for_url(page, args):
    page.wait_for_url(args["url"], timeout=args.get("timeout", 15_000))
    return page.url

def _act_wait_for_load_state(page, args):
    page.wait_for_load_state(args.get("state", "networkidle"), timeout=args.get("timeout", 15_000))
    return True

def _act_query_inputs(page, args):
    sel = args.get("selector") or "input,button,a"
    return page.evaluate(
        "(s) => Array.from(document.querySelectorAll(s)).slice(0,80).map(el => ({"
        "tag: el.tagName, type: el.type, name: el.name, id: el.id, "
        "placeholder: el.placeholder, role: el.getAttribute('role'), "
        "text: (el.innerText||'').slice(0,80), href: el.href, "
        "visible: !!(el.offsetParent)}))",
        sel,
    )

def _act_screenshot(page, args):
    path = Path(args["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(path), full_page=args.get("full_page", False))
    return str(path)

def _act_cookies(page, args):
    return page.context.cookies()

def _act_storage(page, args):
    return page.evaluate(
        "({local: Object.fromEntries(Object.entries(localStorage)), session: Object.fromEntries(Object.entries(sessionStorage))})"
    )

def _act_pages(page, args):
    return [{"url": p.url, "title": (p.title() if p.url != "about:blank" else "")} for p in page.context.pages]

def _act_focus_page(page, args):
    """Switch the driven page index. Returns the new url."""
    idx = args.get("index", 0)
    pages = page.context.pages
    if 0 <= idx < len(pages):
        return {"index": idx, "url": pages[idx].url}
    return {"error": "out_of_range", "count": len(pages)}

def _act_new_page(page, args):
    p = page.context.new_page()
    if args.get("url"):
        p.goto(args["url"], wait_until=args.get("wait_until", "domcontentloaded"))
    return {"url": p.url, "index": page.context.pages.index(p)}


# Filled in by run() at startup so action handlers can reach the per-page
# CDP sessions for Profiler.takePreciseCoverage etc.
_RUNTIME: dict = {}


def _act_coverage_dump(page, args):
    """Take JS coverage snapshot from the active page's CDP session and clear
    counters. Returns one entry per script with executed function/range info."""
    cdp = (_RUNTIME.get("cdp_sessions") or {}).get(id(page))
    if cdp is None:
        return {"error": "no CDP session for this page"}
    snap = cdp.send("Profiler.takePreciseCoverage")
    # Optionally also stop+restart counters to reset.
    if args.get("reset"):
        cdp.send("Profiler.stopPreciseCoverage")
        cdp.send(
            "Profiler.startPreciseCoverage",
            {"callCount": True, "detailed": True, "allowTriggeredUpdates": True},
        )
    # Compress: most consumers care about which scripts executed which
    # ranges, not the raw output. Return as-is and let caller summarize.
    return snap


def _act_scripts_meta(page, args):
    """List script files we've mirrored to disk for the current capture."""
    cap = _RUNTIME.get("capture_dir")
    if not cap:
        return {"error": "capture dir unset"}
    sd = cap / "scripts"
    if not sd.exists():
        return []
    items = []
    for f in sorted(sd.glob("*.js")):
        items.append({"hash": f.stem, "size": f.stat().st_size})
    return items


def _act_request_storage(page, args):
    """Dump cookies + localStorage + sessionStorage in one shot."""
    cookies = page.context.cookies()
    storage = page.evaluate(
        "({local: Object.fromEntries(Object.entries(localStorage)),"
        " session: Object.fromEntries(Object.entries(sessionStorage))})"
    )
    return {"cookies": cookies, "localStorage": storage["local"], "sessionStorage": storage["session"]}


# ---- "human-like" interaction primitives ---------------------------------
# These dispatch real Playwright methods (locator.click, keyboard.type)
# rather than synthetic JS click()/value= so React/CF see proper user events.

import random as _random


def _act_human_click(page, args):
    sel = args["selector"]
    timeout = args.get("timeout", 8000)
    loc = page.locator(sel).first
    loc.scroll_into_view_if_needed(timeout=timeout)
    box = loc.bounding_box(timeout=timeout)
    if box:
        # Move mouse along a 3-step jitter path to a random point inside the element.
        tx = box["x"] + box["width"] * _random.uniform(0.3, 0.7)
        ty = box["y"] + box["height"] * _random.uniform(0.3, 0.7)
        cur_x = _random.uniform(tx - 200, tx + 200)
        cur_y = _random.uniform(ty - 200, ty + 200)
        page.mouse.move(cur_x, cur_y)
        steps = 8 + _random.randint(0, 8)
        for i in range(1, steps + 1):
            mid_x = cur_x + (tx - cur_x) * (i / steps) + _random.uniform(-2, 2)
            mid_y = cur_y + (ty - cur_y) * (i / steps) + _random.uniform(-2, 2)
            page.mouse.move(mid_x, mid_y, steps=2)
        page.mouse.click(tx, ty, delay=_random.randint(40, 110))
    else:
        loc.click(timeout=timeout, delay=_random.randint(40, 110))
    return True


def _act_human_type(page, args):
    """Char-by-char typing with random per-char delays. Optionally focuses sel first."""
    text = args["text"]
    sel = args.get("selector")
    if sel:
        loc = page.locator(sel).first
        loc.scroll_into_view_if_needed(timeout=args.get("timeout", 8000))
        # Click via mouse to focus realistically.
        box = loc.bounding_box()
        if box:
            tx = box["x"] + box["width"] * 0.5
            ty = box["y"] + box["height"] * 0.5
            page.mouse.move(tx + _random.uniform(-30, 30), ty + _random.uniform(-30, 30))
            page.mouse.move(tx, ty, steps=6)
            page.mouse.click(tx, ty, delay=_random.randint(40, 90))
    # Per-char delays, slightly variable.
    base = args.get("delay_ms", 90)
    jitter = args.get("jitter_ms", 80)
    for ch in text:
        page.keyboard.type(ch)
        time.sleep((base + _random.randint(0, jitter)) / 1000.0)
    return True


def _act_mouse_move(page, args):
    """Move mouse to (x, y) optionally with steps. If 'jitter' true, walk randomly."""
    if args.get("jitter"):
        n = args.get("count", 6)
        for _ in range(n):
            x = _random.randint(50, 1300)
            y = _random.randint(50, 800)
            page.mouse.move(x, y, steps=_random.randint(8, 20))
            time.sleep(_random.uniform(0.05, 0.25))
        return True
    x = args["x"]; y = args["y"]
    page.mouse.move(x, y, steps=args.get("steps", 10))
    return True


def _act_scroll(page, args):
    """Smooth-scroll by dy pixels (default 400) over several wheel events."""
    dy = args.get("dy", 400)
    chunks = max(4, abs(dy) // 100)
    step = dy / chunks
    for _ in range(chunks):
        page.mouse.wheel(0, step)
        time.sleep(_random.uniform(0.04, 0.12))
    return True


def _act_pause(page, args):
    secs = args.get("seconds", 1.0)
    # Sleep in small chunks so we don't hold the keep loop too long;
    # but the keep loop dispatches one command at a time so this is fine.
    end = time.time() + secs
    while time.time() < end:
        time.sleep(min(0.2, end - time.time()))
    return True


def _act_inner_text(page, args):
    return page.evaluate(
        "(s) => { const el = document.querySelector(s); return el ? el.innerText : null; }",
        args["selector"],
    )


def _act_dump_text(page, args):
    n = args.get("max_lines", 60)
    return page.evaluate(
        "(n) => document.body.innerText.split('\\n').filter(l=>l.trim()).slice(0,n)",
        n,
    )

ACTIONS = {
    "goto": _act_goto,
    "url": _act_url,
    "title": _act_title,
    "evaluate": _act_evaluate,
    "fill": _act_fill,
    "click": _act_click,
    "press": _act_press,
    "type": _act_type,
    "wait_for_selector": _act_wait_for_selector,
    "wait_for_url": _act_wait_for_url,
    "wait_for_load_state": _act_wait_for_load_state,
    "query_inputs": _act_query_inputs,
    "screenshot": _act_screenshot,
    "cookies": _act_cookies,
    "storage": _act_storage,
    "pages": _act_pages,
    "focus_page": _act_focus_page,
    "new_page": _act_new_page,
    # Human-like primitives:
    "human_click": _act_human_click,
    "human_type": _act_human_type,
    "mouse_move": _act_mouse_move,
    "scroll": _act_scroll,
    "pause": _act_pause,
    "inner_text": _act_inner_text,
    "dump_text": _act_dump_text,
    # Capture snapshots:
    "coverage_dump": _act_coverage_dump,
    "scripts_meta": _act_scripts_meta,
    "full_storage": _act_request_storage,
}

# Resource types we still skip for body capture by default — pure asset noise
# that bloats disk without telling us anything about the app's behavior. Set
# DDX_CAPTURE_ALL_BODIES=1 to capture even these.
SKIP_BODY_RESOURCE_TYPES = {"image", "font", "media", "stylesheet"}

# URL substring blocklist for body capture — third-party analytics/ad/RUM
# endpoints. They're noisy AND each one costs a CDP getResponseBody round-trip
# which slows the renderer because Playwright serializes them. Set
# DDX_CAPTURE_ALL_BODIES=1 to override and grab everything.
BODY_SKIP_HOSTS = (
    "google-analytics.com", "googletagmanager.com", "googleadservices.com",
    "doubleclick.net", "googlesyndication.com",
    "ad.doubleclick.net", "googletagservices.com", "g.doubleclick.net",
    "facebook.com/tr", "facebook.net", "fbcdn.net",
    "pinterest.com/v3", "ct.pinterest.com",
    "linkedin.com/wa", "ads.linkedin.com", "px.ads.linkedin.com",
    "clarity.ms", "twitter.com/i/adsct", "analytics.twitter.com", "t.co/i/adsct",
    "amplitude.com/2/", "api.amplitude.com",
    "segment.io/v1", "cdn.segment.com",
    "sentry.io/api", "ingest.sentry.io",
    "snapchat.com/p/", "cm.tiktok.com",
    "reddit.com/pixel", "ads-pixel.reddit.com",
    "/cdn-cgi/rum",  # Cloudflare RUM beacon
    "/ccm/collect", "/rmkt/collect", "/pagead/", "/g/collect",
)


def run(slug: str, url: str, headed: bool, eval_expr: str | None, shell: bool, keep: bool, connect_cdp: str | None = None, no_goto: bool = False, capture_scripts: bool = False, capture_coverage: bool = False, capture_bodies: bool = False, capture_post_buffers: bool = False) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    site_dir = SESSIONS / slug
    state_dir = site_dir / "state"
    capture_dir = site_dir / ts
    state_dir.mkdir(parents=True, exist_ok=True)
    capture_dir.mkdir(parents=True, exist_ok=True)

    # "latest" pointer to this ts so callers don't need to know the timestamp.
    # Symlinks on Windows need admin/Developer Mode; fall back to writing the
    # timestamp into a sentinel file that drive.py reads.
    latest_link = site_dir / "latest"
    try:
        if latest_link.is_symlink() or latest_link.exists():
            latest_link.unlink()
        latest_link.symlink_to(ts)
    except Exception as e:
        sys.stderr.write(f"[keep] symlink unavailable ({e}); writing latest.txt fallback\n")
        try:
            (site_dir / "latest.txt").write_text(ts)
        except Exception as e2:
            sys.stderr.write(f"[keep] latest.txt fallback also failed: {e2}\n")

    har_path = capture_dir / "network.har"
    console_path = capture_dir / "console.log"
    requests_path = capture_dir / "requests.jsonl"
    meta_path = capture_dir / "meta.json"
    bodies_dir = capture_dir / "bodies"
    scripts_dir = capture_dir / "scripts"
    workers_dir = capture_dir / "workers"
    bodies_dir.mkdir(exist_ok=True)
    scripts_dir.mkdir(exist_ok=True)
    workers_dir.mkdir(exist_ok=True)

    console_f = console_path.open("w")
    requests_f = requests_path.open("w")
    body_seq = {"n": 0}
    seen_script_hashes: set[str] = set()
    capture_all_bodies = os.environ.get("DDX_CAPTURE_ALL_BODIES") == "1"
    body_host_allowlist = tuple(
        h.strip() for h in os.environ.get("DDX_BODY_HOST_ALLOWLIST", "").split(",") if h.strip()
    )
    if body_host_allowlist:
        sys.stderr.write(f"[capture] body allowlist active: {list(body_host_allowlist)}\n")
    # URL substrings to drop entirely from request/response/websocket logs.
    # Use this to skip third-party telemetry chatter (Datadog RUM, GA4, etc.)
    # that would otherwise flood requests.jsonl on heavy SPA pages and add
    # per-event JSON-serialize + disk-flush overhead. The init-script stealth
    # shims still run; this only gates the per-event handlers.
    request_skip_hosts = tuple(
        h.strip() for h in os.environ.get("DDX_REQUEST_SKIP_HOSTS", "").split(",") if h.strip()
    )
    if request_skip_hosts:
        sys.stderr.write(f"[capture] request skip-list active: {list(request_skip_hosts)}\n")

    sys.stderr.write(
        f"[stealth] patchright={_USING_PATCHRIGHT} playwright_stealth={_STEALTH_AVAILABLE}\n"
    )
    if connect_cdp:
        sys.stderr.write(f"[connect] attaching to existing browser at {connect_cdp}\n")

    with sync_playwright() as p:
        # Try real Chrome first (most realistic), fall back to chromium build.
        launch_kwargs = dict(
            user_data_dir=str(state_dir),
            headless=not headed,
            record_har_path=str(har_path),
            record_har_content="embed",
            viewport={"width": 1440, "height": 900},
            user_agent=REAL_UA,
            locale="en-US",
            timezone_id="America/Los_Angeles",
            color_scheme="light",
            device_scale_factor=1,
            ignore_default_args=["--enable-automation"],
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
                "--password-store=basic",
                "--use-mock-keychain",
                "--lang=en-US",
            ],
        )
        context = None
        attached_browser = None
        if connect_cdp:
            # Attach to an externally-launched browser (e.g. Windows Chrome via
            # WSL interop, see scripts/win_chrome.py). We don't get HAR (Playwright
            # can only HAR contexts it created), but our requests.jsonl + body
            # capture listeners cover the same ground.
            attached_browser = p.chromium.connect_over_cdp(connect_cdp)
            ctxs = attached_browser.contexts
            if not ctxs:
                # Some Chrome configs expose no contexts via CDP until a page
                # exists. Create one.
                context = attached_browser.new_context()
            else:
                context = ctxs[0]
            sys.stderr.write(
                f"[connect] attached. contexts={len(ctxs) or 1}, pages={len(context.pages)}\n"
            )
        else:
            # 1st choice: user-extracted real Chrome (best fingerprint match).
            if USER_CHROME.exists():
                try:
                    context = p.chromium.launch_persistent_context(
                        executable_path=str(USER_CHROME), **launch_kwargs
                    )
                    sys.stderr.write(f"[stealth] using real Chrome at {USER_CHROME}\n")
                except Exception as e:
                    sys.stderr.write(f"[stealth] real Chrome launch failed ({e}); trying chrome channel\n")
            # 2nd choice: system-installed chrome channel.
            if context is None:
                try:
                    context = p.chromium.launch_persistent_context(channel="chrome", **launch_kwargs)
                    sys.stderr.write("[stealth] using system chrome channel\n")
                except Exception as e:
                    sys.stderr.write(f"[stealth] chrome channel unavailable ({e}); falling back to chromium\n")
            # 3rd choice: patchright/chromium bundled build.
            if context is None:
                context = p.chromium.launch_persistent_context(**launch_kwargs)
                sys.stderr.write("[stealth] fell back to chromium build\n")

        # Supplementary stealth: load the big init script from scripts/stealth_extras.js
        # which covers canvas/audio/webgl/battery/connection/hardware/plugins shims
        # that playwright-stealth doesn't touch. Applied at context level so every
        # current + future page inherits it.
        if STEALTH_EXTRAS.exists():
            try:
                context.add_init_script(path=str(STEALTH_EXTRAS))
                sys.stderr.write(f"[stealth] loaded {STEALTH_EXTRAS.name}\n")
            except Exception as e:
                sys.stderr.write(f"[stealth] failed to load stealth_extras.js: {e}\n")

        # Storage / cookie mutation telemetry — surfaces every localStorage,
        # sessionStorage, document.cookie write to console.log (the keep loop
        # captures it). Real-time visibility into client-side state changes.
        if STORAGE_HOOK.exists():
            try:
                context.add_init_script(path=str(STORAGE_HOOK))
                sys.stderr.write(f"[capture] loaded {STORAGE_HOOK.name}\n")
            except Exception as e:
                sys.stderr.write(f"[capture] failed to load storage_hook.js: {e}\n")

        if _STEALTH_AVAILABLE:
            try:
                Stealth().apply_stealth_sync(context)  # patches all current + future pages
                sys.stderr.write("[stealth] playwright_stealth applied to context\n")
            except Exception as e:
                sys.stderr.write(f"[stealth] failed to apply: {e}\n")

        # When attached, prefer a real http(s) tab; ignore chrome://, devtools://,
        # and chrome-extension:// pages (omnibox popups, DevTools windows).
        def _is_user_tab(p):
            u = (p.url or "").lower()
            return u.startswith("http://") or u.startswith("https://") or u in ("", "about:blank")
        if context.pages:
            user_tabs = [p for p in context.pages if _is_user_tab(p)]
            page = user_tabs[0] if user_tabs else context.pages[0]
        else:
            page = context.new_page()
        sys.stderr.write(
            f"[connect] active page: {page.url!r}; will track all pages in context\n"
        )

        def on_console(msg):
            try:
                console_f.write(f"[{msg.type}] {msg.text}\n")
                console_f.flush()
            except Exception:
                pass

        def on_pageerror(err):
            try:
                console_f.write(f"[pageerror] {err}\n")
                console_f.flush()
            except Exception:
                pass

        def _safe_filename(url: str, status: int, n: int) -> str:
            safe = url.split("?", 1)[0].replace("https://", "").replace("http://", "").replace("/", "_")[:100]
            return f"{n:05d}-{status}-{safe}.bin"

        def on_request(req):
            try:
                if request_skip_hosts and any(s in req.url for s in request_skip_hosts):
                    return
                # post_data is a cached property on the request object — no CDP
                # round-trip — so always log it. post_data_buffer fetches
                # binary uploads via CDP, only do it on demand.
                post_data = None
                try:
                    post_data = req.post_data
                except Exception:
                    pass
                post_data_b64 = None
                if capture_post_buffers and post_data is None:
                    try:
                        buf = req.post_data_buffer
                        if buf:
                            import base64
                            post_data_b64 = base64.b64encode(buf).decode("ascii")
                    except Exception:
                        pass
                requests_f.write(
                    json.dumps(
                        {
                            "ts": datetime.now(timezone.utc).isoformat(),
                            "kind": "request",
                            "method": req.method,
                            "url": req.url,
                            "resource_type": req.resource_type,
                            "headers": dict(req.headers),
                            "post_data": post_data,
                            "post_data_b64": post_data_b64,
                            "is_navigation": req.is_navigation_request(),
                        }
                    )
                    + "\n"
                )
                requests_f.flush()
            except Exception as e:
                sys.stderr.write(f"[on_request] {e}\n")
                sys.stderr.flush()

        def on_response(resp):
            url = resp.url
            if request_skip_hosts and any(s in url for s in request_skip_hosts):
                return
            try:
                # resp.headers is a cached dict from CDP's Network.responseReceived
                # — no extra round-trip. headers_array() IS another round-trip
                # and Playwright serializes it on the renderer thread, so doing
                # it for every response is the dominant attached-mode cost. We
                # only pay it for responses that pass the same gating as body
                # capture (allowlist + skip-list), since per-cookie Set-Cookie
                # ordering only matters where we'd want the body anyway.
                headers_dict = dict(resp.headers)
                set_cookies = None
                want_precise = capture_bodies
                if want_precise and not capture_all_bodies:
                    try:
                        rtype_pre = resp.request.resource_type
                    except Exception:
                        rtype_pre = ""
                    if rtype_pre in SKIP_BODY_RESOURCE_TYPES:
                        want_precise = False
                    elif resp.status in (0, 204, 304):
                        want_precise = False
                    elif any(skip in url for skip in BODY_SKIP_HOSTS):
                        want_precise = False
                    elif body_host_allowlist and not any(a in url for a in body_host_allowlist):
                        want_precise = False
                if want_precise:
                    try:
                        sc_list = []
                        for h in resp.headers_array():
                            if h["name"].lower() == "set-cookie":
                                sc_list.append(h["value"])
                        set_cookies = sc_list or None
                    except Exception:
                        pass
                else:
                    # Cheap fallback: if Set-Cookie is present in the cached
                    # headers dict, grab it (may collapse multi-cookies into one
                    # newline-joined string).
                    raw_sc = headers_dict.get("set-cookie") or headers_dict.get("Set-Cookie")
                    if raw_sc:
                        set_cookies = [raw_sc]

                # Log response metadata.
                requests_f.write(
                    json.dumps(
                        {
                            "ts": datetime.now(timezone.utc).isoformat(),
                            "kind": "response",
                            "status": resp.status,
                            "url": url,
                            "method": resp.request.method,
                            "headers": headers_dict,
                            "set_cookies": set_cookies,
                        }
                    )
                    + "\n"
                )
                if set_cookies:
                    for sc in set_cookies:
                        requests_f.write(
                            json.dumps(
                                {
                                    "ts": datetime.now(timezone.utc).isoformat(),
                                    "kind": "set_cookie",
                                    "url": url,
                                    "value": sc,
                                }
                            )
                            + "\n"
                        )
                requests_f.flush()
            except Exception as e:
                sys.stderr.write(f"[on_response meta] {url}: {e}\n")
                sys.stderr.flush()

            # Body capture is OFF by default — each call is a synchronous CDP
            # round-trip that blocks the response handler. With many small
            # responses on a page, this is the dominant attached-mode cost.
            # Re-enable per session with --capture-bodies (or fetch on demand
            # via drive.py's evaluate / fetch helpers).
            if not capture_bodies:
                return
            try:
                rtype = resp.request.resource_type
            except Exception:
                rtype = ""
            if not capture_all_bodies:
                if rtype in SKIP_BODY_RESOURCE_TYPES:
                    return
                if resp.status in (0, 204, 304):
                    return
                if any(skip in url for skip in BODY_SKIP_HOSTS):
                    return
                # Allowlist: when set, ONLY hosts/paths matching one of the
                # substrings get a body fetched. Lets you turn body capture on
                # for the specific API host(s) you care about without paying
                # the CDP round-trip on every Pusher/Datadog/bundle response.
                if body_host_allowlist and not any(a in url for a in body_host_allowlist):
                    return
            try:
                body_seq["n"] += 1
                n = body_seq["n"]
                fname = _safe_filename(url, resp.status, n)
                fpath = bodies_dir / fname
                body_bytes = resp.body()
                truncated = False
                if body_bytes is not None and len(body_bytes) > MAX_BODY_BYTES:
                    body_bytes = body_bytes[:MAX_BODY_BYTES]
                    truncated = True
                if body_bytes is not None:
                    fpath.write_bytes(body_bytes)
                requests_f.write(
                    json.dumps(
                        {
                            "ts": datetime.now(timezone.utc).isoformat(),
                            "kind": "body",
                            "status": resp.status,
                            "url": url,
                            "method": resp.request.method,
                            "resource_type": rtype,
                            "path": str(fpath.relative_to(capture_dir)) if body_bytes is not None else None,
                            "size": len(body_bytes) if body_bytes is not None else 0,
                            "truncated": truncated,
                        }
                    )
                    + "\n"
                )
                requests_f.flush()
            except Exception as e:
                # Common: redirects, data: URLs, cross-origin opaque responses
                # — not actionable, just note and move on.
                sys.stderr.write(f"[body-capture] {url}: {type(e).__name__}\n")
                sys.stderr.flush()

        def on_websocket(ws):
            ws_url = ws.url
            if request_skip_hosts and any(s in ws_url for s in request_skip_hosts):
                return
            try:
                requests_f.write(
                    json.dumps(
                        {
                            "ts": datetime.now(timezone.utc).isoformat(),
                            "kind": "ws_open",
                            "url": ws_url,
                        }
                    )
                    + "\n"
                )
                requests_f.flush()
            except Exception:
                pass

            def _frame(direction):
                def _h(payload):
                    try:
                        if isinstance(payload, (bytes, bytearray)):
                            import base64
                            data = base64.b64encode(payload[:MAX_WS_FRAME_BYTES]).decode("ascii")
                            kind = "ws_send_b64" if direction == "send" else "ws_recv_b64"
                            requests_f.write(
                                json.dumps(
                                    {
                                        "ts": datetime.now(timezone.utc).isoformat(),
                                        "kind": kind,
                                        "url": ws_url,
                                        "size": len(payload),
                                        "data": data,
                                        "truncated": len(payload) > MAX_WS_FRAME_BYTES,
                                    }
                                )
                                + "\n"
                            )
                        else:
                            text = str(payload)
                            requests_f.write(
                                json.dumps(
                                    {
                                        "ts": datetime.now(timezone.utc).isoformat(),
                                        "kind": "ws_send" if direction == "send" else "ws_recv",
                                        "url": ws_url,
                                        "size": len(text),
                                        "data": text[:MAX_WS_FRAME_BYTES],
                                        "truncated": len(text) > MAX_WS_FRAME_BYTES,
                                    }
                                )
                                + "\n"
                            )
                        requests_f.flush()
                    except Exception:
                        pass
                return _h

            ws.on("framesent", _frame("send"))
            ws.on("framereceived", _frame("recv"))
            ws.on("close", lambda: requests_f.write(json.dumps({"ts": datetime.now(timezone.utc).isoformat(), "kind": "ws_close", "url": ws_url}) + "\n") or requests_f.flush())

        # CDP sessions per page so we can use Debugger / Profiler. Held in a
        # dict so action handlers can reach them later (coverage_dump etc.).
        cdp_sessions: dict[int, object] = {}

        def attach_cdp(target_page):
            # Debugger.enable + Profiler are explicitly fingerprintable: setting
            # those flags is detectable from JS (see Cloudflare/DataDome/HUMAN
            # patterns that probe for `Function.prototype.toString` proxying,
            # the runtime debug-domain side-effects, and Profiler attachment).
            # They're OFF by default so we look like a normal Chrome to bot
            # checks. Enable per-run with --capture-scripts / --capture-coverage,
            # or live via drive.py: scripts_dump etc.
            if not (capture_scripts or capture_coverage):
                # Still register a session so action handlers can find one,
                # just don't enable any bot-visible CDP domains.
                try:
                    cdp = context.new_cdp_session(target_page)
                    cdp_sessions[id(target_page)] = cdp
                except Exception:
                    pass
                return None

            try:
                cdp = context.new_cdp_session(target_page)
            except Exception as e:
                sys.stderr.write(f"[cdp] attach failed for {target_page.url!r}: {e}\n")
                return None
            try:
                if capture_scripts:
                    cdp.send("Debugger.enable")
                if capture_coverage:
                    cdp.send("Profiler.enable")
                    cdp.send(
                        "Profiler.startPreciseCoverage",
                        {"callCount": True, "detailed": True, "allowTriggeredUpdates": True},
                    )
            except Exception as e:
                sys.stderr.write(f"[cdp] enable failed: {e}\n")

            def on_script_parsed(evt):
                try:
                    sid = evt.get("scriptId")
                    if not sid:
                        return
                    src_resp = cdp.send("Debugger.getScriptSource", {"scriptId": sid})
                    source = src_resp.get("scriptSource", "") or ""
                    if not source:
                        return
                    import hashlib
                    h = hashlib.sha256(source.encode("utf-8", "replace")).hexdigest()[:16]
                    if h in seen_script_hashes:
                        return
                    seen_script_hashes.add(h)
                    truncated = False
                    if len(source) > MAX_SCRIPT_BYTES:
                        source = source[:MAX_SCRIPT_BYTES]
                        truncated = True
                    fpath = scripts_dir / f"{h}.js"
                    fpath.write_text(source, encoding="utf-8", errors="replace")
                    requests_f.write(
                        json.dumps(
                            {
                                "ts": datetime.now(timezone.utc).isoformat(),
                                "kind": "script_parsed",
                                "scriptId": sid,
                                "url": evt.get("url", ""),
                                "hash": h,
                                "path": str(fpath.relative_to(capture_dir)),
                                "size": len(source),
                                "truncated": truncated,
                                "isModule": evt.get("isModule", False),
                                "hasSourceMapURL": bool(evt.get("sourceMapURL")),
                            }
                        )
                        + "\n"
                    )
                    requests_f.flush()
                except Exception as e:
                    # Some scriptIds become invalid as the page reloads; not fatal.
                    pass

            if capture_scripts:
                cdp.on("Debugger.scriptParsed", on_script_parsed)
            cdp_sessions[id(target_page)] = cdp
            return cdp

        def attach_listeners(target_page):
            target_page.on("console", on_console)
            target_page.on("pageerror", on_pageerror)
            target_page.on("request", on_request)
            target_page.on("response", on_response)
            target_page.on("websocket", on_websocket)
            attach_cdp(target_page)

        # Attach to every existing page (when in connect mode, multiple are
        # already open: real tab + omnibox popup + maybe DevTools).
        for p_ in context.pages:
            attach_listeners(p_)

        # New pages opened in the same context (popups, target=_blank, user
        # opening a new tab) get the same listeners.
        context.on("page", attach_listeners)

        # Service workers — separate execution context. Capture their console
        # via the context.serviceworker event; their fetches still appear under
        # the controlling page's request stream.
        def on_service_worker(sw):
            try:
                requests_f.write(
                    json.dumps(
                        {
                            "ts": datetime.now(timezone.utc).isoformat(),
                            "kind": "service_worker",
                            "url": sw.url,
                        }
                    )
                    + "\n"
                )
                requests_f.flush()
            except Exception:
                pass

        try:
            context.on("serviceworker", on_service_worker)
            for sw in (getattr(context, "service_workers", []) or []):
                on_service_worker(sw)
        except Exception:
            pass

        if no_goto or url in ("", "-", "about:blank"):
            sys.stderr.write(f"[keep] no-goto mode (url={url!r}); attached at {page.url!r}\n")
        else:
            page.goto(url, wait_until="domcontentloaded", timeout=60_000)

        # Post-load humanization: a couple of organic mouse moves + a short
        # scroll give bot detectors real input events to observe. Cheap and
        # helps pass Cloudflare's browser-interaction heuristics. Skip if
        # we didn't navigate (user is driving).
        if not (no_goto or url in ("", "-", "about:blank")):
            try:
                _random.seed()
                for _ in range(_random.randint(3, 6)):
                    page.mouse.move(
                        _random.randint(100, 1300),
                        _random.randint(80, 800),
                        steps=_random.randint(8, 20),
                    )
                    time.sleep(_random.uniform(0.05, 0.25))
                # Smooth-scroll down a bit and back up.
                for _ in range(6):
                    page.mouse.wheel(0, _random.randint(30, 90))
                    time.sleep(_random.uniform(0.05, 0.15))
                time.sleep(_random.uniform(0.4, 1.1))
                for _ in range(4):
                    page.mouse.wheel(0, -_random.randint(20, 60))
                    time.sleep(_random.uniform(0.05, 0.15))
            except Exception as e:
                sys.stderr.write(f"[human] warmup skipped: {e}\n")

        result = None
        if eval_expr:
            result = page.evaluate(eval_expr)
            sys.stdout.write(
                json.dumps(result, indent=2, default=str) if not isinstance(result, str) else result
            )
            sys.stdout.write("\n")

        if shell:
            import code

            banner = (
                f"Interactive shell. `page`, `context`, and `run_js(expr)` are bound.\n"
                f"Capture dir: {capture_dir}\n"
            )

            def run_js(expr):
                return page.evaluate(expr)

            code.interact(banner=banner, local={"page": page, "context": context, "run_js": run_js})

        if keep:
            import signal

            stop = {"v": False}

            def _stop(signum, frame):
                stop["v"] = True

            signal.signal(signal.SIGTERM, _stop)
            signal.signal(signal.SIGINT, _stop)

            # Publish runtime context so action handlers can reach CDP sessions.
            _RUNTIME["cdp_sessions"] = cdp_sessions
            _RUNTIME["capture_dir"] = capture_dir

            cmd_in = capture_dir / "cmd.in.jsonl"
            cmd_out = capture_dir / "cmd.out.jsonl"
            cmd_in.touch()
            cmd_out.touch()
            cmd_pos = cmd_in.stat().st_size  # only consume commands written AFTER startup

            # Track which page is "active" — defaults to first, can be switched
            # via focus_page command.
            active = {"page": page}

            sys.stderr.write(
                f"[keep] browser alive — capture dir: {capture_dir}\n"
                f"[keep] command channel: {cmd_in} -> {cmd_out}\n"
                f"[keep] use scripts/drive.py to send commands without restarting\n"
            )
            sys.stderr.flush()

            while not stop["v"]:
                try:
                    time.sleep(0.1)

                    if not context.pages:
                        sys.stderr.write("[keep] all pages closed, exiting\n")
                        break

                    # Refresh active page when:
                    #  - it was closed
                    #  - it's still a chrome:// internal page but a user web
                    #    tab now exists (e.g. user navigated their tab)
                    cur = active["page"]
                    cur_url = (cur.url or "").lower() if not cur.is_closed() else ""
                    if cur.is_closed() or cur_url.startswith(("chrome://", "devtools://", "chrome-extension://")):
                        web_tabs = [
                            p for p in context.pages
                            if not p.is_closed()
                            and (p.url or "").lower().startswith(("http://", "https://"))
                        ]
                        if web_tabs:
                            active["page"] = web_tabs[0]
                        elif not cur.is_closed():
                            pass  # leave as-is until a web tab appears
                        elif context.pages:
                            active["page"] = context.pages[0]

                    # Pages that opened after our initial loop (user opened a
                    # new tab / popup) won't have a CDP session yet — attach.
                    for pg in context.pages:
                        if not pg.is_closed() and id(pg) not in cdp_sessions:
                            attach_cdp(pg)

                    sz = cmd_in.stat().st_size
                    if sz > cmd_pos:
                        with cmd_in.open() as f:
                            f.seek(cmd_pos)
                            new_data = f.read()
                            cmd_pos = f.tell()
                        for line in new_data.splitlines():
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                cmd = json.loads(line)
                            except Exception as e:
                                _write_result(cmd_out, {"id": None, "ok": False, "error": f"bad json: {e}"})
                                continue
                            cid = cmd.get("id")
                            action = cmd.get("action", "")
                            args = cmd.get("args", {}) or {}
                            fn = ACTIONS.get(action)
                            if not fn:
                                _write_result(cmd_out, {"id": cid, "ok": False, "error": f"unknown action: {action}"})
                                continue
                            try:
                                if action == "focus_page":
                                    res = fn(active["page"], args)
                                    if isinstance(res, dict) and "index" in res and "url" in res:
                                        active["page"] = context.pages[res["index"]]
                                    _write_result(cmd_out, {"id": cid, "ok": True, "result": res})
                                else:
                                    res = fn(active["page"], args)
                                    _write_result(cmd_out, {"id": cid, "ok": True, "result": res})
                            except Exception as e:
                                _write_result(cmd_out, {"id": cid, "ok": False, "error": f"{type(e).__name__}: {e}"})
                except KeyboardInterrupt:
                    break
                except Exception as e:
                    sys.stderr.write(f"[keep] tick error: {e}\n")
                    sys.stderr.flush()

            sys.stderr.write("[keep] shutting down\n")

        meta_path.write_text(
            json.dumps(
                {
                    "slug": slug,
                    "url": url,
                    "started_at": ts,
                    "headed": headed,
                    "eval_result_preview": (
                        (result[:500] + "…") if isinstance(result, str) and len(result) > 500 else result
                    ),
                },
                indent=2,
                default=str,
            )
        )

        if attached_browser is not None:
            # DO NOT call attached_browser.close() — for connect_over_cdp
            # browsers that sends Browser.close to chrome and kills the remote
            # window. We want chrome to keep running so the next browser.py
            # invocation can re-attach. Just let the playwright client exit;
            # the OS tears down the WS on process exit and chrome stays up.
            pass
        else:
            context.close()

    console_f.close()
    requests_f.close()

    sys.stderr.write(f"\nCapture: {capture_dir}\n")


def _write_result(out_path: Path, obj: dict) -> None:
    try:
        with out_path.open("a") as f:
            f.write(json.dumps(obj, default=str) + "\n")
            f.flush()
    except Exception as e:
        sys.stderr.write(f"[keep] failed to write result: {e}\n")
        sys.stderr.flush()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("url")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--eval", dest="eval_expr", default=None, help="JS expression to evaluate after load")
    ap.add_argument("--shell", action="store_true", help="Drop into an interactive Python shell with page bound")
    ap.add_argument("--keep", action="store_true", help="Keep browser/context alive after load until SIGTERM/SIGINT; exposes JSONL command channel")
    ap.add_argument("--connect-cdp", default=None, help="Instead of launching, connect to a running browser at this CDP URL (e.g. http://127.0.0.1:9222 from scripts/win_chrome.py)")
    ap.add_argument("--no-goto", action="store_true", help="Skip the initial page.goto and humanize warmup; just attach and start the keep loop. Use 'about:blank' or '-' as the URL placeholder.")
    ap.add_argument("--capture-scripts", action="store_true", help="Enable CDP Debugger.scriptParsed to mirror every parsed JS to disk. WARNING: bot-detection (Cloudflare/HUMAN/DataDome) can detect Debugger.enable; only turn on once past auth gates.")
    ap.add_argument("--capture-coverage", action="store_true", help="Enable CDP Profiler precise coverage. Same caveat as --capture-scripts.")
    ap.add_argument("--capture-bodies", action="store_true", help="Fetch response bodies for non-asset, non-noise responses. Each body is a CDP round-trip that blocks the response handler — meaningful page-load slowdown.")
    ap.add_argument("--capture-post-buffers", action="store_true", help="Fetch binary POST upload buffers via CDP (in addition to the cached post_data string). Adds a CDP round-trip per request that has a body.")
    args = ap.parse_args()
    run(args.slug, args.url, args.headed, args.eval_expr, args.shell, args.keep, args.connect_cdp, args.no_goto, args.capture_scripts, args.capture_coverage, args.capture_bodies, args.capture_post_buffers)


if __name__ == "__main__":
    main()
