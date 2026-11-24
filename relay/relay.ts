// A screen-relay engine for the iPhone: streams the phone's screen as H.264 over screen-relay's nsl1
// WebSocket protocol, and turns screen-relay input (pointer, wheel, keys, text) into taps, gestures and
// typing through `iphone.py serve`. screen-relay's own viewer, CLI and Node SDK then work with the phone.
//
// It listens on loopback without authentication; `iphone.py serve` checks the login cookie or the API
// token and forwards screen-relay's paths here.
//
//   RELAY_PORT      port on 127.0.0.1 (default 8300)
//   IPHONE_API      `iphone.py serve` origin (default http://127.0.0.1:8200)
//   IPHONE_API_TOKEN  its bearer token
//   RELAY_STREAM_PORT the ScreenStream broadcast extension's port on the phone (default 8400): hardware
//                   H.264 straight from the phone, over USB through usbmuxd when the phone is plugged in,
//                   else from its Wi-Fi IP. Used whenever it answers.
//   IPHONE_UDID     the phone, for usbmuxd (default 00008110-000870C036EB801E)
//   RELAY_MJPEG_URL otherwise WDA's MJPEG stream, transcoded with ffmpeg (default http://127.0.0.1:9100)
//   RELAY_SOURCE    a shell command that writes H.264 Annex B to stdout instead (with AUD NAL units)
//   RELAY_FPS       frame rate reported to viewers (default 30)
//   WDA_PORT        WDA's port on the phone, reached through usbmuxd for touches (default 8100)
//   WDA_URL         WDA when the phone is not on USB (default: the URL `iphone.py up` saved in
//                   $IPHONE_WDA_HOME/wda_url, else http://127.0.0.1:$WDA_PORT)
//   RELAY_STUN      STUN servers for WebRTC viewers, comma-separated (default stun:stun.l.google.com:19302)

import http from "node:http";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { H264Packetizer, MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, useNACK, usePLI } from "werift";
import { HEADER_SIZE, INPUT_SIZE, MAX_INPUT_BATCH, MESSAGE_TYPES, SUBPROTOCOL, header, parseHeader } from "screen-relay/protocol";

const PORT = Number(process.env.RELAY_PORT ?? 8300);
const API = (process.env.IPHONE_API ?? "http://127.0.0.1:8200").replace(/\/$/, "");
const TOKEN = process.env.IPHONE_API_TOKEN ?? "";
const MJPEG_URL = process.env.RELAY_MJPEG_URL ?? "http://127.0.0.1:9100";
const SOURCE = process.env.RELAY_SOURCE ?? "";
const FPS = Number(process.env.RELAY_FPS ?? 30);
const STREAM_PORT = Number(process.env.RELAY_STREAM_PORT ?? 8400);
const WDA_PORT = Number(process.env.WDA_PORT ?? 8100);
// A viewer whose oldest unacknowledged frame is older than this skips ahead to a fresh keyframe, which
// ScreenStream encodes on request ("K"), so falling behind costs one frame instead of a long freeze.
const MAX_LAG_MS = 400;
const MAX_UNACKED = 240;
const MAX_UNACKED_BYTES = 8 << 20;

const log = (msg: string) => console.error(`${new Date().toISOString().slice(11, 19)} ${msg}`);
const viewerDir = fileURLToPath(new URL("../viewer/", import.meta.resolve("screen-relay")));
// screen-relay's viewer has no phone buttons, so the page gets a bar of them. They call
// `iphone.py serve`'s /press with the login cookie, like the MJPEG page's buttons.
const PHONE_BUTTONS = `
<style>
#iphone-buttons{position:fixed;right:12px;top:50%;transform:translateY(-50%);z-index:3;display:flex;flex-direction:column;gap:4px;padding:4px;
  border-radius:14px;background:rgba(12,12,12,.86);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
  border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 24px rgba(0,0,0,.45)}
#iphone-buttons button{min-width:64px;padding:8px 10px;border:0;border-radius:10px;background:transparent;color:#ededed;
  font:500 12px/1 system-ui,-apple-system,sans-serif;cursor:pointer;white-space:nowrap}
#iphone-buttons button:hover{background:rgba(255,255,255,.1)}
#iphone-buttons button:active{background:rgba(255,255,255,.2)}
#iphone-buttons button:focus-visible{outline:2px solid #3b82f6;outline-offset:1px}
#iphone-buttons .sep{height:1px;margin:2px 6px;background:rgba(255,255,255,.12)}
/* Keep the bar beside the phone: reserve its width on both sides so the screen stays centered. */
#screen{width:min(calc(100vw - 200px),calc(100dvh*var(--w)/var(--h)));height:min(100dvh,calc((100vw - 200px)*var(--h)/var(--w)))}
@media (max-width:640px){
  #iphone-buttons{top:auto;bottom:8px;right:50%;transform:translateX(50%);flex-direction:row}
  #iphone-buttons button{min-width:0}
  #iphone-buttons .sep{width:1px;height:auto;margin:6px 2px}
  #screen{width:min(100vw,calc((100dvh - 64px)*var(--w)/var(--h)));height:min(calc(100dvh - 64px),calc(100vw*var(--h)/var(--w)));margin:0 auto auto}
}
</style>
<nav id="iphone-buttons" aria-label="iPhone buttons">
  <button type="button" data-press="home" title="Home button">Home</button>
  <button type="button" data-press="lock" title="Side button: lock">Lock</button>
  <button type="button" data-press="unlock" title="Wake and unlock">Wake</button>
  <div class="sep"></div>
  <button type="button" data-press="volumeup" title="Volume up">Vol +</button>
  <button type="button" data-press="volumedown" title="Volume down">Vol −</button>
</nav>
<script>
document.querySelectorAll("#iphone-buttons [data-press]").forEach((b) => b.addEventListener("click", async () => {
  const res = await fetch("/press", { method: "POST", headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({ button: b.dataset.press }) }).catch(() => null);
  if (res && res.status === 401) location.href = "/";
  document.querySelector("#screen")?.focus();
}));
</script>
</body>`;
const viewerPage = Buffer.from(readFileSync(viewerDir + "index.html", "utf8").replace("</body>", PHONE_BUTTONS));
// The WebRTC viewer: video and input peer to peer (see rtcViewer). It falls back to screen-relay's
// WebSocket viewer (?ws=1) when no connection comes up, e.g. behind a network that blocks UDP.
const RTC_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>iPhone</title>
<link rel="icon" href="data:,">
<style>
:root{color-scheme:dark}
html,body{margin:0;height:100%;overflow:hidden;background:#000;font:13px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;color:#ededed}
#stage{position:fixed;inset:0;display:flex}
#screen{--w:750;--h:1334;display:block;margin:auto;background:#000;outline:none;touch-action:none;object-fit:fill;
  width:min(100vw,calc(100dvh*var(--w)/var(--h)));height:min(100dvh,calc(100vw*var(--h)/var(--w)))}
#bar{position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:3;display:flex;align-items:center;gap:8px;padding:6px 12px;
  border-radius:999px;background:rgba(12,12,12,.86);border:1px solid rgba(255,255,255,.12);color:#a1a1a1;white-space:nowrap}
#bar .dot{width:8px;height:8px;border-radius:50%;background:#f5a623}
#bar.live .dot{background:#3fb950}#bar.error .dot{background:#f85149}
#bar button,#bar a{padding:4px 8px;border:0;border-radius:999px;background:rgba(255,255,255,.1);color:#ededed;font:inherit;cursor:pointer;text-decoration:none}
#bar button:hover,#bar a:hover{background:rgba(255,255,255,.2)}
</style>
</head>
<body>
<div id="stage"><video id="screen" tabindex="0" autoplay playsinline muted aria-label="iPhone screen"></video></div>
<div id="bar" role="status"><span class="dot"></span><span id="status">Connecting…</span>
  <button type="button" id="take" hidden>Take control</button><a href="?ws=1" id="fallback" hidden>WebSocket viewer</a></div>
<script>
const screenEl = document.getElementById("screen"), bar = document.getElementById("bar"), statusEl = document.getElementById("status");
const takeBtn = document.getElementById("take"), fallback = document.getElementById("fallback");
const viewOnly = new URLSearchParams(location.search).get("view") === "1";
let ws = null, pc = null, dc = null, connected = false, retry = null;
const say = (text, state) => { statusEl.textContent = text; bar.className = state || ""; };

function start(take) {
  clearTimeout(retry);
  ws?.close(); pc?.close();
  connected = false; dc = null; takeBtn.hidden = true;
  say("Connecting…");
  const q = viewOnly ? "?view=1" : take ? "?take=1" : "";
  const sock = ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/rtc" + q);
  const peer = pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  peer.ontrack = (e) => {
    if ("jitterBufferTarget" in e.receiver) e.receiver.jitterBufferTarget = 0; // show frames as they arrive
    screenEl.srcObject = new MediaStream([e.track]);
  };
  peer.ondatachannel = (e) => { dc = e.channel; };
  peer.onconnectionstatechange = async () => {
    if (pc !== peer) return;
    if (peer.connectionState === "connected") {
      connected = true;
      let path = "";
      for (const s of (await peer.getStats()).values())
        if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") {
          const local = (await peer.getStats()).get(s.localCandidateId);
          path = local?.candidateType === "relay" ? " · via TURN" : local?.candidateType === "host" ? " · direct (LAN)" : " · direct";
        }
      say((viewOnly ? "Live · view only" : "Live · you have control") + path, "live");
      fallback.hidden = true;
    } else if (peer.connectionState === "failed") {
      say("No direct connection to the phone", "error");
      fallback.hidden = false;
    }
  };
  sock.onmessage = async (m) => {
    const { offer } = JSON.parse(m.data);
    if (!offer) return;
    await peer.setRemoteDescription(offer);
    await peer.setLocalDescription(await peer.createAnswer());
    // Send the answer with its candidates; STUN answers within ~100 ms, a blocked one is not waited for.
    await new Promise((r) => {
      if (peer.iceGatheringState === "complete") return r();
      peer.addEventListener("icegatheringstatechange", () => peer.iceGatheringState === "complete" && r());
      setTimeout(r, 1500);
    });
    sock.send(JSON.stringify({ answer: peer.localDescription }));
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    peer.close();
    if (e.code === 4003 || e.code === 4001) {
      say(e.code === 4001 ? "Another viewer took control" : "Another viewer has control", "error");
      takeBtn.hidden = false;
      return;
    }
    say("Reconnecting…", "error");
    retry = setTimeout(() => start(false), 2000);
  };
  // No connection in 10 s (UDP blocked, say): offer the WebSocket viewer.
  setTimeout(() => { if (pc === peer && !connected) { say("No direct connection yet", "error"); fallback.hidden = false; } }, 10000);
}
takeBtn.onclick = () => start(true);
if (viewOnly) fallback.href = "?ws=1&view=1";
for (const ev of ["loadedmetadata", "resize"]) screenEl.addEventListener(ev, () => {
  screenEl.style.setProperty("--w", screenEl.videoWidth);
  screenEl.style.setProperty("--h", screenEl.videoHeight);
});

// Input: screen-relay input records (type, code, value, x, y in 0..1, modifiers) on the data channel.
function send(type, code = 0, value = 0, x = 0, y = 0) {
  if (!viewOnly && dc?.readyState === "open") dc.send(JSON.stringify({ type, code, value, x, y, modifiers: 0 }));
}
function at(e) {
  const r = screenEl.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
}
let down = false;
screenEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  screenEl.focus();
  screenEl.setPointerCapture(e.pointerId);
  down = true;
  send(4, 1, 0, ...at(e));
  e.preventDefault();
});
screenEl.addEventListener("pointermove", (e) => { if (down) send(3, 0, 0, ...at(e)); });
screenEl.addEventListener("pointerup", (e) => { if (down) { down = false; send(5, 1, 0, ...at(e)); } });
screenEl.addEventListener("pointercancel", () => { if (down) { down = false; send(7); } });
screenEl.addEventListener("contextmenu", (e) => e.preventDefault());
let wheel = [0, 0];
screenEl.addEventListener("wheel", (e) => {
  e.preventDefault();
  const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
  wheel[0] += e.deltaY * scale; wheel[1] += e.deltaX * scale;
  for (const axis of [0, 1]) {
    const notches = Math.trunc(wheel[axis] / 100);
    if (!notches) continue;
    wheel[axis] -= notches * 100;
    send(6, axis, Math.max(-10, Math.min(10, notches)) * 120, ...at(e));
  }
}, { passive: false });
const KEYS = { Enter: 40, Backspace: 42, Tab: 43, Home: 74 };
document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key in KEYS) send(1, KEYS[e.key]);
  else if ([...e.key].length === 1) send(8, 0, e.key.codePointAt(0));
  else return;
  e.preventDefault();
});
document.addEventListener("paste", (e) => {
  for (const ch of e.clipboardData?.getData("text") ?? "") send(8, 0, ch.codePointAt(0));
});
start(false);
</script>
${PHONE_BUTTONS}
</html>`;
const VIEWER: Record<string, [string, Buffer]> = {
  "/": ["text/html; charset=utf-8", viewerPage],
  "/index.html": ["text/html; charset=utf-8", viewerPage],
  "/viewer.js": ["text/javascript; charset=utf-8", readFileSync(viewerDir + "viewer.js")],
};
const rtcPage = Buffer.from(RTC_PAGE);

// ------------------------------------------------------------------------------------------ video

type Frame = { data: Buffer; key: boolean; time: bigint };

/** Reads the width and height from an H.264 SPS NAL unit (payload after the NAL header byte). */
function spsSize(nal: Buffer): [number, number] {
  const bytes: number[] = []; // drop emulation-prevention bytes (00 00 03)
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    bytes.push(nal[i]);
  }
  let bit = 0;
  const u = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
    return v;
  };
  const ue = () => {
    let zeros = 0;
    while (u(1) === 0) zeros++;
    return (1 << zeros) - 1 + u(zeros);
  };
  const se = () => {
    const v = ue();
    return v & 1 ? (v + 1) / 2 : -v / 2;
  };
  const profile = u(8);
  u(16); // constraint flags, level
  ue(); // seq_parameter_set_id
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = ue();
    if (chroma === 3) u(1);
    ue();
    ue();
    u(1);
    if (u(1)) {
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (!u(1)) continue;
        let last = 8, next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next) next = (last + se() + 256) % 256;
          last = next || last;
        }
      }
    }
  }
  ue(); // log2_max_frame_num
  const pocType = ue();
  if (pocType === 0) ue();
  else if (pocType === 1) {
    u(1);
    se();
    se();
    const n = ue();
    for (let i = 0; i < n; i++) se();
  }
  ue(); // max_num_ref_frames
  u(1);
  const mbW = ue() + 1, mapH = ue() + 1, frameMbsOnly = u(1);
  if (!frameMbsOnly) u(1);
  u(1);
  let [cl, cr, ct, cb] = [0, 0, 0, 0];
  if (u(1)) [cl, cr, ct, cb] = [ue(), ue(), ue(), ue()];
  const cropX = chroma === 0 ? 1 : 2, cropY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
  return [mbW * 16 - (cl + cr) * cropX, mapH * 16 * (2 - frameMbsOnly) - (ct + cb) * cropY];
}

/** Splits an Annex B byte stream into access units at AUD NAL units (type 9). */
function* nalStarts(buf: Buffer, from: number): Generator<[number, number]> {
  for (let i = from; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      yield [i > 0 && buf[i - 1] === 0 ? i - 1 : i, i + 3];
      i += 2;
    }
  }
}

class Video {
  width = 0;
  height = 0;
  gop: Frame[] = []; // the latest keyframe and the frames after it, for viewers that join late
  frames = 0;
  bytes = 0;
  private proc: ChildProcess | null = null;
  private sock: net.Socket | null = null;
  private starting = false;
  private keyAsked = 0;
  private buf: Buffer = Buffer.alloc(0);
  private idleTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  readonly sinks = new Set<(f: Frame) => void>();

  /** Starts the encoder while anyone watches; stops it 30 s after the last viewer leaves. */
  watch(sink: (f: Frame) => void): () => void {
    this.sinks.add(sink);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.proc && !this.sock && !this.starting && !this.restartTimer) this.start();
    return () => {
      this.sinks.delete(sink);
      if (!this.sinks.size) this.idleTimer = setTimeout(() => this.stop(), 30_000);
    };
  }

  /** Whether a keyframe can be had on request (ScreenStream) rather than only every 2 s (ffmpeg). */
  get keysOnRequest(): boolean {
    return this.sock !== null;
  }

  /** Asks ScreenStream for a keyframe of the current screen (ffmpeg's own come every 2 s). */
  requestKey(): void {
    if (!this.sock || Date.now() - this.keyAsked < 250) return;
    this.keyAsked = Date.now();
    this.sock.write("K");
  }

  /** ScreenStream on the phone when it answers, else the MJPEG transcoder (or RELAY_SOURCE). */
  private start(): void {
    if (SOURCE) return this.spawn();
    this.starting = true;
    connectStream()
      .then(({ sock, via }) => this.attach(sock, via))
      .catch(() => {
        this.starting = false;
        if (this.sinks.size) this.spawn(); // not broadcasting: WDA's MJPEG
      });
  }

  private attach(sock: net.Socket, via: string): void {
    this.starting = false;
    if (!this.sinks.size) return void sock.destroy();
    sock.setNoDelay(true);
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.gop = [];
    log(`video: ScreenStream over ${via}`);
    sock.on("data", (chunk: Buffer) => this.feedFramed(chunk));
    sock.on("error", () => {}); // "close" follows
    sock.on("close", () => {
      if (this.sock !== sock) return;
      this.sock = null;
      log("video: ScreenStream closed; reconnecting in 2 s");
      if (this.sinks.size) this.restartTimer = setTimeout(() => ((this.restartTimer = null), this.start()), 2000);
    });
    sock.resume();
  }

  private spawn(): void {
    const args = SOURCE
      ? ["-c", SOURCE]
      : [
          "-c",
          [
            "exec ffmpeg -hide_banner -loglevel error -fflags nobuffer -flags low_delay",
            "-probesize 32 -analyzeduration 0 -f mpjpeg -i \"$RELAY_MJPEG_URL\" -an",
            "-vf 'scale=trunc(iw/2)*2:trunc(ih/2)*2' -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p",
            `-g ${FPS * 2} -x264-params repeat-headers=1:aud=1 -f h264 -`,
          ].join(" "),
        ];
    log(SOURCE ? `video: ${SOURCE}` : `video: ffmpeg transcoding ${MJPEG_URL}`);
    const proc = spawn("sh", args, { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, RELAY_MJPEG_URL: MJPEG_URL } });
    this.proc = proc;
    this.buf = Buffer.alloc(0);
    this.gop = [];
    proc.stdout!.on("data", (chunk: Buffer) => this.feed(chunk));
    // Switch to ScreenStream as soon as a broadcast starts.
    const probe = setInterval(() => {
      if (this.proc !== proc || SOURCE) return clearInterval(probe);
      connectStream()
        .then(({ sock, via }) => {
          if (this.proc !== proc) return void sock.destroy();
          clearInterval(probe);
          this.proc = null;
          proc.kill("SIGTERM");
          this.attach(sock, via);
        })
        .catch(() => {});
    }, 10_000);
    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      log(`video source exited (${code}); restarting in 2 s`);
      // start() tries ScreenStream again first, so a broadcast started later takes over.
      if (this.sinks.size) this.restartTimer = setTimeout(() => ((this.restartTimer = null), this.start()), 2000);
    });
  }

  private stop(): void {
    const proc = this.proc, sock = this.sock;
    this.proc = null;
    this.sock = null;
    proc?.kill("SIGTERM");
    sock?.destroy();
    log("video: stopped, nobody is watching");
  }

  private feed(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // An access unit runs from one AUD to the next; keep the unfinished tail.
    const auds: number[] = [];
    for (const [start, payload] of nalStarts(this.buf, 0)) if ((this.buf[payload] & 31) === 9) auds.push(start);
    for (let i = 0; i + 1 < auds.length; i++) this.emit(this.buf.subarray(auds[i], auds[i + 1]));
    if (auds.length > 1) this.buf = Buffer.from(this.buf.subarray(auds[auds.length - 1]));
  }

  /** ScreenStream sends each frame whole, behind a 4-byte length, so it is passed on without waiting for the next. */
  private feedFramed(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let at = 0;
    while (this.buf.length - at >= 4) {
      const n = this.buf.readUInt32BE(at);
      if (this.buf.length - at - 4 < n) break;
      this.emit(this.buf.subarray(at + 4, at + 4 + n));
      at += 4 + n;
    }
    this.buf = at ? Buffer.from(this.buf.subarray(at)) : this.buf;
  }

  private emit(au: Buffer): void {
    let key = false;
    for (const [, payload] of nalStarts(au, 0)) {
      const type = au[payload] & 31;
      if (type === 5) key = true;
      if (type === 7) [this.width, this.height] = spsSize(au.subarray(payload + 1));
    }
    if (!this.width) return; // nothing decodable before the first SPS
    const frame = { data: Buffer.from(au), key, time: BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)) };
    if (key) this.gop = [];
    this.gop.push(frame);
    this.frames++;
    this.bytes += au.length;
    for (const sink of this.sinks) sink(frame);
  }
}

const video = new Video();

// ------------------------------------------------------------------------------------------ input

class PhoneError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function api(path: string, body?: unknown): Promise<Response> {
  const res = await fetch(API + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(65_000),
  }).catch((e: Error) => {
    throw new PhoneError(503, `iphone.py serve is unreachable: ${e.message}`);
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new PhoneError(res.status, detail.error ?? `HTTP ${res.status}`);
  }
  return res;
}

const UDID = (process.env.IPHONE_UDID ?? "00008110-000870C036EB801E").replace(/-/g, "").toLowerCase();

/** One usbmuxd request (binary header + XML plist) on a fresh socket; resolves with the reply's plist text. */
function usbmuxRequest(sock: net.Socket, fields: string): Promise<string> {
  const body = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${fields}` +
      "<key>ClientVersionString</key><string>iphone-relay</string><key>ProgName</key><string>iphone-relay</string></dict></plist>",
  );
  const head = Buffer.alloc(16);
  head.writeUInt32LE(16 + body.length, 0);
  head.writeUInt32LE(1, 4); // protocol version 1 (plist)
  head.writeUInt32LE(8, 8); // message type: plist
  head.writeUInt32LE(1, 12);
  sock.write(Buffer.concat([head, body]));
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4 || buf.length < buf.readUInt32LE(0)) return;
      sock.off("data", onData);
      sock.pause(); // keep what follows (the tunnel's first bytes) until the caller listens
      const size = buf.readUInt32LE(0);
      if (buf.length > size) sock.unshift(buf.subarray(size)); // the tunnel may start right away
      resolve(buf.subarray(16, size).toString());
    };
    sock.on("data", onData);
    sock.once("error", reject);
    sock.once("close", () => reject(new Error("usbmuxd closed the connection")));
  });
}

function usbmuxSocket(): Promise<net.Socket> {
  return new Promise((ok, fail) => {
    const sock = net.connect(process.env.RELAY_USBMUXD ?? "/var/run/usbmuxd");
    sock.once("connect", () => ok(sock));
    sock.once("error", fail);
  });
}

/** A TCP connection to `port` on the phone through usbmuxd, over USB only. */
async function usbmuxConnect(port: number): Promise<net.Socket> {
  const list = await usbmuxSocket();
  const devices = await usbmuxRequest(list, "<key>MessageType</key><string>ListDevices</string>").finally(() => list.destroy());
  let id: string | undefined;
  for (const [, props] of devices.matchAll(/<key>Properties<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)) {
    const field = (key: string) => new RegExp(`<key>${key}</key>\\s*<(?:string|integer)>([^<]*)<`).exec(props)?.[1];
    if (field("SerialNumber")?.replace(/-/g, "").toLowerCase() === UDID && field("ConnectionType") === "USB") id = field("DeviceID");
  }
  if (!id) throw new Error("the phone is not on USB");
  const sock = await usbmuxSocket();
  const portBE = ((port & 0xff) << 8) | (port >> 8); // usbmuxd wants the port in network byte order
  const reply = await usbmuxRequest(
    sock,
    `<key>MessageType</key><string>Connect</string><key>DeviceID</key><integer>${id}</integer>` +
      `<key>PortNumber</key><integer>${portBE}</integer>`,
  ).catch((e) => (sock.destroy(), Promise.reject(e)));
  const result = /<key>Number<\/key>\s*<integer>(\d+)</.exec(reply)?.[1];
  if (result !== "0") throw (sock.destroy(), new Error(`usbmuxd refused the connection (${result})`));
  sock.removeAllListeners("error");
  sock.removeAllListeners("close");
  return sock;
}

/** ScreenStream's socket: over USB first, since Wi-Fi power save delays the first packet after a still
 * screen by up to ~110 ms; else the phone's Wi-Fi IP. Rejects when no broadcast is running. Paused. */
async function connectStream(): Promise<{ sock: net.Socket; via: string }> {
  try {
    return { sock: await usbmuxConnect(STREAM_PORT), via: "USB" };
  } catch {
    const ip = await phoneIp();
    if (!ip) throw new Error("no phone IP");
    const sock = net.connect({ host: ip, port: STREAM_PORT, noDelay: true });
    await new Promise<void>((ok, fail) => {
      sock.setTimeout(3000, () => sock.destroy(new Error("timed out")));
      sock.once("connect", () => (sock.setTimeout(0), sock.pause(), ok()));
      sock.once("error", fail);
    });
    sock.removeAllListeners("error");
    return { sock, via: `Wi-Fi ${ip}` };
  }
}

/** The phone's Wi-Fi address, from WDA's status. */
async function phoneIp(): Promise<string | null> {
  try {
    const body = (await (await api("/status")).json()) as { value?: { status?: { ios?: { ip?: string } } } };
    return body.value?.status?.ios?.ip ?? null;
  } catch {
    return null;
  }
}

/** A request to WDA itself, not through `iphone.py serve`: over USB through usbmuxd when the phone is
 * plugged in, else at WDA_URL (`iphone.py up`'s forwarder). serve takes one request at a time, so a
 * viewer's touch would otherwise wait behind an agent's screenshot or UI tree. */
function wda(path: string, body: unknown): Promise<unknown> {
  const data = Buffer.from(JSON.stringify(body));
  const send = (opts: http.RequestOptions) =>
    new Promise<unknown>((resolve, reject) => {
      let connected = false;
      const req = http.request(
        { ...opts, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length }, timeout: 10_000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("close", () => {
            if (!res.complete) return reject(new Error("WDA closed the connection mid-answer"));
            let value: { error?: string; message?: string } | undefined;
            try {
              value = (JSON.parse(Buffer.concat(chunks).toString() || "{}") as { value?: typeof value }).value;
            } catch {
              return reject(new PhoneError(502, `not WDA: HTTP ${res.statusCode}`));
            }
            if (res.statusCode! >= 400 || value?.error) reject(new PhoneError(502, `${value?.error ?? res.statusCode}: ${value?.message ?? ""}`));
            else resolve(value);
          });
        },
      );
      req.on("socket", (s) => (s.connecting ? s.once("connect", () => (connected = true)) : (connected = true)));
      req.on("error", (e) => reject(Object.assign(e, { unreachable: !connected })));
      req.on("timeout", () => req.destroy(new Error("WDA timed out")));
      req.end(data);
    });
  let usb = false;
  return send({
    createConnection: ((_: unknown, done: (e: Error | null, s?: net.Socket) => void) => {
      usbmuxConnect(WDA_PORT).then((s) => ((usb = true), s.resume(), done(null, s)), (e) => done(e));
    }) as http.RequestOptions["createConnection"],
  }).catch((e) => {
    if (usb) throw e; // sent over USB already; sending it again could touch twice
    const saved = `${process.env.IPHONE_WDA_HOME ?? homedir() + "/.iphone-wda"}/wda_url`;
    const url = new URL(process.env.WDA_URL || (existsSync(saved) ? readFileSync(saved, "utf8").trim() : `http://127.0.0.1:${WDA_PORT}`));
    return send({ host: url.hostname.replace(/^\[|\]$/g, ""), port: url.port });
  });
}

let points: { width: number; height: number } | null = null; // the screen in points, which WDA's taps use
async function screen(): Promise<{ width: number; height: number }> {
  points ??= ((await (await api("/window")).json()) as { value: { width: number; height: number } }).value;
  return points;
}

// US layout for the viewer's physical keys: HID usage -> [plain, shifted].
const US: Record<number, [string, string]> = { 40: ["\n", "\n"], 42: ["\b", "\b"], 43: ["\t", "\t"], 44: [" ", " "] };
for (let i = 0; i < 26; i++) US[4 + i] = [String.fromCharCode(97 + i), String.fromCharCode(65 + i)];
"1!2@3#4$5%6^7&8*9(0)".match(/../g)!.forEach((p, i) => (US[30 + i] = [p[0], p[1]]));
"-_=+[{]}\\|".match(/../g)!.forEach((p, i) => (US[45 + i] = [p[0], p[1]]));
";:'\"`~,<.>/?".match(/../g)!.forEach((p, i) => (US[51 + i] = [p[0], p[1]]));
const HOME_KEY = 74; // the Home key presses the phone's Home button
const SHIFT = 0b00100010, OTHER_MODIFIERS = 0b11011101;

type Record16 = { type: number; code: number; value: number; x: number; y: number; modifiers: number };
function parseRecord(b: Buffer, at: number): Record16 {
  return {
    type: b[at],
    code: b.readUInt16BE(at + 2),
    value: b.readInt32BE(at + 4),
    x: b.readUInt16BE(at + 8) / 65535,
    y: b.readUInt16BE(at + 10) / 65535,
    modifiers: b.readUInt16BE(at + 14),
  };
}

/** 0 accepted, 1 invalid, 2 unsupported; mirrors the server-side validation of the wire protocol. */
function validate(r: Record16): number {
  if (r.type < 1 || r.type > 8) return 1;
  if ((r.type === 4 || r.type === 5) && (r.code < 1 || r.code > 3)) return 1;
  if (r.type === 6 && (r.code > 1 || r.value % 120 || Math.abs(r.value) > 1200)) return 1;
  if (r.type === 8 && (r.value < 1 || r.value > 0x10ffff || (r.value >= 0xd800 && r.value <= 0xdfff))) return 1;
  if ((r.type === 1 || r.type === 2) && r.code > 231) return 1;
  if (r.type === 1 && !(r.code in US) && r.code !== HOME_KEY && (r.code < 224 || r.code > 231)) return 2;
  if (r.type === 1 && r.modifiers & OTHER_MODIFIERS && r.code in US) return 2; // shortcuts have no iPhone meaning
  return 0;
}

/** Turns a stream of screen-relay input records into phone actions, one at a time, in order. */
class Input {
  private queue: Promise<void> = Promise.resolve();
  private down: { x: number; y: number; t: number }[] | null = null;
  private text = "";
  private wheel = { dy: 0, dx: 0, x: 0, y: 0 };

  /** Applies records in order; resolves when the phone has received every action they produce. */
  async apply(records: Record16[]): Promise<void> {
    const actions: Promise<unknown>[] = (this.batch = []);
    for (const r of records) this.record(r);
    this.flushText();
    this.flushWheel();
    await Promise.all(actions);
    await this.settle(); // answer once the touches are done, so a screenshot after it shows them
  }

  /** For live viewers, which send one record per message: typing and wheel turns are gathered for
   * 60 ms so a word becomes one type call and a flick one scroll. */
  stream(r: Record16): void {
    this.batch = [];
    this.record(r);
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.batch = [];
      this.flushText();
      this.flushWheel();
      Promise.all(this.batch).catch((e) => log(`input failed: ${e.message}`));
    }, 60);
    Promise.all(this.batch).catch((e) => log(`input failed: ${e.message}`));
  }

  private idle: NodeJS.Timeout | undefined;
  private batch: Promise<unknown>[] = [];
  private run(action: () => Promise<unknown>): void {
    const next = this.queue.then(action);
    this.queue = next.then(
      () => undefined,
      () => undefined, // a failed action fails its batch but must not block later input
    );
    this.batch.push(next);
  }

  private record(r: Record16): void {
    const now = performance.now();
    // Keep actions in order: a touch or a scroll first sends the text typed before it, and so on.
    const key = r.type === 1 && (r.code in US || r.code === HOME_KEY);
    if (r.type === 4 || r.type === 5 || r.type === 6 || (key && r.code === HOME_KEY)) this.flushText();
    if (r.type === 4 || r.type === 5 || r.type === 8 || key) this.flushWheel();
    switch (r.type) {
      case 3: // pointer move: part of a drag while the button is held
        if (this.down) {
          const last = this.down[this.down.length - 1];
          if (now - last.t >= 16 || Math.hypot(r.x - last.x, r.y - last.y) > 0.02) this.down.push({ x: r.x, y: r.y, t: now });
        }
        break;
      case 4:
        if (r.code === 1) this.down = [{ x: r.x, y: r.y, t: now }];
        break;
      case 5:
        if (r.code === 1 && this.down) {
          const path = [...this.down, { x: r.x, y: r.y, t: now }];
          this.down = null;
          this.run(() => this.touch(path));
        }
        break;
      case 6: // wheel: positive deltas scroll down, which a finger does by moving up
        if (r.code === 0) this.wheel.dy += r.value / 120;
        else this.wheel.dx += r.value / 120;
        Object.assign(this.wheel, { x: r.x, y: r.y });
        break;
      case 7:
        this.down = null;
        break;
      case 8:
        this.text += String.fromCodePoint(r.value);
        break;
      case 1:
        if (r.code === HOME_KEY) this.run(async () => (await this.settle(), api("/press", { button: "home" })));
        else if (r.code in US) this.text += US[r.code][r.modifiers & SHIFT ? 1 : 0];
        break;
    }
  }

  private flushText(): void {
    if (!this.text) return;
    const text = this.text;
    this.text = "";
    this.run(() => api("/type", { text })); // WDA queues typing behind the touches before it
  }

  private flushWheel(): void {
    const { dx, dy, x, y } = this.wheel;
    if (!dx && !dy) return;
    this.wheel = { dx: 0, dy: 0, x, y };
    this.run(async () => {
      const s = await screen();
      const step = 60; // points per notch
      const clamp = (v: number, max: number) => Math.max(8, Math.min(max - 8, v));
      const from = { x: x * s.width, y: y * s.height };
      const to = { x: clamp(from.x - dx * step, s.width), y: clamp(from.y - dy * step, s.height) };
      // A slow drag that pauses before lifting scrolls by the distance moved, without momentum.
      await this.send([[from.x, from.y, 0], [to.x, to.y, 250], [to.x, to.y, 350]]);
    });
  }

  private async touch(path: { x: number; y: number; t: number }[]): Promise<void> {
    const s = await screen();
    const t0 = path[0].t;
    const pts = path.map((p) => [p.x * s.width, p.y * s.height, p.t - t0]);
    const [x0, y0] = pts[0];
    const far = Math.max(...pts.map(([x, y]) => Math.hypot(x - x0, y - y0)));
    const held = pts[pts.length - 1][2];
    // A short hold: SpringBoard and most controls act when the finger lifts.
    if (far < 8 && held < 500) return this.send([[x0, y0, 0], [x0, y0, 40]]);
    // Keep at most 24 points of the path, always the first and the last.
    return this.send(pts.filter((_, i) => i === 0 || i === pts.length - 1 || i % Math.ceil(pts.length / 24) === 0));
  }

  /** WDA performs one gesture at a time and is busy for about 250 ms after each finger lifts. Touches go
   * to its queue at once ("wait": false), which sends them as soon as it can and queues typing behind
   * them; the hardware buttons, which bypass that queue, wait until the touches before them should be done. */
  private busyUntil = 0;
  private lastSent = 0;
  private direct = true; // false for a WDA without the queue (no /wda/touch): through serve instead
  private async send(points: number[][]): Promise<void> {
    // WDA merges touches that queue up and keeps up to 400 ms of the gaps between them.
    const now = performance.now();
    const after = this.busyUntil > now ? this.busyUntil + Math.min(now - this.lastSent, 400) : now;
    this.busyUntil = after + points[points.length - 1][2] + 260;
    this.lastSent = now;
    if (this.direct) {
      try {
        return void (await wda("/wda/touch", { points, wait: false }));
      } catch (e) {
        const err = e as Error & { unreachable?: boolean };
        if (/unknown command/.test(err.message)) this.direct = false;
        else if (!err.unreachable) throw e;
        // WDA did not get it: serve may still reach WDA (e.g. at a URL only it knows).
      }
    }
    await api("/gesture", { points });
  }

  private async settle(): Promise<void> {
    const wait = this.busyUntil - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

const input = new Input();

// ------------------------------------------------------------------------------------------ connections

let generation = 0;
// One input owner: a /stream viewer without ?view=1, /control, or a WebRTC viewer (/rtc).
type Controller = { open: () => boolean; kick: () => void };
let owner: Controller | null = null;

function takeInput(c: Controller, take: boolean): boolean {
  if (owner && owner !== c && owner.open()) {
    if (!take) return false;
    owner.kick();
  }
  owner = c;
  return true;
}

function wsController(ws: WebSocket): Controller {
  const c = { open: () => ws.readyState === WebSocket.OPEN, kick: () => ws.close(4001, "control taken") };
  ws.on("close", () => owner === c && (owner = null));
  return c;
}

function frameMessage(gen: number, seq: number, f: Frame): Buffer {
  const msg = Buffer.from(header(MESSAGE_TYPES.frame, gen, seq, 12 + f.data.length));
  if (f.key) msg.writeUInt16BE(1, 6);
  msg.writeUInt16BE(video.width, HEADER_SIZE);
  msg.writeUInt16BE(video.height, HEADER_SIZE + 2);
  msg.writeBigUInt64BE(f.time, HEADER_SIZE + 4);
  f.data.copy(msg, HEADER_SIZE + 12);
  return msg;
}

function streamViewer(ws: WebSocket, viewOnly: boolean, take: boolean): void {
  const me = wsController(ws);
  if (!viewOnly && !takeInput(me, take)) return ws.close(4003, "input is owned by another client");
  const gen = ++generation;
  let seq = 0;
  let needKey = true;
  const unacked: { seq: number; bytes: number; sent: number }[] = [];
  const behind = () =>
    (unacked.length > 0 && Date.now() - unacked[0].sent > MAX_LAG_MS) ||
    unacked.length >= MAX_UNACKED ||
    unacked.reduce((n, u) => n + u.bytes, 0) > MAX_UNACKED_BYTES;
  const send = (f: Frame) => {
    if (behind()) return void (needKey = true); // skip ahead to a fresh keyframe once it catches up
    if (needKey && !f.key) return video.requestKey();
    needKey = false;
    const msg = frameMessage(gen, ++seq, f);
    unacked.push({ seq, bytes: msg.length, sent: Date.now() });
    ws.send(msg);
  };
  // Start from the latest keyframe; a long group of pictures would replay seconds of old frames, so
  // a short one is replayed and otherwise a fresh keyframe is asked for.
  if (video.gop.length <= 10 || !video.keysOnRequest) for (const f of video.gop) send(f);
  else video.requestKey();
  const unwatch = video.watch(send);
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    try {
      if (!isBinary) throw new Error("text message");
      const h = parseHeader(data);
      if (h.generation !== gen) throw new Error("stale generation");
      if (h.type === MESSAGE_TYPES.ack) {
        while (unacked.length && unacked[0].seq <= h.sequence) unacked.shift();
        if (needKey && !behind()) video.requestKey();
      } else if (h.type === MESSAGE_TYPES.input && h.payloadLength === INPUT_SIZE && !viewOnly && owner === me) {
        const r = parseRecord(data, HEADER_SIZE);
        if (!validate(r)) input.stream(r);
      } else if (h.type !== MESSAGE_TYPES.input) throw new Error(`unexpected message type ${h.type}`);
    } catch (e) {
      ws.close(1002, (e as Error).message.slice(0, 100));
    }
  });
  ws.on("close", unwatch);
}

async function controlClient(ws: WebSocket, take: boolean): Promise<void> {
  if (!takeInput(wsController(ws), take)) return ws.close(4003, "input is owned by another client");
  const gen = ++generation;
  try {
    await screen();
  } catch (e) {
    return ws.close(1011, (e as Error).message.slice(0, 100));
  }
  if (!video.width) await new Promise<void>((resolve) => {
    const unwatch = video.watch(() => (unwatch(), resolve()));
    setTimeout(() => (unwatch(), resolve()), 5000);
  });
  const ready = Buffer.from(header(MESSAGE_TYPES.controlReady, gen, 0, 4));
  ready.writeUInt16BE(video.width || 750, HEADER_SIZE);
  ready.writeUInt16BE(video.height || 1334, HEADER_SIZE + 2);
  ws.send(ready);
  ws.on("message", async (data: Buffer, isBinary: boolean) => {
    let h;
    try {
      if (!isBinary) throw new Error("text message");
      h = parseHeader(data);
      if (h.type !== MESSAGE_TYPES.input || h.payloadLength !== INPUT_SIZE || !h.sequence || h.generation !== gen) throw new Error("bad input");
    } catch (e) {
      return ws.close(1002, (e as Error).message);
    }
    const r = parseRecord(data, HEADER_SIZE);
    let status = validate(r);
    if (!status) await input.apply([r]).catch((e) => log(`input failed: ${e.message}`));
    const reply = Buffer.from(header(MESSAGE_TYPES.inputResponse, gen, h.sequence, 1));
    reply[HEADER_SIZE] = status;
    if (ws.readyState === WebSocket.OPEN) ws.send(reply);
  });
}

// ------------------------------------------------------------------------------------------ WebRTC

const ICE_SERVERS = (process.env.RELAY_STUN ?? "stun:stun.l.google.com:19302").split(",").filter(Boolean).map((urls) => ({ urls }));

/**
 * A WebRTC viewer: the page signals over the /rtc WebSocket (through serve, so behind the login), then
 * video and input go peer to peer over UDP instead of through the Cloudflare tunnel, where one slow TCP
 * segment holds up every frame behind it. ScreenStream's frames are sent as they come, without
 * re-encoding; a lost frame costs a keyframe, which the browser asks for (PLI) and ScreenStream encodes
 * at once. Input arrives on the "input" data channel as screen-relay input records in JSON.
 *
 * Messages on the WebSocket: relay -> page {offer}, page -> relay {answer}; the relay closes it with
 * 4001 when another viewer takes control and 4003 when another one has it and this one did not take it.
 */
async function rtcViewer(ws: WebSocket, viewOnly: boolean, take: boolean): Promise<void> {
  const me = wsController(ws);
  if (!viewOnly && !takeInput(me, take)) return ws.close(4003, "input is owned by another client");
  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/H264",
          clockRate: 90000,
          rtcpFeedback: [useNACK(), usePLI()],
          parameters: "profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1",
        }),
      ],
    },
  });
  const track = new MediaStreamTrack({ kind: "video" });
  const { sender } = pc.addTransceiver(track, { direction: "sendonly" });
  const channel = pc.createDataChannel("input");
  const packetizer = new H264Packetizer({ inputFormat: "annexb" });
  let live = false, needKey = true, unwatch = () => {};
  const send = (f: Frame) => {
    if (!live) return;
    if (needKey && !f.key) return video.requestKey();
    needKey = false;
    // Drop the access unit delimiter; RTP marks frame boundaries itself.
    const [, after] = nalStarts(f.data, 0).next().value ?? [0, 0];
    const au = (f.data[after] & 31) === 9 ? f.data.subarray(nalStarts(f.data, after).next().value?.[0] ?? 0) : f.data;
    for (const packet of packetizer.packetize(au, Number((f.time * 9n) / 100n) >>> 0)) track.writeRtp(packet);
  };
  sender.onPictureLossIndication.subscribe(() => ((needKey = true), video.requestKey()));
  pc.connectionStateChange.subscribe((state) => {
    log(`webrtc: ${state}`);
    if (state === "connected" && !live) {
      live = true;
      video.requestKey();
      unwatch = video.watch(send);
    }
    if (state === "failed" || state === "closed") ws.close(1011, "webrtc " + state);
  });
  channel.onMessage.subscribe((data) => {
    if (viewOnly || owner !== me) return;
    try {
      const r = JSON.parse(String(data)) as Record16;
      const fields = ["type", "code", "value", "x", "y", "modifiers"] as const;
      if (fields.some((k) => typeof r[k] !== "number" || !Number.isFinite(r[k]))) return;
      r.x = Math.min(1, Math.max(0, r.x));
      r.y = Math.min(1, Math.max(0, r.y));
      if (!validate(r)) input.stream(r);
    } catch {
      // not an input record
    }
  });
  // Nothing else crosses this WebSocket once connected, and Cloudflare closes idle ones after 100 s.
  const keepalive = setInterval(() => ws.ping(), 30_000);
  ws.on("close", () => {
    clearInterval(keepalive);
    live = false;
    unwatch();
    void pc.close();
  });
  ws.on("message", async (data: Buffer) => {
    try {
      const msg = JSON.parse(String(data)) as { answer?: { type: "answer"; sdp: string } };
      if (msg.answer) await pc.setRemoteDescription(msg.answer);
    } catch (e) {
      ws.close(1002, (e as Error).message.slice(0, 100));
    }
  });
  await pc.setLocalDescription(await pc.createOffer());
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ offer: pc.localDescription }));
}

// ------------------------------------------------------------------------------------------ HTTP

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length, "Cache-Control": "no-store" });
  res.end(data);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const [path, query = ""] = (req.url ?? "/").split("?");
  // The page is the WebRTC viewer; screen-relay's WebSocket viewer stays at ?ws=1.
  const viewer = path === "/" && !query.split("&").includes("ws=1") ? (["text/html; charset=utf-8", rtcPage] as const) : VIEWER[path];
  if (req.method === "GET" && viewer) {
    res.writeHead(200, {
      "Content-Type": viewer[0],
      "Content-Length": viewer[1].length,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    });
    return void res.end(viewer[1]);
  }
  if (req.method === "GET" && path === "/capabilities") {
    return json(res, 200, {
      version: 1,
      backend: "iphone",
      width: video.width || 750,
      height: video.height || 1334,
      fps: FPS,
      input: { keyboard: true, pointer: true, buttons: true, wheel: true },
      screenshot: "/screenshot.png",
      control: "/control",
      wayland: false,
      max_input_pending: 1024,
      input_endpoint: "/input",
      max_input_batch: MAX_INPUT_BATCH,
      cursor: false,
      audio: false,
      clipboard: false,
      resize: false,
      ime: false,
    });
  }
  if (req.method === "GET" && path === "/metrics") {
    const usage = process.cpuUsage();
    return json(res, 200, {
      frames_encoded: video.frames,
      bytes_sent: video.bytes,
      usage_usec: usage.user + usage.system,
      memory_current: process.memoryUsage().rss,
      inactive_file: 0,
    });
  }
  if (req.method === "GET" && path === "/screenshot.png") {
    try {
      const png = Buffer.from(await (await api("/screenshot?pixels=1")).arrayBuffer());
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "no-store" });
      return void res.end(png);
    } catch (e) {
      return json(res, 503, { error: "screenshot_unavailable", message: (e as Error).message });
    }
  }
  if (req.method === "POST" && path === "/input") {
    if (owner && owner.open()) return json(res, 409, { error: "busy", applied: 0 });
    const length = Number(req.headers["content-length"]);
    if (!Number.isInteger(length)) return json(res, 411, { error: "length_required" });
    if (length > MAX_INPUT_BATCH * INPUT_SIZE) return json(res, 413, { error: "too_large" });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    if (!body.length || body.length !== length || body.length % INPUT_SIZE) return json(res, 400, { error: "invalid_input" });
    const records: Record16[] = [];
    for (let at = 0; at < body.length; at += INPUT_SIZE) {
      const r = parseRecord(body, at);
      const status = validate(r);
      if (status) {
        await input.apply(records).catch(() => undefined);
        return json(res, status === 2 ? 422 : 400, { error: status === 2 ? "unsupported_input" : "invalid_input", index: records.length });
      }
      records.push(r);
    }
    try {
      await input.apply(records);
      return json(res, 200, { applied: records.length });
    } catch (e) {
      return json(res, 502, { error: "backend_failed", message: (e as Error).message });
    }
  }
  if (path === "/clipboard") return json(res, 404, { error: "clipboard_unavailable" });
  return json(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log(`HTTP ${req.url}: ${e.stack ?? e}`);
    if (!res.headersSent) json(res, 500, { error: "internal" });
  });
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: HEADER_SIZE + INPUT_SIZE,
  handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
});
const rtcWss = new WebSocketServer({ noServer: true, maxPayload: 64 << 10 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://relay");
  if (url.pathname === "/rtc") {
    return rtcWss.handleUpgrade(req, socket, head, (ws) => {
      rtcViewer(ws, url.searchParams.get("view") === "1", url.searchParams.get("take") === "1").catch((e) => {
        log(`webrtc: ${e.stack ?? e}`);
        ws.close(1011, "webrtc setup failed");
      });
    });
  }
  if (url.pathname !== "/stream" && url.pathname !== "/control") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (ws.protocol !== SUBPROTOCOL) return ws.close(1002, "nsl1 subprotocol required");
    const take = url.searchParams.get("take") === "1";
    if (url.pathname === "/control") void controlClient(ws, take);
    else streamViewer(ws, url.searchParams.get("view") === "1", take);
  });
});

server.listen(PORT, "127.0.0.1", () => log(`screen-relay engine for the iPhone on 127.0.0.1:${PORT}`));
