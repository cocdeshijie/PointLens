"""Drive a running scripts/browser.py --keep session via its JSONL command channel.

The keep loop in browser.py polls sessions/<slug>/<latest>/cmd.in.jsonl for
JSON commands and writes results to cmd.out.jsonl. This module wraps that
file-based RPC in a small Driver class so other scripts (logins, scripted
exploration) can drive the live page without touching Playwright.

Usage as a library:

    from drive import Driver
    drv = Driver("doordash-com")
    drv.goto("https://www.doordash.com/")
    drv.fill('input[type="email"]', "x@y.com")
    drv.click('button[type="submit"]')
    print(drv.url())

Usage as a CLI (one-shot command, prints JSON result):

    python3 scripts/drive.py doordash-com goto --url https://www.doordash.com/
    python3 scripts/drive.py doordash-com evaluate --expr 'document.title'
    python3 scripts/drive.py doordash-com cookies
    python3 scripts/drive.py doordash-com query_inputs
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SESSIONS = ROOT / "sessions"


class DriverError(RuntimeError):
    pass


class Driver:
    def __init__(self, slug: str, capture_dir: Path | None = None, default_timeout: float = 30.0):
        self.slug = slug
        # Allow DDX_SESSIONS override (matches browser.py).
        import os as _os
        sessions_root = Path(_os.environ.get("DDX_SESSIONS", "")) if _os.environ.get("DDX_SESSIONS") else SESSIONS
        if capture_dir is None:
            site_dir = sessions_root / slug
            latest = site_dir / "latest"
            if latest.exists():
                capture_dir = latest.resolve()
            else:
                # latest.txt fallback for Windows-side keep loops where symlink
                # creation isn't allowed.
                fallback = site_dir / "latest.txt"
                if fallback.exists():
                    ts = fallback.read_text().strip()
                    capture_dir = site_dir / ts
                else:
                    raise DriverError(
                        f"no latest pointer at {latest} or {fallback} — is the keep browser running?"
                    )
        self.capture_dir = capture_dir
        self.cmd_in = capture_dir / "cmd.in.jsonl"
        self.cmd_out = capture_dir / "cmd.out.jsonl"
        if not self.cmd_in.exists():
            raise DriverError(
                f"command channel not found at {self.cmd_in} — keep browser running?"
            )
        self.default_timeout = default_timeout
        # Track read position in cmd_out so each call only sees new results.
        self._out_pos = self.cmd_out.stat().st_size if self.cmd_out.exists() else 0

    def send(self, action: str, timeout: float | None = None, **args):
        cid = secrets.token_hex(8)
        cmd = {"id": cid, "action": action, "args": args}
        with self.cmd_in.open("a") as f:
            f.write(json.dumps(cmd) + "\n")
            f.flush()
        deadline = time.time() + (timeout or self.default_timeout)
        while time.time() < deadline:
            sz = self.cmd_out.stat().st_size if self.cmd_out.exists() else 0
            if sz > self._out_pos:
                with self.cmd_out.open() as f:
                    f.seek(self._out_pos)
                    chunk = f.read()
                    self._out_pos = f.tell()
                for line in chunk.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    if r.get("id") == cid:
                        if r.get("ok"):
                            return r.get("result")
                        raise DriverError(f"{action} failed: {r.get('error')}")
            time.sleep(0.05)
        raise DriverError(f"timeout waiting for {action} (id={cid})")

    # --- shorthands for common actions -------------------------------------

    def goto(self, url: str, **kw):
        return self.send("goto", url=url, **kw)

    def url(self):
        return self.send("url", timeout=5)

    def title(self):
        return self.send("title", timeout=5)

    def evaluate(self, expr: str, timeout: float = 30):
        return self.send("evaluate", expr=expr, timeout=timeout)

    def fill(self, selector: str, value: str, **kw):
        return self.send("fill", selector=selector, value=value, **kw)

    def click(self, selector: str, **kw):
        return self.send("click", selector=selector, **kw)

    def press(self, key: str):
        return self.send("press", key=key)

    def type(self, text: str, delay: int = 0):
        return self.send("type", text=text, delay=delay)

    def wait_for_selector(self, selector: str, timeout: int = 10_000, state: str = "visible"):
        return self.send("wait_for_selector", selector=selector, timeout=timeout, state=state, timeout_=timeout / 1000 + 5)

    def wait_for_url(self, url_pattern: str, timeout: int = 15_000):
        return self.send("wait_for_url", url=url_pattern, timeout=timeout)

    def wait_for_load_state(self, state: str = "networkidle", timeout: int = 15_000):
        return self.send("wait_for_load_state", state=state, timeout=timeout)

    def query_inputs(self, selector: str | None = None):
        return self.send("query_inputs", selector=selector)

    def screenshot(self, path: str, full_page: bool = False):
        return self.send("screenshot", path=path, full_page=full_page)

    def cookies(self):
        return self.send("cookies")

    def storage(self):
        return self.send("storage")

    def pages(self):
        return self.send("pages")

    def focus_page(self, index: int):
        return self.send("focus_page", index=index)

    def new_page(self, url: str | None = None):
        return self.send("new_page", url=url)

    # human-like helpers
    def human_click(self, selector: str, timeout: int = 8000):
        return self.send("human_click", selector=selector, timeout=timeout, timeout_=20)

    def human_type(self, text: str, selector: str | None = None,
                   delay_ms: int = 90, jitter_ms: int = 80, timeout_total: float = 60):
        # Estimate plenty of time: per-char up to (delay + jitter) ms + setup overhead.
        est = max(timeout_total, len(text) * (delay_ms + jitter_ms) / 1000 + 10)
        return self.send("human_type", selector=selector, text=text,
                         delay_ms=delay_ms, jitter_ms=jitter_ms, timeout=est)

    def mouse_move(self, x: int | None = None, y: int | None = None,
                   jitter: bool = False, count: int = 6, steps: int = 10):
        if jitter:
            return self.send("mouse_move", jitter=True, count=count, timeout=30)
        return self.send("mouse_move", x=x, y=y, steps=steps)

    def scroll(self, dy: int = 400):
        return self.send("scroll", dy=dy, timeout=20)

    def pause(self, seconds: float = 1.0):
        return self.send("pause", seconds=seconds, timeout=seconds + 5)

    def inner_text(self, selector: str):
        return self.send("inner_text", selector=selector, timeout=5)

    def dump_text(self, max_lines: int = 60):
        return self.send("dump_text", max_lines=max_lines, timeout=5)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("action")
    # Generic key=value pairs for ad-hoc args
    ap.add_argument("--url")
    ap.add_argument("--expr")
    ap.add_argument("--selector")
    ap.add_argument("--value")
    ap.add_argument("--key")
    ap.add_argument("--text")
    ap.add_argument("--path")
    ap.add_argument("--state")
    ap.add_argument("--index", type=int)
    ap.add_argument("--full-page", action="store_true")
    ap.add_argument("--timeout", type=float, default=30.0)
    args = ap.parse_args()

    drv = Driver(args.slug, default_timeout=args.timeout)
    payload: dict = {}
    for k in ("url", "expr", "selector", "value", "key", "text", "path", "state", "index"):
        v = getattr(args, k)
        if v is not None:
            payload[k] = v
    if args.full_page:
        payload["full_page"] = True

    result = drv.send(args.action, timeout=args.timeout, **payload)
    sys.stdout.write(json.dumps(result, indent=2, default=str) + "\n")


if __name__ == "__main__":
    main()
