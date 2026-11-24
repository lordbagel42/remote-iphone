#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["httpx>=0.27", "mcp>=1.2,<2", "pillow>=10"]
# ///
"""Wireless iPhone control through WebDriverAgent, without Xcode on this Mac.

  iphone.py setup               one-time USB setup (pairing, Developer Mode, Wi-Fi, DDI)
  iphone.py up                  keep a WDA session alive over Wi-Fi (start/reconnect supervisor)
  iphone.py status|screenshot|ui|tap|swipe|type|press|launch|home   drive the phone
  iphone.py mcp                 serve the same actions as an MCP server over stdio

Device-side plumbing uses the `pymobiledevice3` CLI (set PMD3 to override the command).
"""

import argparse
import base64
import io
import json
import os
import re
import shutil
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx

UDID = os.environ.get("IPHONE_UDID", "00008110-000870C036EB801E")
STATE = Path(os.environ.get("IPHONE_WDA_HOME", Path.home() / ".iphone-wda"))
TUNNELD = "http://127.0.0.1:49151"
WDA_PORT = int(os.environ.get("WDA_PORT", "8100"))
RUNNER_EXECUTABLE = "WebDriverAgentRunner-Runner"


def log(msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- WDA client


class WDAError(RuntimeError):
    def __init__(self, error: str, message: str):
        super().__init__(f"{error}: {message}" if message else error)
        self.error = error


class WDA:
    def __init__(self, url: str | None = None):
        url = url or os.environ.get("WDA_URL")
        if not url and (STATE / "wda_url").exists():
            url = (STATE / "wda_url").read_text().strip()
        self.url = (url or f"http://127.0.0.1:{WDA_PORT}").rstrip("/")
        self.http = httpx.Client(timeout=60)

    def req(self, method: str, path: str, body: dict | None = None):
        try:
            r = self.http.request(method, self.url + path, json=body)
        except httpx.HTTPError as e:
            raise WDAError("unreachable", f"{self.url} ({e!r}); is `iphone.py up` running?") from e
        data = r.json()
        value = data.get("value") if isinstance(data, dict) else data
        if r.status_code >= 400 or (isinstance(value, dict) and "error" in value):
            v = value if isinstance(value, dict) else {}
            raise WDAError(v.get("error", f"HTTP {r.status_code}"), v.get("message", ""))
        return value

    # A WDA session is created lazily, cached on disk, and recreated when WDA restarts.
    def _new_session(self) -> str:
        caps = {"capabilities": {"alwaysMatch": {"shouldWaitForQuiescence": False}}}
        r = self.http.post(self.url + "/session", json=caps).json()
        sid = r.get("sessionId") or r["value"]["sessionId"]
        STATE.mkdir(parents=True, exist_ok=True)
        (STATE / "session").write_text(sid)
        # W3C actions otherwise wait up to 2 s for the app to settle before answering; live control
        # needs the touch sent at once. Agents' taps go through XCTest's tap, which waits by itself.
        self.req("POST", f"/session/{sid}/appium/settings", {"settings": {"animationCoolOffTimeout": 0}})
        return sid

    def s(self, method: str, path: str, body: dict | None = None):
        sid_file = STATE / "session"
        sid = sid_file.read_text().strip() if sid_file.exists() else self._new_session()
        try:
            return self.req(method, f"/session/{sid}{path}", body)
        except WDAError as e:
            if e.error != "invalid session id":
                raise
            return self.req(method, f"/session/{self._new_session()}{path}", body)

    def status(self) -> dict:
        return self.req("GET", "/status")

    def window_size(self) -> tuple[int, int]:
        v = self.req("GET", "/window/size")
        return int(v["width"]), int(v["height"])

    def screenshot(self, points: bool = True, fmt: str = "PNG") -> bytes:
        """Screenshot; scaled to screen points by default so pixel coords == tap coords."""
        png = base64.b64decode(self.req("GET", "/screenshot"))
        if not points and fmt == "PNG":
            return png
        from PIL import Image

        img = Image.open(io.BytesIO(png))
        if points:
            img = img.resize(self.window_size(), Image.LANCZOS)
        out = io.BytesIO()
        img.convert("RGB").save(out, fmt, quality=85) if fmt == "JPEG" else img.save(out, fmt)
        return out.getvalue()

    def source(self, fmt: str = "compact") -> str:
        if fmt == "compact":
            return compact_tree(self.req("GET", "/source?format=json"))
        v = self.req("GET", f"/source?format={fmt}")
        return v if isinstance(v, str) else json.dumps(v, indent=1)

    def tap(self, x: float, y: float, fast: bool = False) -> None:
        """XCTest's tap waits for the app to idle first (about 1 s); fast sends the touch at once."""
        if fast:
            self.gesture([[x, y, 0], [x, y, 50]])
        else:
            self.s("POST", "/wda/tap", {"x": x, "y": y})

    def tap_element(self, text: str) -> tuple[float, float]:
        q = text.replace("\\", "\\\\").replace('"', '\\"')
        pred = f'label == "{q}" OR name == "{q}" OR value == "{q}"'
        el = self.s("POST", "/element", {"using": "predicate string", "value": pred})
        eid = el.get("ELEMENT") or next(iter(el.values()))
        r = self.s("GET", f"/element/{eid}/rect")
        self.s("POST", f"/element/{eid}/click")
        return r["x"] + r["width"] / 2, r["y"] + r["height"] / 2

    def swipe(self, x1: float, y1: float, x2: float, y2: float, duration: float = 0.2) -> None:
        body = {"fromX": x1, "fromY": y1, "toX": x2, "toY": y2, "duration": duration}
        self.s("POST", "/wda/dragfromtoforduration", body)

    def gesture(self, points: list[list[float]]) -> None:
        """One finger along [x, y, ms since touch-down] points, lifted at the last one (W3C actions)."""
        x0, y0, t0 = points[0]
        steps = [{"type": "pointerMove", "duration": 0, "x": x0, "y": y0}, {"type": "pointerDown", "button": 0}]
        px, py, pt = x0, y0, t0
        for x, y, t in points[1:]:
            ms = max(int(t - pt), 0)
            if (x, y) == (px, py):
                steps.append({"type": "pause", "duration": ms})
            else:
                steps.append({"type": "pointerMove", "duration": ms, "x": x, "y": y})
            px, py, pt = x, y, t
        steps.append({"type": "pointerUp", "button": 0})
        finger = {"type": "pointer", "id": "finger1", "parameters": {"pointerType": "touch"}, "actions": steps}
        self.s("POST", "/actions", {"actions": [finger]})

    def type(self, text: str) -> None:
        self.s("POST", "/wda/keys", {"value": list(text)})

    def press(self, name: str) -> None:
        name = name.lower().replace("_", "").replace("-", "")
        if name in ("lock", "power", "sleep"):
            self.s("POST", "/wda/lock")
        elif name in ("unlock", "wake"):
            self.s("POST", "/wda/unlock")
        elif name in ("home", "volumeup", "volumedown"):
            self.s("POST", "/wda/pressButton", {"name": name})
        else:
            raise WDAError("invalid argument", "button must be home, volumeup, volumedown, lock or unlock")

    def home(self) -> None:
        self.req("POST", "/wda/homescreen")

    def launch(self, bundle_id: str, restart: bool = False) -> None:
        self.s("POST", "/wda/apps/launch" if restart else "/wda/apps/activate", {"bundleId": bundle_id})

    def active_app(self) -> dict:
        return self.req("GET", "/wda/activeAppInfo")


INTERACTIVE = {
    "Button",
    "Cell",
    "TextField",
    "SecureTextField",
    "SearchField",
    "TextView",
    "Switch",
    "Slider",
    "Link",
    "Icon",
    "Key",
    "Tab",
    "MenuItem",
    "SegmentedControl",
    "Picker",
    "PickerWheel",
    "Stepper",
    "Toggle",
    "PageIndicator",
}


def compact_tree(root: dict) -> str:
    """One line per visible element that has text or can be interacted with, indented by nesting."""
    lines: list[str] = []

    def visit(node: dict, depth: int) -> None:
        kind = str(node.get("type", "")).removeprefix("XCUIElementType")
        visible = str(node.get("isVisible", "1")) not in ("0", "False", "false")
        texts = []
        for key in ("label", "name", "value"):
            val = node.get(key)
            if val not in (None, "") and str(val) not in texts:
                texts.append(str(val))
        shown = visible and (texts or kind in INTERACTIVE)
        if shown:
            r = node.get("rect") or {}
            x, y, w, h = (round(float(r.get(k, 0))) for k in ("x", "y", "width", "height"))
            label = " | ".join(f'"{t[:80]}"' for t in texts)
            off = "" if str(node.get("isEnabled", "1")) not in ("0", "False", "false") else " disabled"
            lines.append(f"{'  ' * depth}{kind} {label} [{x},{y} {w}x{h}] tap=({x + w // 2},{y + h // 2}){off}")
        for child in node.get("children") or []:
            visit(child, depth + 1 if shown else depth)

    visit(root, 0)
    return "\n".join(lines) or "(no visible elements)"


# --------------------------------------------------------------------------- pymobiledevice3 plumbing


def pmd3_cmd() -> list[str]:
    cmd = os.environ.get("PMD3", "pymobiledevice3").split()
    path = shutil.which(cmd[0])
    if not path:
        sys.exit("pymobiledevice3 not found; run: uv tool install --python 3.13 pymobiledevice3==11.63.1")
    return [path, *cmd[1:]]


def pm(*args: str, check: bool = True, timeout: float | None = 600) -> str:
    r = subprocess.run([*pmd3_cmd(), *args], capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"pymobiledevice3 {' '.join(args)} failed:\n{(r.stderr or r.stdout).strip()[-2000:]}")
    return r.stdout.strip()


def tunneld_devices() -> dict | None:
    try:
        return httpx.get(TUNNELD + "/", timeout=3).json()
    except (httpx.HTTPError, ValueError):
        return None


def ensure_tunneld() -> None:
    if tunneld_devices() is not None:
        return
    if not sys.stdin.isatty():
        raise RuntimeError("tunneld is not running on 127.0.0.1:49151 (install-services.sh installs it)")
    log("starting pymobiledevice3 tunneld (needs sudo once; it keeps Wi-Fi/USB tunnels up)")
    subprocess.run(["sudo", *pmd3_cmd(), "remote", "tunneld", "--daemonize"], check=True)
    for _ in range(30):
        if tunneld_devices() is not None:
            return
        time.sleep(1)
    raise RuntimeError("tunneld did not come up on 127.0.0.1:49151")


def find_runner(tunnel: str) -> str:
    """Bundle ID of the installed WDA runner (Impactor appends the team ID, so match the executable)."""
    apps = json.loads(pm("apps", "list", "--type", "User", "--tunnel", tunnel))
    ids = [bid for bid, info in apps.items() if info.get("CFBundleExecutable") == RUNNER_EXECUTABLE]
    if not ids:
        raise RuntimeError("WebDriverAgentRunner is not installed; run host/install-wda.sh")
    return ids[0]


def wda_ok(url: str) -> dict | None:
    try:
        v = httpx.get(url + "/status", timeout=4).json()["value"]
        return v if v.get("ready", True) else None
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        return None


def wda_candidates(udid: str, xclog: Path) -> list[str]:
    # The tunnel's own address comes first: it reaches device ports from this host over USB or Wi-Fi
    # and doesn't depend on the phone's LAN IP, which changes.
    entries = (tunneld_devices() or {}).get(udid, [])
    urls = [f"http://[{e['tunnel-address']}]:{WDA_PORT}" for e in entries if e.get("tunnel-address")]
    for e in entries:
        m = re.search(r"(\d+\.\d+\.\d+\.\d+)$", str(e.get("interface", "")))
        if m:  # Wi-Fi (mobdev2) tunnels are named after the phone's LAN address
            urls.append(f"http://{m.group(1)}:{WDA_PORT}")
    if xclog.exists():
        urls += re.findall(r"ServerURLHere->(\S+?)<-ServerURLHere", xclog.read_text(errors="replace"))[-1:]
    return list(dict.fromkeys(urls))


def wait_for_wda(proc: subprocess.Popen, udid: str, xclog: Path, timeout: float = 120) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"xcuitest exited with code {proc.returncode}; see {STATE / 'xcuitest.out'}")
        for url in wda_candidates(udid, xclog):
            if wda_ok(url):
                return url
        time.sleep(2)
    raise RuntimeError("WDA did not answer within %ds" % timeout)


def stop(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)


# Paths `serve` forwards to the screen-relay engine for the iPhone (relay/relay.ts).
RELAY_PATHS = {
    "/relay",
    "/viewer.js",
    "/stream",
    "/control",
    "/capabilities",
    "/metrics",
    "/input",
    "/screenshot.png",
    "/clipboard",
}

PROXY_HOST: str | None = None  # the address WDA currently answers on, set by run_once
MJPEG_PORT = 9100  # WDA's screen stream (MJPEG_SERVER_PORT on the device)


class WDAProxy(socketserver.ThreadingTCPServer):
    """Forwards a fixed port on this host to a WDA port wherever WDA currently answers, so agents
    never need the phone's (changing) IP address."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, port: int, target_port: int):
        self.target_port = target_port
        super().__init__(("0.0.0.0", port), WDAProxyHandler)


class WDAProxyHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        if PROXY_HOST is None:
            return  # WDA is restarting; the client sees a closed connection and retries
        try:
            upstream = socket.create_connection((PROXY_HOST, self.server.target_port), timeout=10)
        except OSError:
            return
        upstream.settimeout(None)

        def pump(src: socket.socket, dst: socket.socket) -> None:
            try:
                while data := src.recv(65536):
                    dst.sendall(data)
            except OSError:
                pass
            finally:
                for s in (src, dst):
                    try:
                        s.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

        t = threading.Thread(target=pump, args=(upstream, self.request), daemon=True)
        t.start()
        pump(self.request, upstream)
        t.join()
        upstream.close()


def run_once(udid: str, bundle_id: str | None) -> None:
    global PROXY_HOST
    log(f"waiting for a tunnel to {udid} (phone unlocked, on the same Wi-Fi, or plugged in)")
    while not (tunneld_devices() or {}).get(udid):
        time.sleep(3)
    log("tunnel up; mounting the Developer Disk Image if needed")
    out = pm("mounter", "auto-mount", "--tunnel", udid, check=False)
    if out:
        log(out.splitlines()[-1])
    bundle_id = bundle_id or find_runner(udid)
    xclog = STATE / "xcuitest.log"
    xclog.unlink(missing_ok=True)
    log(f"launching {bundle_id} via XCUITest")
    proc = subprocess.Popen(
        [
            *pmd3_cmd(),
            "developer",
            "dvt",
            "xcuitest",
            bundle_id,
            "--tunnel",
            udid,
            "--output-log",
            str(xclog),
            "--env",
            f"USE_PORT={WDA_PORT}",
            "--env",
            f"MJPEG_SERVER_PORT={MJPEG_PORT}",
        ],
        stdout=(STATE / "xcuitest.out").open("w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        url = wait_for_wda(proc, udid, xclog)
        (STATE / "wda_url").write_text(url)
        (STATE / "session").unlink(missing_ok=True)
        PROXY_HOST = urlsplit(url).hostname
        log(f"WDA ready at {url}")
        try:  # WDA's MJPEG stream defaults to 10 fps; the A15 manages about 30 at full size
            fps = int(os.environ.get("WDA_MJPEG_FPS", "30"))
            WDA(url).s("POST", "/appium/settings", {"settings": {"mjpegServerFramerate": fps}})
            log(f"MJPEG stream set to {fps} fps")
        except (WDAError, httpx.HTTPError, ValueError) as e:
            log(f"could not set the MJPEG frame rate: {e}")
        fails = 0
        while proc.poll() is None and fails < 3:
            time.sleep(10)  # also a keepalive: regular traffic keeps the phone's Wi-Fi awake
            fails = 0 if wda_ok(url) else fails + 1
        log("WDA stopped answering" if fails else f"xcuitest exited ({proc.returncode})")
    finally:
        PROXY_HOST = None
        stop(proc)


def cmd_up(args) -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # launchd stops with SIGTERM; still stop xcuitest
    for listen, target in ((args.listen, WDA_PORT), (args.listen_mjpeg, MJPEG_PORT)):
        if listen:
            threading.Thread(target=WDAProxy(listen, target).serve_forever, daemon=True).start()
            log(f"forwarding port {listen} of this host to WDA port {target}, wherever WDA is")
    while True:
        try:
            ensure_tunneld()
            run_once(args.udid, args.bundle_id)
        except KeyboardInterrupt:
            raise
        except Exception as e:  # keep supervising through phone reboots, Wi-Fi drops and lock screens
            log(f"error: {e}")
        log("restarting in 5s")
        time.sleep(5)


def cmd_setup(args) -> None:
    u = ["--udid", args.udid]
    print(pm("usbmux", "list"))
    info = json.loads(pm("lockdown", "info", *u))  # pairs (Trust prompt on the phone) if needed
    print(f"Connected: {info.get('DeviceName')} iOS {info.get('ProductVersion')} ({info.get('ProductType')})")
    if pm("amfi", "developer-mode-status", *u).strip() != "true":
        pm("amfi", "reveal-developer-mode", *u)
        sys.exit(
            "Developer Mode is off. On the phone: Settings > Privacy & Security > Developer Mode > On, "
            "restart, confirm 'Turn On', unlock, then run setup again."
        )
    print("Developer Mode: on")
    pm("lockdown", "wifi-connections", "on", *u)
    print("Wi-Fi connections:", pm("lockdown", "wifi-connections", *u))
    print("Developer Disk Image:", (pm("mounter", "auto-mount", *u, check=False) or "mounted").splitlines()[-1])
    apps = json.loads(pm("apps", "list", "--type", "User", *u))
    runners = [b for b, i in apps.items() if i.get("CFBundleExecutable") == RUNNER_EXECUTABLE]
    print("WDA runner:", runners[0] if runners else "NOT INSTALLED - run host/install-wda.sh")
    print(
        "\nNow on the phone: Settings > Developer > Enable UI Automation = On; "
        "Settings > Display & Brightness > Auto-Lock = Never.\nThen unplug and run: iphone.py up"
    )


# --------------------------------------------------------------------------- CLI + MCP


PAGE_STYLE = """<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0a0a; color: #ededed;
         font: 14px/1.5 "Geist", ui-sans-serif, system-ui, -apple-system, sans-serif; }
  .card { display: grid; gap: 16px; justify-items: center; padding: 24px; }
  h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
  .muted { color: #a1a1a1; font-size: 13px; }
  .error { color: #ff6166; font-size: 13px; min-height: 1.5em; }
  input, button { font: inherit; border-radius: 6px; border: 1px solid #2e2e2e; padding: 8px 12px; }
  input { background: #111; color: #ededed; width: 240px; }
  input:focus-visible, button:focus-visible { outline: 2px solid #3291ff; outline-offset: 1px; }
  button { background: #ededed; color: #0a0a0a; font-weight: 500; cursor: pointer; }
  .screen { width: min(375px, 90vw); aspect-ratio: 375 / 667; border-radius: 28px; border: 1px solid #2e2e2e;
            background: #000; overflow: hidden; display: grid; place-items: center; }
  .screen img { width: 100%; height: 100%; object-fit: contain; display: block; user-select: none;
                -webkit-user-drag: none; touch-action: none; cursor: pointer; }
  .screen { position: relative; }
  .touch { position: absolute; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50%;
           background: rgba(255,255,255,.35); border: 2px solid #fff; pointer-events: none;
           animation: fade .5s ease-out forwards; }
  @keyframes fade { to { opacity: 0; transform: scale(1.6); } }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; width: min(375px, 90vw); }
  .controls button, .typebar button { background: #1a1a1a; color: #ededed; border-color: #2e2e2e; }
  .controls button:hover, .typebar button:hover { background: #262626; }
  .typebar { display: flex; gap: 8px; width: min(375px, 90vw); }
  .typebar input { flex: 1; width: auto; min-width: 0; }
  .row { display: flex; gap: 8px; align-items: center; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #a1a1a1; }
  .dot.live { background: #45dec4; }
  a { color: #a1a1a1; }
</style>"""

LOGIN_PAGE = f"""<!doctype html><html lang="en"><head><title>iPhone</title>{PAGE_STYLE}</head><body>
<form class="card" method="post" action="/login">
  <h1>iPhone live view</h1>
  <input type="password" name="password" placeholder="Password" aria-label="Password" autofocus required>
  <button type="submit">View screen</button>
  <div class="error" role="alert">{{error}}</div>
</form></body></html>"""

LIVE_PAGE = f"""<!doctype html><html lang="en"><head><title>iPhone</title>{PAGE_STYLE}</head><body>
<main class="card">
  <div class="row"><span class="dot" id="dot"></span><h1>iPhone</h1>
    <span class="muted" id="state">Connecting…</span></div>
  <div class="screen" id="frame"><img id="screen" alt="Live iPhone screen. Click to tap, drag to swipe."></div>
  <div class="controls">
    <button data-press="home">Home</button><button data-press="unlock">Wake</button>
    <button data-press="lock">Lock</button><button data-press="volumedown">Vol −</button>
    <button data-press="volumeup">Vol +</button>
  </div>
  <form class="typebar" id="typebar">
    <input id="text" placeholder="Type into the focused field" aria-label="Text to type" autocomplete="off">
    <button type="submit">Send</button><button type="button" id="enter">Return</button>
  </form>
  <div class="error" id="err" role="status"></div>
  <div class="row"><a href="/relay" class="muted">H.264 viewer (screen-relay)</a>
    <a href="/logout" class="muted">Log out</a></div>
</main>
<script>
  // Read the MJPEG stream with fetch so a stalled or ended stream is noticed and reopened
  // (an <img> just freezes on its last frame). WDA sends frames continuously while it runs.
  const img = document.getElementById("screen"), dot = document.getElementById("dot"),
        state = document.getElementById("state");
  const show = (live, text) => {{ dot.className = live ? "dot live" : "dot"; state.textContent = text; }};
  const find = (buf, seq, from = 0) => {{
    outer: for (let i = from; i <= buf.length - seq.length; i++) {{
      for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
      return i;
    }}
    return -1;
  }};
  const CRLF2 = [13, 10, 13, 10];
  async function run() {{
    const ctrl = new AbortController();
    let last = Date.now();
    const watchdog = setInterval(() => {{ if (Date.now() - last > 5000) ctrl.abort(); }}, 1000);
    try {{
      const res = await fetch("/live.mjpeg", {{ signal: ctrl.signal, cache: "no-store" }});
      if (res.status === 401) {{ location.reload(); return; }}
      if (!res.ok) throw new Error("HTTP " + res.status);
      const reader = res.body.getReader();
      let buf = new Uint8Array(0);
      for (;;) {{
        const {{ done, value }} = await reader.read();
        if (done) break;
        const joined = new Uint8Array(buf.length + value.length);
        joined.set(buf); joined.set(value, buf.length); buf = joined;
        for (;;) {{  // each part: headers with Content-Length, blank line, JPEG bytes
          const end = find(buf, CRLF2);
          if (end < 0) break;
          const headers = new TextDecoder().decode(buf.subarray(0, end));
          const m = /content-length:\\s*(\\d+)/i.exec(headers);
          if (!m) {{ buf = buf.subarray(end + 4); continue; }}
          const len = +m[1], start = end + 4;
          if (buf.length < start + len) break;
          const url = URL.createObjectURL(new Blob([buf.slice(start, start + len)], {{ type: "image/jpeg" }}));
          const old = img.src; img.src = url; if (old.startsWith("blob:")) URL.revokeObjectURL(old);
          buf = buf.subarray(start + len);
          last = Date.now(); show(true, "Live");
        }}
      }}
    }} catch (e) {{ /* aborted by the watchdog or the connection dropped */ }}
    clearInterval(watchdog);
    show(false, "Reconnecting…");
    setTimeout(run, 2000);
  }}
  run();

  // Control: click = tap, drag = swipe, hold = long press, plus buttons and typing.
  async function act(path, body) {{
    try {{
      const res = await fetch(path, {{ method: "POST", headers: {{ "Content-Type": "application/json" }},
                                      body: JSON.stringify(body || {{}}) }});
      if (res.status === 401) {{ location.reload(); return; }}
      const out = await res.json().catch(() => ({{}}));
      if (!res.ok) fail(out.error || ("Error " + res.status));
    }} catch (e) {{ fail("Not sent: " + e.message); }}
  }}
  const err = document.getElementById("err");
  let errTimer;
  function fail(msg) {{ err.textContent = msg; clearTimeout(errTimer); errTimer = setTimeout(() => err.textContent = "", 5000); }}
  let size = null;  // the phone's screen in points, which taps and swipes use
  fetch("/window").then(r => r.json()).then(o => {{ size = o.value; }}).catch(() => {{}});
  const frame = document.getElementById("frame");
  function point(ev) {{
    const r = img.getBoundingClientRect(), w = size ? size.width : 375, h = size ? size.height : 667;
    return {{ x: Math.round((ev.clientX - r.left) / r.width * w), y: Math.round((ev.clientY - r.top) / r.height * h),
             px: ev.clientX - r.left, py: ev.clientY - r.top }};
  }}
  function ripple(p) {{
    const d = document.createElement("div"); d.className = "touch";
    d.style.left = p.px + "px"; d.style.top = p.py + "px";
    frame.appendChild(d); setTimeout(() => d.remove(), 600);
  }}
  let down = null;
  img.addEventListener("pointerdown", ev => {{
    ev.preventDefault(); img.setPointerCapture(ev.pointerId);
    down = {{ ...point(ev), t: performance.now() }};
  }});
  img.addEventListener("pointerup", ev => {{
    if (!down) return;
    const up = point(ev), held = (performance.now() - down.t) / 1000, start = down;
    down = null; ripple(up);
    if (Math.hypot(up.x - start.x, up.y - start.y) < 8) {{
      if (held < 0.5) act("/tap", {{ x: start.x, y: start.y, fast: true }});
      else act("/swipe", {{ from_x: start.x, from_y: start.y, to_x: start.x, to_y: start.y, duration: Math.min(held, 3) }});
    }} else {{
      act("/swipe", {{ from_x: start.x, from_y: start.y, to_x: up.x, to_y: up.y,
                       duration: Math.min(Math.max(held, 0.1), 2) }});
    }}
  }});
  img.addEventListener("pointercancel", () => {{ down = null; }});
  document.querySelectorAll("[data-press]").forEach(b =>
    b.addEventListener("click", () => act("/press", {{ button: b.dataset.press }})));
  const text = document.getElementById("text");
  document.getElementById("typebar").addEventListener("submit", ev => {{
    ev.preventDefault();
    if (text.value) {{ act("/type", {{ text: text.value }}); text.value = ""; }}
  }});
  document.getElementById("enter").addEventListener("click", () => act("/type", {{ text: "\\n" }}));
</script></body></html>"""


def cmd_serve(args) -> None:
    """Token-protected HTTP API over WDA, for agents outside the LAN (behind an HTTPS tunnel)."""
    import hmac
    import secrets
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import parse_qs

    token = os.environ.get("IPHONE_API_TOKEN", "")
    if len(token) < 32:
        sys.exit("set IPHONE_API_TOKEN to a random secret of at least 32 characters")
    public_url = os.environ.get("IPHONE_PUBLIC_URL", "").rstrip("/")
    view_password = os.environ.get("IPHONE_VIEW_PASSWORD", "")  # enables the live view page when set
    view_key = hmac.new(token.encode(), b"live-view-cookie", "sha256").digest()
    wda = WDA()
    mjpeg_addr = (urlsplit(wda.url).hostname, int(os.environ.get("WDA_MJPEG_PORT", MJPEG_PORT)))
    relay_addr = ("127.0.0.1", int(os.environ.get("RELAY_PORT", "8300")))
    lock = threading.Lock()  # one phone: run one action at a time
    shots: dict[str, tuple[float, bytes]] = {}  # unguessable id -> (expiry, JPEG), for screenshot links

    def act(method: str, path: str, body: dict) -> tuple[int, str, bytes]:
        def ok(value=None):
            return 200, "application/json", json.dumps({"ok": True, "value": value}).encode()

        if (method, path) == ("GET", "/status"):
            return ok({"status": wda.status(), "active_app": wda.active_app()})
        if (method, path) == ("GET", "/screenshot"):
            png = body.get("pixels") == "1"
            return 200, "image/png" if png else "image/jpeg", wda.screenshot(not png, "PNG" if png else "JPEG")
        if (method, path) == ("POST", "/screenshot/link"):
            # A short-lived URL that agents can open with their own image tools, instead of a base64 blob.
            now = time.time()
            for k in [k for k, (exp, _) in shots.items() if exp < now]:
                del shots[k]
            sid = secrets.token_urlsafe(24)
            shots[sid] = (now + 600, wda.screenshot(True, "JPEG"))
            w, h = wda.window_size()
            return ok({"url": f"{public_url}/shots/{sid}.jpg", "width": w, "height": h, "expires_in": 600})
        if (method, path) == ("GET", "/window"):
            w, h = wda.window_size()
            return ok({"width": w, "height": h})
        if (method, path) == ("GET", "/ui"):
            return 200, "text/plain; charset=utf-8", wda.source(body.get("format", "compact")).encode()
        if method != "POST":
            return 404, "application/json", b'{"ok":false,"error":"not found"}'
        if path == "/tap":
            if "text" in body:
                x, y = wda.tap_element(str(body["text"]))
                return ok({"x": x, "y": y})
            wda.tap(float(body["x"]), float(body["y"]), bool(body.get("fast", False)))
        elif path == "/swipe":
            wda.swipe(*(float(body[k]) for k in ("from_x", "from_y", "to_x", "to_y")), float(body.get("duration", 0.2)))
        elif path == "/gesture":
            pts = [[float(v) for v in p] for p in body["points"]]
            if not 2 <= len(pts) <= 100 or any(len(p) != 3 for p in pts):
                raise ValueError("points must be 2 to 100 [x, y, ms] triples")
            wda.gesture(pts)
        elif path == "/type":
            wda.type(str(body["text"]))
        elif path == "/press":
            wda.press(str(body["button"]))
        elif path == "/launch":
            wda.launch(str(body["bundle_id"]), bool(body.get("restart", False)))
        elif path == "/home":
            wda.home()
        else:
            return 404, "application/json", b'{"ok":false,"error":"not found"}'
        return ok()

    class Handler(BaseHTTPRequestHandler):
        def _handle(self, method: str) -> None:
            m = re.fullmatch(r"/shots/([A-Za-z0-9_-]{32})\.jpg", self.path)
            if method == "GET" and m:  # the unguessable link is the credential
                shot = shots.get(m.group(1))
                if shot and shot[0] > time.time():
                    return self._send(200, "image/jpeg", shot[1])
                return self._send(404, "application/json", b'{"ok":false,"error":"expired or unknown"}')
            if view_password and self.path.partition("?")[0] in ("/", "/login", "/logout", "/live.mjpeg"):
                return self._view(method)
            if self.path.partition("?")[0] in RELAY_PATHS:
                return self._relay(method)
            given = self.headers.get("Authorization", "")
            bearer_ok = hmac.compare_digest(given.encode(), f"Bearer {token}".encode())
            # The live page drives the phone with its login cookie; POSTs must come from the page itself.
            same_origin = method == "GET" or self.headers.get("Origin", "") == public_url
            if not bearer_ok and not (view_password and self._viewer() and same_origin):
                return self._send(401, "application/json", b'{"ok":false,"error":"unauthorized"}')
            path, _, qs = self.path.partition("?")
            try:
                if method == "POST":
                    length = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(length) or b"{}") if length <= 65536 else None
                    if not isinstance(body, dict):
                        raise ValueError("body must be a JSON object of at most 64 KiB")
                else:
                    body = {k: v[-1] for k, v in parse_qs(qs).items()}
                with lock:
                    self._send(*act(method, path, body))
            except (KeyError, ValueError, TypeError) as e:
                self._send(400, "application/json", json.dumps({"ok": False, "error": f"bad request: {e}"}).encode())
            except WDAError as e:
                status = 503 if e.error == "unreachable" else 422
                self._send(status, "application/json", json.dumps({"ok": False, "error": str(e)}).encode())
            except Exception as e:  # keep the API answering; the agent sees what went wrong
                self._send(500, "application/json", json.dumps({"ok": False, "error": repr(e)}).encode())

        def _send(self, status: int, ctype: str, data: bytes, headers: dict | None = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        # Live view: a password-protected page showing WDA's MJPEG screen stream.
        def _view(self, method: str) -> None:
            path = self.path.partition("?")[0]
            if method == "POST" and path == "/login":
                length = min(int(self.headers.get("Content-Length") or 0), 4096)
                given = parse_qs(self.rfile.read(length).decode(errors="replace")).get("password", [""])[-1]
                if not hmac.compare_digest(given.encode(), view_password.encode()):
                    time.sleep(2)  # slow down guessing
                    return self._send(
                        401, "text/html; charset=utf-8", LOGIN_PAGE.replace("{error}", "Wrong password.").encode()
                    )
                exp = str(int(time.time()) + 30 * 86400)
                cookie = f"{exp}.{hmac.new(view_key, exp.encode(), 'sha256').hexdigest()}"
                attrs = "HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000"
                return self._send(303, "text/plain", b"", {"Location": "/", "Set-Cookie": f"view={cookie}; {attrs}"})
            if path == "/logout":
                return self._send(303, "text/plain", b"", {"Location": "/", "Set-Cookie": "view=; Path=/; Max-Age=0"})
            if not self._viewer():
                if path == "/live.mjpeg":
                    return self._send(401, "text/plain", b"log in first")
                return self._send(200, "text/html; charset=utf-8", LOGIN_PAGE.replace("{error}", "").encode())
            if path == "/":
                return self._send(200, "text/html; charset=utf-8", LIVE_PAGE.encode())
            try:  # /live.mjpeg: relay WDA's own HTTP/1.0 multipart response byte for byte
                upstream = socket.create_connection(mjpeg_addr, timeout=10)
            except OSError:
                return self._send(503, "text/plain", b"WebDriverAgent is not running")
            try:
                upstream.sendall(b"GET / HTTP/1.0\r\n\r\n")
                upstream.settimeout(60)
                while data := upstream.recv(65536):
                    self.wfile.write(data)
            except OSError:
                pass  # viewer left or WDA restarted; the page reconnects
            finally:
                upstream.close()

        # screen-relay viewer, CLI and SDK: forwarded byte for byte (WebSockets too) to the relay engine
        # (relay/relay.ts), after the same checks as the API. /relay is the viewer page.
        def _relay(self, method: str) -> None:
            path = self.path.partition("?")[0]
            offered = [p.strip() for p in self.headers.get("Sec-WebSocket-Protocol", "").split(",")]
            bearer_ok = hmac.compare_digest(self.headers.get("Authorization", "").encode(), f"Bearer {token}".encode())
            bearer_ok = bearer_ok or any(hmac.compare_digest(p.encode(), f"bearer.{token}".encode()) for p in offered)
            upgrade = self.headers.get("Upgrade", "").lower() == "websocket"
            # Browsers send Origin on WebSockets and POSTs; the cookie is SameSite=Strict besides.
            same_origin = (method == "GET" and not upgrade) or self.headers.get("Origin", "") == public_url
            if not bearer_ok and not (view_password and self._viewer() and same_origin):
                if path == "/relay" and not upgrade:
                    return self._send(303, "text/plain", b"", {"Location": "/"})
                return self._send(401, "application/json", b'{"error":"unauthorized"}')
            body = b""
            if method == "POST":
                length = int(self.headers.get("Content-Length") or 0)
                if length > 1 << 20:
                    return self._send(413, "application/json", b'{"error":"too_large"}')
                body = self.rfile.read(length)
            try:
                upstream = socket.create_connection(relay_addr, timeout=10)
            except OSError:
                return self._send(503, "application/json", b'{"error":"the relay engine is not running"}')
            upstream.settimeout(None)
            target = "/" + self.path[len("/relay") :].lstrip("/") if path == "/relay" else self.path
            lines = [f"{method} {target} HTTP/1.1"]
            for k, v in self.headers.items():
                if k.lower() not in ("connection", "authorization", "cookie", "host") or (
                    k.lower() == "connection" and upgrade
                ):
                    lines.append(f"{k}: {v}")
            lines += [f"Host: {relay_addr[0]}:{relay_addr[1]}"] + ([] if upgrade else ["Connection: close"])
            upstream.sendall(("\r\n".join(lines) + "\r\n\r\n").encode() + body)
            self.close_connection = True

            def pump(src: socket.socket, dst: socket.socket) -> None:
                try:
                    while data := src.recv(65536):
                        dst.sendall(data)
                except OSError:
                    pass
                finally:
                    for s in (src, dst):
                        try:
                            s.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass

            if upgrade:
                threading.Thread(target=pump, args=(self.connection, upstream), daemon=True).start()
            pump(upstream, self.connection)
            upstream.close()

        def _viewer(self) -> bool:
            for part in self.headers.get("Cookie", "").split(";"):
                name, _, value = part.strip().partition("=")
                exp, _, sig = value.partition(".")
                if name == "view" and exp.isdigit() and int(exp) > time.time():
                    want = hmac.new(view_key, exp.encode(), "sha256").hexdigest()
                    if hmac.compare_digest(sig.encode(), want.encode()):
                        return True
            return False

        def do_GET(self) -> None:
            self._handle("GET")

        def do_POST(self) -> None:
            self._handle("POST")

        def log_message(self, fmt, *a) -> None:
            log(f"{self.address_string()} {fmt % a}")

    log(f"serving the iPhone API on {args.host}:{args.port} (WDA at {wda.url})")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


def cmd_mcp(_args) -> None:
    from mcp.server.fastmcp import FastMCP, Image

    wda = WDA()
    m = FastMCP("iphone")

    @m.tool()
    def status() -> str:
        """WDA/device status and the frontmost app."""
        return json.dumps({"wda": wda.url, "status": wda.status(), "active_app": wda.active_app()}, indent=1)

    @m.tool()
    def screenshot() -> Image:
        """Screenshot of the iPhone, scaled to screen points: its pixel coordinates are tap coordinates."""
        return Image(data=wda.screenshot(points=True, fmt="JPEG"), format="jpeg")

    @m.tool()
    def ui_tree(format: str = "compact") -> str:
        """Accessibility tree of the current screen. format: compact (visible text/controls with tap
        coordinates), xml, json or description."""
        return wda.source(format)

    @m.tool()
    def tap(x: float | None = None, y: float | None = None, text: str | None = None) -> str:
        """Tap at screen-point coordinates (x, y), or tap the element whose label/name/value equals text."""
        if text is not None:
            cx, cy = wda.tap_element(text)
            return f"tapped {text!r} at ({cx:.0f},{cy:.0f})"
        if x is None or y is None:
            raise ValueError("pass x and y, or text")
        wda.tap(x, y)
        return f"tapped ({x},{y})"

    @m.tool()
    def swipe(from_x: float, from_y: float, to_x: float, to_y: float, duration: float = 0.2) -> str:
        """Swipe/drag between two screen points. To scroll down, swipe from low on the screen to high."""
        wda.swipe(from_x, from_y, to_x, to_y, duration)
        return "ok"

    @m.tool()
    def type_text(text: str) -> str:
        """Type text into the focused field (tap the field first). Use "\\n" for return."""
        wda.type(text)
        return "ok"

    @m.tool()
    def press_button(name: str) -> str:
        """Press a hardware button: home, volumeup, volumedown, lock, or unlock."""
        wda.press(name)
        return "ok"

    @m.tool()
    def launch_app(bundle_id: str, restart: bool = False) -> str:
        """Open an app by bundle ID (e.g. com.apple.Preferences, com.apple.mobilesafari). restart=True relaunches it."""
        wda.launch(bundle_id, restart)
        return "ok"

    @m.tool()
    def go_home() -> str:
        """Go to the home screen."""
        wda.home()
        return "ok"

    m.run()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--wda", help="WDA URL (default: $WDA_URL, else the one `up` saved)")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("setup", "up"):
        sp = sub.add_parser(name)
        sp.add_argument("--udid", default=UDID)
        if name == "up":
            sp.add_argument("--bundle-id", help="runner bundle ID (default: auto-detect)")
            sp.add_argument(
                "--listen",
                type=int,
                default=int(os.environ.get("WDA_LISTEN", "0")),
                help="serve WDA on this port of this host, whatever the phone's IP (default: $WDA_LISTEN, off)",
            )
            sp.add_argument(
                "--listen-mjpeg",
                type=int,
                default=int(os.environ.get("WDA_MJPEG_LISTEN", "0")),
                help="serve WDA's MJPEG screen stream on this port (default: $WDA_MJPEG_LISTEN, off)",
            )
    sub.add_parser("status")
    sp = sub.add_parser("screenshot")
    sp.add_argument("-o", "--output", default="screenshot.png")
    sp.add_argument("--pixels", action="store_true", help="full resolution instead of screen points")
    sp = sub.add_parser("ui")
    sp.add_argument("--format", default="compact", choices=["compact", "xml", "json", "description"])
    sp = sub.add_parser("tap")
    sp.add_argument("x_or_text")
    sp.add_argument("y", nargs="?", type=float)
    sp = sub.add_parser("swipe")
    for a in ("x1", "y1", "x2", "y2"):
        sp.add_argument(a, type=float)
    sp.add_argument("--duration", type=float, default=0.2)
    sub.add_parser("type").add_argument("text")
    sub.add_parser("press").add_argument("button", help="home, volumeup, volumedown, lock, unlock")
    sp = sub.add_parser("launch")
    sp.add_argument("bundle_id")
    sp.add_argument("--restart", action="store_true")
    sub.add_parser("home")
    sub.add_parser("mcp")
    sp = sub.add_parser("serve", help="token-protected HTTP API (needs IPHONE_API_TOKEN)")
    sp.add_argument("--host", default="127.0.0.1")
    sp.add_argument("--port", type=int, default=8200)
    args = p.parse_args()

    if args.cmd in ("setup", "up", "mcp", "serve"):
        if args.wda:
            os.environ["WDA_URL"] = args.wda
        return {"setup": cmd_setup, "up": cmd_up, "mcp": cmd_mcp, "serve": cmd_serve}[args.cmd](args)

    wda = WDA(args.wda)
    try:
        if args.cmd == "status":
            print(json.dumps({"wda": wda.url, "status": wda.status(), "active_app": wda.active_app()}, indent=1))
        elif args.cmd == "screenshot":
            Path(args.output).write_bytes(wda.screenshot(points=not args.pixels))
            print(args.output)
        elif args.cmd == "ui":
            print(wda.source(args.format))
        elif args.cmd == "tap":
            if args.y is None:
                print("tapped at (%.0f,%.0f)" % wda.tap_element(args.x_or_text))
            else:
                wda.tap(float(args.x_or_text), args.y)
        elif args.cmd == "swipe":
            wda.swipe(args.x1, args.y1, args.x2, args.y2, args.duration)
        elif args.cmd == "type":
            wda.type(args.text)
        elif args.cmd == "press":
            wda.press(args.button)
        elif args.cmd == "launch":
            wda.launch(args.bundle_id, args.restart)
        elif args.cmd == "home":
            wda.home()
    except WDAError as e:
        sys.exit(f"error: {e}")


if __name__ == "__main__":
    main()
