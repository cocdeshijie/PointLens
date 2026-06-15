"""Launch the user's Windows Chrome from WSL with a dedicated debug-port profile.

Why: real Windows Chrome on the Windows network stack looks like the actual
user (correct ASN, correct GPU/canvas/audio, real Chrome.app/runtime, etc.) —
much harder for Cloudflare/HUMAN/DataDome to fingerprint than anything WSL2
can produce. We use WSL interop to invoke chrome.exe directly; chrome runs as
a Windows process and we reach its CDP via WSL2's localhost forwarding.

Usage:
    python3 scripts/win_chrome.py <slug> [--port 9222] [--initial-url URL]

Prints the CDP endpoint URL to stdout once the port is responsive, then exits
(chrome.exe keeps running on the Windows side until killed). Pair with:
    python3 scripts/browser.py <slug> <url> --connect-cdp http://127.0.0.1:<port> --keep
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

CHROME_EXE = Path("/mnt/c/Program Files/Google/Chrome/Application/chrome.exe")


def detect_windows_host_ip() -> str:
    """The Windows host as seen from WSL2 = the default-gateway IP on eth0.
    WSL2's localhost forwarding only auto-bridges a few hard-coded ports
    (notably 9222 — and even there wslrelay returns canned responses when
    Chrome binds IPv6 only). For arbitrary ports we bind Chrome to 0.0.0.0
    on the Windows side and connect from WSL via this gateway IP."""
    out = subprocess.check_output(["ip", "route"], text=True)
    for line in out.splitlines():
        if line.startswith("default "):
            parts = line.split()
            return parts[parts.index("via") + 1]
    raise RuntimeError("could not detect Windows host IP")


def detect_windows_username() -> str:
    """Read the Windows USERNAME via cmd.exe — not the WSL $USER."""
    out = subprocess.check_output(
        ["cmd.exe", "/c", "echo %USERNAME%"], stderr=subprocess.DEVNULL
    ).decode("utf-8", "replace").strip().splitlines()[-1].strip()
    return out


# Files/dirs we skip when cloning a Chrome User Data dir. Caches alone can be
# many GB and contribute zero fingerprint value; bumping them out makes the
# clone seconds-fast and small enough to live under AwardViewer.
CLONE_EXCLUDE_DIRS = [
    "Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache",
    "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache",
    "Service Worker", "Subresource Filter", "Crashpad",
    "optimization_guide_model_store", "optimization_guide_hint_cache_store",
    "Safe Browsing", "PnaclTranslationCache", "component_crx_cache",
    "Snapshots",
]


def clone_real_profile(src_win: str, dst_win: str) -> None:
    """Robocopy a Chrome User Data dir to a scratch location, skipping caches.
    Robocopy tolerates files locked by a running Chrome (it just skips them
    with a warning) and uses parallel I/O — much faster than Copy-Item."""
    sys.stderr.write(f"[clone] {src_win}  ->  {dst_win}\n")
    cmd = [
        "robocopy.exe", src_win, dst_win,
        "/E",          # subdirs incl. empty
        "/R:1",        # 1 retry on failure (locked file)
        "/W:1",        # 1s wait between retries
        "/MT:8",       # multi-threaded
        "/NFL", "/NDL", "/NJH", "/NJS",  # quiet output
    ]
    for d in CLONE_EXCLUDE_DIRS:
        cmd += ["/XD", d]
    # robocopy exit codes are bitmasks:
    #   1=files copied, 2=extra files, 4=mismatched, 8=some files failed, 16=fatal.
    # When the source Chrome is running, locked files (Cookies, Sessions,
    # Safe Browsing Cookies) always fail with code 8. Combined with 1 we get
    # rc=9: "partial copy succeeded" — exactly the desired behavior.
    # Treat anything < 16 as success and warn if the failure bit was set.
    rc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
    if rc >= 16:
        raise RuntimeError(f"robocopy fatal exit code {rc}")
    if rc & 8:
        sys.stderr.write(
            f"[clone] partial copy (rc={rc}); locked files (Cookies/Sessions) skipped — "
            "scratch browser will need fresh login for affected sites.\n"
        )
    else:
        sys.stderr.write(f"[clone] done (rc={rc})\n")


def windows_path_for(linux_dir: Path) -> str:
    """Best-effort: convert /mnt/c/... → C:\\... since chrome.exe wants Windows paths."""
    parts = linux_dir.parts
    if len(parts) >= 3 and parts[1] == "mnt" and len(parts[2]) == 1:
        drive = parts[2].upper() + ":"
        return drive + "\\" + "\\".join(parts[3:])
    raise RuntimeError(f"not a /mnt/<drive> path: {linux_dir}")


def wait_for_port(host: str, port: int, timeout: float = 30.0) -> str:
    """Poll http://<host>:<port>/json/version. Returns the response body when
    Chrome's standard CDP discovery is alive. We require the body to start with
    '{' and contain 'Browser' — anything else (e.g. wslrelay's 'Running' stub)
    is rejected and we keep waiting."""
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://{host}:{port}/json/version", timeout=2) as r:
                data = r.read().decode("utf-8", "replace")
                if data.lstrip().startswith("{") and '"Browser"' in data:
                    return data
                last_err = f"got non-JSON discovery: {data[:80]!r}"
        except Exception as e:
            last_err = e
        time.sleep(0.4)
    raise TimeoutError(f"chrome CDP at {host}:{port} not ready in {timeout}s: {last_err}")


def cdp_load_unpacked(ws_url: str, ext_win_path: str) -> str:
    """Load an unpacked extension via the CDP Extensions.loadUnpacked command
    over the browser-level WebSocket (Chrome 137+ ignores the --load-extension
    flag). Returns the assigned extension id."""
    import asyncio
    import websockets

    async def _run() -> str:
        async with websockets.connect(ws_url, max_size=None) as ws:
            await ws.send(json.dumps({"id": 1, "method": "Extensions.loadUnpacked",
                                      "params": {"path": ext_win_path}}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == 1:
                    if "error" in msg:
                        raise RuntimeError(msg["error"])
                    return msg["result"]["id"]

    return asyncio.run(_run())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--port", type=int, default=9222, help="Chrome's --remote-debugging-port (Windows-side localhost only)")
    ap.add_argument("--forward-port", type=int, default=None, help="Port for the Windows-side forwarder bound 0.0.0.0; default = port+100")
    ap.add_argument("--initial-url", default="about:blank")
    ap.add_argument(
        "--clone-from-real-chrome",
        action="store_true",
        help="Robocopy the user's real Chrome User Data dir to a scratch clone "
             "(C:\\Users\\<user>\\AppData\\Local\\AwardViewer\\<slug>-realclone), "
             "skipping caches. Real Chrome can keep running; we get its "
             "cookies/extensions/settings/fingerprint without touching it.",
    )
    ap.add_argument(
        "--no-extensions",
        action="store_true",
        help="Pass --disable-extensions to chrome.exe so cloned VPN/proxy "
             "extensions don't blackhole traffic in the scratch profile.",
    )
    ap.add_argument(
        "--profile-base",
        default=None,
        help="Windows path to base profile dir; default C:\\Users\\<user>\\AppData\\Local\\AwardViewer",
    )
    ap.add_argument(
        "--load-extension",
        default=None,
        help="Load an UNPACKED extension dir AFTER launch via CDP "
             "Extensions.loadUnpacked (the chrome.exe --load-extension flag is "
             "silently ignored by Chrome 137+). Accepts /mnt/<drive>/... or "
             "C:\\... ; must be Windows-visible and contain manifest.json.",
    )
    args = ap.parse_args()

    if not CHROME_EXE.exists():
        sys.exit(f"chrome.exe not found at {CHROME_EXE}")

    win_user = detect_windows_username()
    sys.stderr.write(f"[win-chrome] windows user: {win_user}\n")

    if args.profile_base:
        profile_root_win = args.profile_base
    else:
        profile_root_win = f"C:\\Users\\{win_user}\\AppData\\Local\\AwardViewer"

    profile_win = profile_root_win + "\\" + args.slug

    if args.clone_from_real_chrome:
        real_user_data = f"C:\\Users\\{win_user}\\AppData\\Local\\Google\\Chrome\\User Data"
        # Use a clone-specific subdir so we don't trample the bare scratch.
        profile_win = profile_root_win + "\\" + args.slug + "-realclone"
        # Wipe the previous clone so we always start consistent.
        try:
            pw = profile_win.replace("\\", "/")
            mnt = "/mnt/" + pw[0].lower() + pw[2:]
            import shutil
            if Path(mnt).exists():
                shutil.rmtree(mnt, ignore_errors=True)
                sys.stderr.write(f"[clone] cleared previous clone: {mnt}\n")
            Path(mnt).mkdir(parents=True, exist_ok=True)
        except Exception as e:
            sys.stderr.write(f"[clone] pre-clone mkdir best-effort: {e}\n")
        clone_real_profile(real_user_data, profile_win)
    # Best-effort mkdir from WSL using the /mnt path equivalent.
    try:
        # Translate Windows path back to /mnt/<drive>/...
        pw = profile_win.replace("\\", "/")
        if pw[1:2] == ":":
            mnt_path = "/mnt/" + pw[0].lower() + pw[2:]
            Path(mnt_path).mkdir(parents=True, exist_ok=True)
            sys.stderr.write(f"[win-chrome] profile dir: {mnt_path}\n")
    except Exception as e:
        sys.stderr.write(f"[win-chrome] profile mkdir best-effort: {e}\n")

    cmd = [
        str(CHROME_EXE),
        f"--remote-debugging-port={args.port}",
        # Chrome 111+ requires this to allow external CDP clients (Playwright,
        # raw WebSocket) to connect. Without it Chrome returns a stub
        # "Running" response and rejects the WS upgrade.
        "--remote-allow-origins=*",
        f"--user-data-dir={profile_win}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=ChromeWhatsNewUI,DownloadBubble",
        "--disable-popup-blocking",
        "--lang=en-US",
    ]
    if args.no_extensions:
        # Extensions cloned from a real profile (especially VPN/proxy/captcha
        # ones with webRequest perms) routinely break traffic in a scratch
        # context where they have no auth. Pass --no-extensions to skip them.
        cmd.append("--disable-extensions")
    # Resolve + validate the extension path now (fail fast); it's loaded AFTER
    # launch via CDP — the chrome.exe --load-extension flag is dead in 137+.
    ext_win_path = None
    if args.load_extension:
        raw = args.load_extension
        ext_win_path = raw if raw[1:2] == ":" else windows_path_for(Path(raw))
        pw = ext_win_path.replace("\\", "/")
        mnt = "/mnt/" + pw[0].lower() + pw[2:]
        if not (Path(mnt) / "manifest.json").is_file():
            sys.exit(f"--load-extension: no manifest.json under {raw} (need an UNPACKED extension dir)")
    cmd.append(args.initial_url)
    # Note: Chrome 116+ silently ignores --remote-debugging-address=0.0.0.0
    # (binds 127.0.0.1 only). To reach from WSL we run a Node TCP forwarder
    # on Windows that exposes 0.0.0.0:<forward_port> -> 127.0.0.1:<port>.
    sys.stderr.write(f"[win-chrome] launching: {' '.join(cmd)}\n")

    # Start chrome.exe detached. We must NOT wait for it; chrome stays alive
    # as a Windows process, and we just need its CDP port.
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    sys.stderr.write(f"[win-chrome] chrome.exe spawned (interop wrapper pid {proc.pid})\n")

    host_ip = detect_windows_host_ip()
    sys.stderr.write(f"[win-chrome] windows host IP from WSL: {host_ip}\n")

    # Spawn the Node TCP forwarder on Windows so we can reach Chrome's
    # CDP via {host_ip}:<forward_port> from inside WSL.
    #
    # Chrome's debug-port loopback family has flipped between releases:
    #   - 147.0.7727.116 (observed 2026-04): binds 127.0.0.1 only (v4)
    #   - some earlier 147.x builds:        bound [::1] only (v6)
    # And Windows has a wslrelay phantom listener on 127.0.0.1:9222 paired
    # with WSL2's localhost auto-forwarding — that listener accepts but
    # routes back into WSL, never to Chrome. So we can't blindly pick one
    # family. Probe ::1 first (which can never be the wslrelay phantom),
    # fall back to 127.0.0.1 if v6 refuses, and remember the winner per
    # connection so we don't re-probe on every accept.
    forward_port = args.forward_port or (args.port + 100)
    # Inline the JS so we don't depend on a Windows-readable file path
    # (WSL paths via \\wsl.localhost are flaky from non-explorer processes).
    forward_js = (
        "const net=require('net');"
        f"const lp={forward_port},tp={args.port};"
        "let upHost=null,upFam=null;"
        "const dial=(c)=>{"
        "  const tryConn=(host,fam,onFail)=>{"
        "    const u=net.createConnection({host,family:fam,port:tp,allowHalfOpen:true});"
        "    let settled=false;"
        "    u.once('connect',()=>{settled=true;upHost=host;upFam=fam;c.pipe(u);u.pipe(c);"
        "      const cl=(w,e)=>{if(e)console.error('[fwd '+w+']',e.code||e.message);try{c.destroy();}catch(_){};try{u.destroy();}catch(_){};};"
        "      c.on('error',e=>cl('client',e));u.on('error',e=>cl('upstream',e));"
        "      c.on('end',()=>u.end());u.on('end',()=>c.end());});"
        "    u.once('error',e=>{if(settled)return;try{u.destroy();}catch(_){};onFail(e);});"
        "  };"
        "  if(upHost){tryConn(upHost,upFam,e=>{console.error('[fwd cached '+upHost+']',e.code||e.message);try{c.destroy();}catch(_){};});return;}"
        "  tryConn('::1',6,e=>{console.error('[probe v6]',e.code||e.message);tryConn('127.0.0.1',4,e2=>{console.error('[probe v4]',e2.code||e2.message);try{c.destroy();}catch(_){};});});"
        "};"
        "const s=net.createServer({allowHalfOpen:true},dial);"
        "s.on('error',e=>{console.error('[listen]',e.code||e.message);process.exit(1);});"
        "s.listen(lp,'0.0.0.0',()=>console.log('forward 0.0.0.0:'+lp+'->{::1|127.0.0.1}:'+tp));"
    )
    fw_cmd = ["node.exe", "-e", forward_js]
    sys.stderr.write(f"[win-chrome] forwarder inline-node: 0.0.0.0:{forward_port} -> [::1]:{args.port}\n")
    fw_proc = subprocess.Popen(
        fw_cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    sys.stderr.write(f"[win-chrome] forwarder pid (interop) {fw_proc.pid}\n")

    info = wait_for_port(host_ip, forward_port, timeout=45)
    if ext_win_path:
        try:
            ws_url = json.loads(info)["webSocketDebuggerUrl"]
            eid = cdp_load_unpacked(ws_url, ext_win_path)
            sys.stderr.write(f"[win-chrome] loaded extension via CDP: {ext_win_path} -> id={eid}\n")
        except Exception as e:
            sys.stderr.write(f"[win-chrome] FAILED to load extension {ext_win_path}: {e}\n")
    sys.stderr.write(f"[win-chrome] CDP up via forwarder. /json/version:\n{info[:400]}...\n")
    print(f"http://{host_ip}:{forward_port}")


if __name__ == "__main__":
    main()
