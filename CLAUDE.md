# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This repo holds **two coexisting things**:

1. **`pointlens/`** — the product: a **Plasmo (TypeScript/React) MV3 browser
   extension** that surfaces hotel award availability for Hilton, IHG, and
   Marriott. Its own conventions live in `agents.md` (per-site folders under
   `pointlens/hotels/<site>/`, injected fetch-hooks, site-specific popups).
   `test/` is a Plasmo sandbox. This is the thing that ships.
2. **The exploration harness** (everything below — `scripts/`, `.claude/agents/`,
   `findings/`, `sessions/`) — a **site-exploration lab** used to
   reverse-engineer those hotel sites: understand architecture, map APIs, trace
   auth flows, inspect rendered DOM, reverse-engineer client JS, capture and
   replay traffic. Findings here feed the extension's per-hotel handlers.

The user owns all auth used here. There are no rate-limit or politeness
constraints imposed by this repo. (Be sensible if a target is public infra, but
no artificial throttle.) This is **not** scraping-at-scale or automated
credential attack — it's research and comprehension in service of the extension.

The rest of this file documents the **exploration harness**. For extension work,
follow `agents.md`.

## Stack — Playwright + Python

Playwright was chosen because it gives the deepest single-tool visibility: rendered DOM, full network (including XHR/fetch/WebSocket), in-page JS execution via `page.evaluate()`, CDP access, HAR capture, and persistent contexts for auth reuse. Fall back to `curl` / `httpx` for headless HTTP-only work.

One-time setup (run when missing):
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
```

Every subsequent session:
```bash
source .venv/bin/activate
```

Shared harness: `scripts/browser.py` — opens a persistent Chromium context per site (cookies survive across runs, so the user's logged-in state persists), captures HAR + console + requests automatically to `sessions/<site>/<timestamp>/`. Use this instead of rolling ad-hoc Playwright boilerplate each time.

Run an interactive probe:
```bash
python3 scripts/browser.py <site-slug> <url>      # headless, HAR to sessions/
python3 scripts/browser.py <site-slug> <url> --headed
```

Evaluate JS in-page from a script: see `scripts/browser.py:run_js` helper.

### Choosing the right capture path — Playwright vs raw CDP

We have two daemons that write the same `sessions/<slug>/<ts>/requests.jsonl` schema:

| | `scripts/browser.py` (Playwright) | `scripts/cdp_capture.py` (raw CDP) |
|---|---|---|
| Routes events through | Chrome → CDP WS → Playwright Node driver → Python pipe → handler | Chrome → CDP WS → Python (one hop) |
| Per-event overhead | Meaningful — every request/response goes through the JS bridge | Negligible — pure asyncio |
| Stalls page on `--capture-bodies` | **Yes** — `resp.body()` is sync inside the event handler; renderer waits on Python | **No** — body fetch is `asyncio.create_task`, capped at 6 concurrent, doesn't block the WS reader |
| Drives the page | Yes (goto / fill / click via Playwright API + `scripts/drive.py`) | No — passive listener only |
| HAR file | Only when Playwright owns the context (i.e. NOT in `--connect-cdp` mode) | Never — schema lives entirely in `requests.jsonl` |

Rule of thumb: **`browser.py` if you need to drive the page**, **`cdp_capture.py` if you only need to listen**. Telemetry-heavy SPAs (Datadog RUM/Replay, Sentry, GA4 Measurement Protocol) flood the per-request handler — Playwright can stall a page that loads fine under raw CDP. We saw this on paywithextend.com: the page wouldn't render with `browser.py --capture-bodies`; the same load through `cdp_capture.py --capture-bodies` worked instantly with bodies still captured.

### Using the user's real Windows Chrome from WSL

Default mode launches a Linux Chrome inside WSL — convenient, headed via WSLg, but the network stack and fingerprint look like WSL, not the user. For sites where that matters (ASN, GPU, canvas/audio fingerprint), drive the user's real Windows Chrome over CDP:

```bash
# 1. Spawn Windows Chrome with a dedicated user-data-dir + remote-debug port,
#    plus a Node TCP forwarder so we can reach it from WSL.
python3 scripts/win_chrome.py <slug> --initial-url <url>
# Prints e.g. http://172.19.176.1:9322 — copy that URL.

# 2. Attach the lightweight raw-CDP listener:
python3 scripts/cdp_capture.py <slug> --connect <cdp-url> \
    --enable-runtime --enable-page --capture-bodies
# (drop --capture-bodies if disk is tight; bodies still write incrementally
#  to sessions/<slug>/<ts>/bodies/ and are referenced by `kind:"body"` rows)

# 3. (Optional) ALSO attach Playwright on top of the same browser to drive it:
python3 scripts/browser.py <slug> - --connect-cdp <cdp-url> --no-goto --keep
# Two listeners is fine — they don't fight, they each just record their own
# session dir. Use Playwright's command channel via scripts/drive.py.
```

Persistent profile lives at `C:\Users\<user>\AppData\Local\ProxyExplore\<slug>` — auth survives across runs. Delete the directory to reset.

### Tuning capture volume

Both daemons honor these env vars to cut down the firehose on telemetry-heavy pages:

- `DDX_REQUEST_SKIP_HOSTS=foo.com,bar.com,...` — drop matching URLs from the request/response/websocket logs entirely. Useful for Datadog ingest, GA4, Sentry, ad pixels. (`browser.py` only.)
- `DDX_BODY_HOST_ALLOWLIST=foo.com,bar.com,...` — only fetch response bodies when the URL contains one of these substrings. Use this with `--capture-bodies` to scope body capture to API hosts you actually care about. (Both daemons.)
- `DDX_CAPTURE_ALL_BODIES=1` — override the default body skip list (images/fonts/media/stylesheets get bodies too). (Both daemons.)

### Known gotcha — Chrome's debug-port loopback family flips between releases

Chrome 147 has shipped builds that bind `--remote-debugging-port` to `::1` only AND builds that bind `127.0.0.1` only (147.0.7727.116 observed 2026-04 = v4 only). And Windows has a wslrelay phantom listener on `127.0.0.1:9222` paired with WSL2's localhost auto-forwarding — that listener accepts but routes back into WSL, never to Chrome. So we can't hardcode either family.

The Node forwarder in `scripts/win_chrome.py` probes `::1` first (the wslrelay phantom can never sit there) and falls back to `127.0.0.1` on `ECONNREFUSED`, caching the winning family for subsequent connections. If you see `[probe v6] ECONNREFUSED` then `[probe v4] connected` in the forwarder logs, that's the v4 fallback firing — working as intended. **Don't rip the v4 fallback out** (the next Chrome release may flip back to v6-only) and **don't rip the v6-first probe out** (a v4-first probe risks hitting the wslrelay phantom on machines where Chrome bound v6).

## Workspace layout

```
findings/<site-slug>/        # curated knowledge per target (archivist owns)
  README.md                  # overview + entry points
  recon.md                   # passive intel, tech stack, fingerprinting
  network.md                 # endpoints, auth flow, request/response shapes
  dom.md                     # frontend framework, important selectors, routing
  js.md                      # bundle findings, deobfuscated snippets, globals
  notes.md                   # freeform working notes, open questions
  artifacts/                 # raw captures: HAR, response bodies, screenshots
findings/_meta/
  retro-log.md               # retrospective agent's running changelog
sessions/<site-slug>/<ts>/   # raw ephemeral per-run captures
scripts/                     # reusable harnesses, not per-site one-offs
.claude/agents/              # the agent team
```

Slug convention: lowercase, hyphenated, derived from the registrable domain (e.g. `example.com` → `example-com`, `app.foo.io` → `foo-io` unless subdomains matter enough to split).

## Agent team — who handles what

The main Claude is the **orchestrator**: plans the dig, decides what needs probing next, delegates to sub-agents, synthesizes findings. Do not do deep work in the main thread when a specialist fits — delegate, because (a) specialists have focused instructions that compound over time and (b) it keeps the main context clean for cross-cutting reasoning.

| Agent | Use for |
|---|---|
| `recon` | First pass on a new site. Passive intel: robots.txt, sitemaps, security.txt, response headers, TLS/cert, DNS, tech fingerprinting from HTML/headers. Never logs in. |
| `network-sleuth` | HTTP traffic analysis, API endpoint discovery, auth flow tracing, request replay and variation. Consumes HAR captures and raw responses. |
| `dom-scout` | Rendered DOM inspection, framework detection (React/Vue/Svelte/Next/Nuxt), routing scheme, important selectors, hydration data (`__NEXT_DATA__`, Apollo cache, etc.). |
| `js-reverser` | Client bundle analysis: beautify, search for API paths and feature flags, identify build tool, dump runtime globals via `page.evaluate`, deobfuscate interesting functions. |
| `archivist` | Owns `findings/<site>/`. After any non-trivial finding, call the archivist to fold it into the right file. The archivist also creates the initial scaffold for a new target. |
| `retrospective` | Meta-improvement. Reviews the session and edits agent files, CLAUDE.md, and scripts to lock in lessons. Has authority to change anything in `.claude/` and this file. |

### Enforced rules (do not skip — do not wait for the user to ask)

1. **New target → archivist first.** When the user names a new site to dig into, immediately invoke `archivist` to create `findings/<slug>/` with the standard files. Only then start probing.
2. **Findings are written as they appear, not at the end.** Any time a sub-agent returns a concrete finding (an endpoint, an auth mechanism, a framework, an obfuscation pattern), either the returning agent writes it into `findings/<slug>/` itself or you immediately hand it to `archivist`. Do not accumulate findings only in chat.
3. **Retrospective at session end and at milestones.** When the user says the session is wrapping up, when a major phase completes, or when you notice you've repeated a correction twice, invoke `retrospective`. It reads recent activity and edits CLAUDE.md / agent files / scripts so the lesson sticks for next session.
4. **Self-improvement is continuous, not just in retro.** If mid-session you notice an agent's instructions are missing something useful (a command, a gotcha, a better default), edit that agent file directly. Don't wait.
5. **Never strip the enforcement section of CLAUDE.md or an agent file during edits.** Retrospective and self-edits may refine wording but must preserve the enforcement contract.
6. **Auth state is the user's.** Persistent contexts under `sessions/<slug>/state/` contain real cookies. Do not commit them, do not share them in agent prompts to other agents beyond what's needed, and do not send them to WebFetch or external services.
7. **Frontend state = Jotai, always.** If a frontend ever lands in this repo, all client-state goes through Jotai atoms — no Redux, Zustand, React Context, SWR, React Query, etc. Local-only UI state (e.g., a controlled input that nothing else reads) can use `useState`; the moment another component cares, hoist to an atom. For server-state caching, use `jotai-tanstack-query` (atom wrapper) — never bring in TanStack Query directly.
8. **Per-row pending state must be local, not from a shared mutation atom.** A global `atomWithMutation` is a single shared object — every component that subscribes sees the same `isPending`. Rendering it inside a list (session-row, batch-row, etc.) with `disabled={mut.isPending}` makes clicking ONE row light up ALL rows. Fix: keep the global mutation atom (the API caller is identity-agnostic), but track per-row visual pending with `useState` set true before `mutateAsync` and false in `finally`. Only widen to a shared atom if there's truly one logical instance (a wizard, a single dialog).

### Delegation shape

When invoking a sub-agent, give it:
- The **target slug** and the specific **question** you need answered
- Pointers to relevant existing files (`findings/<slug>/network.md`, `sessions/<slug>/<ts>/network.har`)
- What counts as "done" — a concrete artifact or answer, not "investigate X"

Don't delegate understanding. If the sub-agent returns findings, read and integrate them yourself before the next step — do not write "based on the agent's findings, do Y" as a follow-up delegation.

## Common commands

```bash
# First-time / after dependency change
source .venv/bin/activate && pip install -r requirements.txt && playwright install chromium

# Run the harness on a target
source .venv/bin/activate && python3 scripts/browser.py <slug> <url>

# Quick HTTP poke without browser
curl -sS -D - -o /tmp/body.html <url> | head -40

# Inspect a HAR
python3 -c "import json,sys; h=json.load(open(sys.argv[1])); [print(e['request']['method'], e['request']['url']) for e in h['log']['entries']]" sessions/<slug>/<ts>/network.har
```

## Notes for your future self

- Use the Explore agent (built-in) only for codebase-internal searches. For **target-site** exploration, always use the specialized agents defined in `.claude/agents/` — they know the conventions of this repo.
- The `findings/` tree is the durable product. `sessions/` is raw and disposable — anything worth keeping must be promoted into `findings/`.
- If you catch yourself doing the same multi-step Playwright dance twice, add a helper to `scripts/browser.py` and update this file.
