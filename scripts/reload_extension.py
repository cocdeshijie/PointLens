#!/usr/bin/env python3
"""Build (optional), stage, and (hot-)reload the award-viewer extension in a
running win_chrome instance via CDP.

The repo lives on WSL ext4 (/home/...), which chrome.exe (a Windows process)
cannot read — so the built extension is copied under /mnt/c/... before Chrome
can load it. And Chrome 137+ ignores the --load-extension *flag*, so we load via
the CDP Extensions.loadUnpacked command. Re-running it on the same path picks up
a fresh build.

Usage:
    cd award-viewer && npm run build          # produce build/chrome-mv3-prod
    python3 scripts/reload_extension.py <cdp-url>
    # e.g. python3 scripts/reload_extension.py http://172.19.176.1:9322
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BUILD = REPO / "award-viewer" / "build" / "chrome-mv3-prod"
STAGE_MNT = Path("/mnt/c/Users/28655/AppData/Local/AwardViewer/award-viewer-ext")


def mnt_to_windows(p: Path) -> str:
    parts = p.parts
    if len(parts) >= 3 and parts[1] == "mnt" and len(parts[2]) == 1:
        return parts[2].upper() + ":\\" + "\\".join(parts[3:])
    raise RuntimeError(f"not a /mnt/<drive> path: {p}")


def stage() -> str:
    if not (BUILD / "manifest.json").is_file():
        sys.exit(f"no build at {BUILD} — run `cd award-viewer && npm run build` first")
    STAGE_MNT.mkdir(parents=True, exist_ok=True)
    subprocess.run(["rsync", "-a", "--delete", str(BUILD) + "/", str(STAGE_MNT) + "/"], check=True)
    win = mnt_to_windows(STAGE_MNT)
    print(f"[reload] staged {BUILD} -> {win}")
    return win


async def load_unpacked(ws_url: str, win_path: str) -> str:
    import websockets

    async with websockets.connect(ws_url, max_size=None) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Extensions.loadUnpacked",
                                  "params": {"path": win_path}}))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("id") == 1:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg["result"]["id"]


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: reload_extension.py <cdp-url>  (e.g. http://172.19.176.1:9322)")
    cdp = sys.argv[1].rstrip("/")
    win_path = stage()
    ver = json.load(urllib.request.urlopen(cdp + "/json/version", timeout=5))
    eid = asyncio.run(load_unpacked(ver["webSocketDebuggerUrl"], win_path))
    print(f"[reload] (re)loaded extension id={eid} — close & reopen the popup / refresh the page to see changes.")


if __name__ == "__main__":
    main()
