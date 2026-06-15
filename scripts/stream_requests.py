"""Filter + format streaming requests.jsonl lines for live monitoring.

Reads JSONL from stdin (one request or response event per line) and prints
a compact one-line summary for the events worth surfacing in chat:
- All XHR / fetch / WebSocket / EventSource / document requests
- Any response with HTTP status >= 400

Static asset noise (image, stylesheet, font, media) is dropped.
"""
from __future__ import annotations

import json
import sys


INTERESTING_RESOURCE_TYPES = {"xhr", "fetch", "websocket", "eventsource", "document"}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue

        if event.get("kind") == "response":
            status = event.get("status", 0)
            if status >= 400:
                url = event.get("url", "")[:220]
                print(f"<- {status} {url}", flush=True)
            continue

        rtype = event.get("resource_type", "")
        if rtype not in INTERESTING_RESOURCE_TYPES:
            continue
        method = event.get("method", "")
        url = event.get("url", "")[:220]
        print(f"-> {rtype:11s} {method:6s} {url}", flush=True)


if __name__ == "__main__":
    main()
