# Wireless WebDriverAgent for iPhone SE (3rd gen), iOS 18.3.1

Agents drive the phone over Wi‑Fi through WebDriverAgent (WDA). The host Mac needs no Xcode:
only `uv`/Python (`pymobiledevice3`) and a patched `plumesign` (the CLI half of Impactor).

```
agent ──MCP/CLI──▶ host/iphone.py ──HTTP :8100 (LAN)──▶ WDA on iPhone
                         │
                         └─ pymobiledevice3: tunneld (Wi‑Fi tunnel) ─▶ DDI mount + XCUITest launch
```

## What's in here

| Path | What |
|---|---|
| `dist/WebDriverAgentRunner.ipa` | Unsigned WDA runner, appium/WebDriverAgent v16.15.3, arm64, Xcode 16.4 (iOS 18.4 SDK), min iOS 13 |
| `dist/plumesign` | Impactor v2.7.3 CLI + `vm/impactor-sign-xctest.patch`, arm64 macOS |
| `vm/build-wda-ipa.sh` | Builds the IPA on a Mac with Xcode (the VM) |
| `vm/build-plumesign.sh` | Builds the patched `plumesign` (needs Rust only) |
| `host/install-wda.sh` | Signs the IPA with your Apple Account and installs it (also the 7‑day re‑sign) |
| `host/iphone.py` | `setup` / `up` (start + reconnect supervisor) / CLI actions / `mcp` server |
| `host/install-services.sh` | launchd jobs for `tunneld` (root) and `iphone.py up` (you) |
| `host/mcp.json` | MCP client config |
| `executor-app/` | Executor app "iPhone" that wraps the `serve` API for agents anywhere |
| `tests/` | Fake WDA, MJPEG, tunneld and pymobiledevice3, and the scripts that test `up` and `serve` against them |

The binaries in `dist/` aren't in Git. Download them from the
[v0.1.0 release](https://github.com/lordbagel42/remote-iphone/releases/tag/v0.1.0) and check them
against `dist/SHA256SUMS`: `gh release download v0.1.0 -D dist && (cd dist && shasum -a 256 -c SHA256SUMS)`.

## Why Impactor needs a patch

Impactor 2.7.3 signs `.app`, `.appex`, `.framework` and `.dylib`, but treats
`PlugIns/WebDriverAgentRunner.xctest` as an unknown bundle and leaves it **unsigned**. Signed that way,
the runner installs but iOS refuses to load the test bundle, so WDA never starts. The one‑line patch
signs `.xctest` like a framework: your certificate, no profile, no entitlements (what Xcode does).
`plumesign` shares `~/.config/PlumeImpactor` with Impactor.app, so it reuses your existing login and
certificate. Don't install the IPA with the Impactor.app GUI.

## Bundle ID and entitlements

- Runner: installed as `dev.raygen.WebDriverAgentRunner.xctrunner` (override with `WDA_BUNDLE_ID`).
  Free‑account App IDs must be globally unique, so the `com.facebook.` prefix can't be used.
  It costs one App ID of the free account's 10 per 7 days; re‑signing reuses it.
- Test bundle: keeps `com.facebook.WebDriverAgentRunner`; it's signed without a profile, so it
  doesn't need an App ID.
- Entitlements: nothing extra. The development profile's defaults (`application-identifier`,
  `com.apple.developer.team-identifier`, `get-task-allow`, `keychain-access-groups`) are all
  XCTest needs.
- The IPA leaves out the XCTest frameworks Xcode copies into `Runner.app/Frameworks/`, as appium's
  own real‑device build does. On iOS 17+ the runner loads them from the mounted Developer Disk Image
  (`/System/Developer/Library/Frameworks`), so they always match the phone's iOS.

## One‑time setup

On the **build VM** (only needed to rebuild; the outputs are in `dist/`):

```sh
vm/build-wda-ipa.sh          # → dist/WebDriverAgentRunner.ipa   (XCODE=/Applications/Xcode_16.4.app)
vm/build-plumesign.sh        # → dist/plumesign
```

On the **host Mac**, with the iPhone plugged in by USB and unlocked:

1. Install tools:
   ```sh
   brew install uv     # if missing
   uv tool install --python 3.13 pymobiledevice3==11.63.1
   xattr -dr com.apple.quarantine ~/iphone-wda      # wherever you put this folder
   ```
2. Pair, turn on Developer Mode and Wi‑Fi connections, and mount the Developer Disk Image:
   ```sh
   host/iphone.py setup
   ```
   Tap **Trust** and enter the passcode if the phone asks. If Developer Mode is off, the script
   shows its switch: **Settings › Privacy & Security › Developer Mode › On**, restart, tap
   **Turn On**, then run `setup` again.
3. Install WDA:
   ```sh
   host/install-wda.sh
   ```
   Then on the phone: **Settings › General › VPN & Device Management ›** your Apple Account **› Trust**.
4. On the phone:
   - **Settings › Developer › Enable UI Automation**: On. (The Developer menu appears once the
     Developer Disk Image is mounted.)
   - **Settings › Display & Brightness › Auto‑Lock**: Never.
   - Keep it on the same Wi‑Fi as the Mac, and on a charger while agents use it.
5. Start the services, then unplug USB:
   ```sh
   host/install-services.sh     # asks for sudo once (tunneld runs as root)
   tail -f ~/.iphone-wda/up.log  # wait for "WDA ready at http://<iphone-ip>:8100"
   ```
   Without launchd: `sudo pymobiledevice3 remote tunneld` in one terminal and `host/iphone.py up` in another.
6. Check it:
   ```sh
   curl http://<iphone-ip>:8100/status
   host/iphone.py ui
   host/iphone.py screenshot -o shot.png
   host/iphone.py tap General
   ```
7. Give agents the MCP server: add `host/mcp.json` to your MCP client (fix the path), e.g. Amp's
   `amp.mcpServers` setting or Claude Code's `claude mcp add iphone -- uv run --quiet --script $PWD/host/iphone.py mcp`.

## Agent interface

MCP tools (and the same CLI subcommands):

| Tool | CLI | Notes |
|---|---|---|
| `screenshot` | `screenshot [-o f.png] [--pixels]` | Scaled to screen points (375×667), so image pixels = tap coordinates |
| `ui_tree` | `ui [--format compact\|xml\|json\|description]` | `compact`: visible text and controls with their tap point |
| `tap` | `tap X Y` or `tap "Label"` | By coordinates, or by exact label/name/value |
| `swipe` | `swipe X1 Y1 X2 Y2 [--duration s]` | Scroll down = swipe upward |
| `type_text` | `type "text"` | Into the focused field; `\n` for return |
| `press_button` | `press home\|volumeup\|volumedown\|lock\|unlock` | |
| `launch_app` | `launch BUNDLE_ID [--restart]` | e.g. `com.apple.Preferences`, `com.apple.mobilesafari` |
| `go_home` | `home` | |
| `status` | `status` | WDA status and the frontmost app |
| `start_recording` / `stop_recording` | | Screen video as an MP4 (needs ffmpeg); stop returns its local path |

The WDA URL comes from `--wda`, `$WDA_URL`, or what `up` last saved in `~/.iphone-wda/wda_url`.

`up --listen 8100` (or `WDA_LISTEN=8100`) also serves WDA on that port of the launcher host, wherever
WDA currently answers, so LAN agents use `http://<launcher-host>:8100` and never need the phone's IP.

`serve` is a token-protected HTTP API for agents outside the LAN (put an HTTPS tunnel in front of it).
It needs `IPHONE_API_TOKEN` (32+ characters) and `IPHONE_PUBLIC_URL`, and talks to WDA through
`WDA_URL`. Every request except screenshot links needs `Authorization: Bearer <token>`:

| Request | Body / query | Returns |
|---|---|---|
| `GET /status` | | WDA status and frontmost app |
| `GET /ui` | `?format=compact\|xml\|json\|description` | accessibility tree (text) |
| `GET /screenshot` | `?pixels=1` for full-size PNG | JPEG in screen points |
| `POST /screenshot/link` | | `{url, width, height}`: an unauthenticated JPEG link valid 10 minutes |
| `POST /tap` | `{x, y}` or `{text}` | |
| `POST /swipe` | `{from_x, from_y, to_x, to_y, duration?}` | |
| `POST /type` | `{text}` | |
| `POST /press` | `{button}` | home, volumeup, volumedown, lock, unlock |
| `POST /launch` | `{bundle_id, restart?}` | |
| `POST /home` | | |
| `POST /recording/start` | `{max_seconds?}` (default 300, at most 1800) | starts recording the screen; 422 if one is running |
| `POST /recording/stop` | | `{url, seconds, bytes, expires_in}`: an unauthenticated MP4 link valid 1 hour |
| `GET /recording` | | `{recording, elapsed?, max_seconds?}` |
| `POST /bug` | `{title, description?, steps?, expected?, actual?, reporter?}` | sends a bug report with the phone's state to the maintaining Amp thread (`IPHONE_BUG_WEBHOOK_URL`) |

Errors are `{ok: false, error}` with 400 (bad input), 401, 422 (WDA refused, e.g. no such element)
or 503 (WDA not running).

With `IPHONE_VIEW_PASSWORD` set, `serve` also shows a live view of the screen at `/`: a password
page, then WDA's MJPEG stream (relayed from port `WDA_MJPEG_PORT`, default 9100, on the `WDA_URL`
host; `up --listen-mjpeg 9100` provides it). Login sets a 30‑day HttpOnly cookie. The page reopens
the stream when it stalls or WDA restarts. On the page, click to tap, drag to swipe, hold to long
press, use the Home/Wake/Lock/volume buttons, and type into the focused field. The login cookie
authorizes those API calls only when they come from the page itself (matching `Origin`).

Taps from the page and the relay send `"fast": true`: a W3C touch sent at once, instead of XCTest's
tap, which first waits about a second for the app to idle. Agents' taps keep XCTest's waiting tap.
`POST /gesture {"points": [[x, y, ms], …]}` replays one finger along a path.

### Screen recordings

`POST /recording/start` (the Executor app's `start_recording`) runs ffmpeg on WDA's MJPEG stream,
encoding H.264 at screen-point size (374×666) as fast as WDA sends frames (about 28 fps). Agents keep
driving the phone meanwhile. `POST /recording/stop` finishes the MP4 and returns a link that works for
an hour; the recording also ends by itself after `max_seconds`, and stop still collects it. One
recording runs at a time. Files live in a private folder under `$TMPDIR` that `serve` deletes when it exits.

### screen-relay (H.264)

`relay/relay.ts` is a [screen-relay](https://www.npmjs.com/package/screen-relay) engine for the
phone. It transcodes WDA's MJPEG stream to H.264 with ffmpeg and
speaks screen-relay's `nsl1` protocol, so screen-relay's own viewer, CLI and Node SDK drive the
phone. Clicks become taps, drags become gestures, the wheel scrolls, keys and text type, and the
Home key presses the Home button. It listens on `127.0.0.1:8300` without authentication; `serve`
forwards screen-relay's paths to it after the same cookie or token checks, and `/relay` is the viewer.

```sh
cd relay && pnpm install && IPHONE_API_TOKEN=… node relay.ts     # Node 23.6 or newer, and ffmpeg
npx screen-relay click 0.5 0.25 --url https://iphone.example.com --token-file token   # the API token
```

### Bug reports

`POST /bug` (the Executor app's `report_bug` tool) forwards a report, plus WDA's status and the
frontmost app, to an Amp webhook. `amp-plugin/iphone-bug-report.ts`, loaded as a plugin in the Amp
thread that maintains this toolkit, registers that webhook and posts each report into the thread
as a message, and the agent there fixes the bug. The plugin writes the webhook URL to
`~/.config/iphone-bug-report/webhook-url` (0600); put it in `serve`'s environment as
`IPHONE_BUG_WEBHOOK_URL`. The URL is a credential.

## How `up` recovers

`iphone.py up` loops forever: wait for `tunneld` to have a tunnel to the phone (Wi‑Fi via
bonjour/mobdev2, or USB) → mount the DDI if needed (after every reboot) → find the installed runner →
run `pymobiledevice3 developer dvt xcuitest <runner>` → wait for `/status` → poll it every 10 s.
When the XCUITest process exits or WDA misses 3 polls (phone rebooted, left Wi‑Fi, runner killed),
it stops the old process and starts over 5 s later. The 10‑second poll also keeps the phone's Wi‑Fi
from dozing.

## Keeping it alive

- **Auto‑Lock Never** and a charger. A locked phone keeps WDA running, but taps hit the lock screen.
  `press unlock` only wakes it; with a passcode set, a person must enter it (or turn the passcode off
  on this test phone).
- **Same LAN.** mobdev2 discovery is bonjour, so the phone and the Mac must share a subnet. Nothing
  else (no VPN, no cloud service) is involved. WDA has no authentication, so don't expose port 8100
  beyond the LAN.
- **Phone reboots** need one unlock before Wi‑Fi pairing services come back; `up` then remounts the
  DDI and restarts WDA on its own.
- Swiping WDA away in the app switcher stops it; `up` relaunches it within ~30 s.

## 7‑day re‑signing (free Apple Account)

The profile expires after 7 days and the runner stops launching. Re‑run:

```sh
host/install-wda.sh
```

Plug in USB for it: `plumesign` finds the phone through usbmuxd, which may also list it over Wi‑Fi,
but that's untested. To make it hands‑off, add a
weekly launchd job or cron entry that runs it (every 6 days). A paid Developer account makes the
profile last a year.

## Verified so far, and what isn't

Verified in the macOS VM:
- `vm/build-wda-ipa.sh` builds the device IPA and a simulator build with Xcode 16.4.
- The IPA: arm64 runner and test bundle, `PlugIns/WebDriverAgentRunner.xctest/Frameworks/WebDriverAgentLib.framework` present, top‑level `Frameworks/` removed.
- Stock Impactor 2.7.3 signing leaves the `.xctest` unsigned; the patched `plumesign` signs it.
- The same WDA source on an iOS 18.6 iPhone SE (3rd gen) simulator: every CLI command and every MCP
  tool (status, ui tree, tap by text and by point, swipe, type, home, launch, screenshot) worked,
  and errors came back as messages.
- `up` against a fake `pymobiledevice3` and `tunneld`: it finds the runner by executable name, passes
  the expected `xcuitest` arguments, relaunches when XCUITest exits, and stops it on SIGTERM.

Not verified (no physical iPhone reaches the VM): installing on the phone, `tunneld` over Wi‑Fi to
iOS 18.3.1, DDI mounting, and launching the runner with `pymobiledevice3 developer dvt xcuitest`.
Run steps 2–6 above to verify them; `~/.iphone-wda/xcuitest.log` shows why a launch fails (it keeps the last 5–10 MB).
