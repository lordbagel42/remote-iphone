#!/bin/bash
# The relay's video source: ScreenStream over (fake) usbmuxd first, then over the phone's Wi-Fi IP, then
# WDA's MJPEG through ffmpeg, switching to ScreenStream once a broadcast starts. Fakes only.
cd "$(dirname "$0")/.."
B=tests
T=/tmp/ss-test
TOKEN=$(head -c 32 /dev/urandom | xxd -p -c 64)
kill_all() { for n in "iphone.py serve" fake-wda.py fake-mjpeg.py fake-screenstream.py fake-usbmuxd.py relay.ts; do
  for p in $(pgrep -f "$n"); do [ "$p" != $$ ] && kill "$p" 2>/dev/null; done; done; sleep 1; }
kill_all
mkdir -p $T
ffmpeg -v error -y -f lavfi -i testsrc2=size=750x1334:rate=60 -t 4 -c:v libx264 -profile:v baseline -pix_fmt yuv420p \
  -x264-params aud=1:keyint=60 -f h264 $T/stream.h264
(FAKE_IP=127.0.0.1 uv run -q --with pillow python $B/fake-wda.py 18100 >/tmp/fw.log 2>&1 &)
(uv run -q --with pillow python $B/fake-mjpeg.py 19100 375 667 >/tmp/fm.log 2>&1 &)
(IPHONE_API_TOKEN=$TOKEN WDA_URL=http://127.0.0.1:18100 WDA_MJPEG_PORT=19100 host/iphone.py serve --port 18200 >/tmp/serve-ss.log 2>&1 &)
relay() {  # $1: extra env
  for p in $(pgrep -f relay.ts); do kill "$p"; done; sleep 0.5
  (cd relay && env $1 IPHONE_API_TOKEN=$TOKEN IPHONE_API=http://127.0.0.1:18200 RELAY_PORT=18300 RELAY_STREAM_PORT=18400 \
    RELAY_MJPEG_URL=http://127.0.0.1:19100 RELAY_USBMUXD=$T/usbmuxd.sock node relay.ts >$T/relay.log 2>&1 &)
  sleep 2
}
watch() {  # a viewer for $1 seconds; prints the frames it got and the first frame's delay
  node -e '
    const { WebSocket } = require("./relay/node_modules/ws");
    const ws = new WebSocket("ws://127.0.0.1:18300/stream?view=1", "nsl1");
    const t0 = Date.now(); let n = 0, first = 0;
    ws.on("message", (d) => { if (d.length > 200) { n++; first ||= Date.now() - t0; } });
    setTimeout(() => { console.log(`viewer: ${n} video messages in '$1' s, first after ${first} ms`); process.exit(0); }, '$1' * 1000);'
}
sleep 5

echo "== 1. ScreenStream over USB (fake usbmuxd)"
(python3 $B/fake-usbmuxd.py $T/usbmuxd.sock 00008110-000870C036EB801E >/tmp/fu.log 2>&1 &)
(python3 $B/fake-screenstream.py 18400 $T/stream.h264 >/tmp/fs.log 2>&1 &)
relay; watch 3; grep "video:" $T/relay.log
echo "metrics: $(curl -s 127.0.0.1:18300/metrics)"

echo "== 2. No usbmuxd: ScreenStream over Wi-Fi (the IP from WDA's status)"
for p in $(pgrep -f fake-usbmuxd.py); do kill "$p"; done
relay; watch 3; grep "video:" $T/relay.log

echo "== 3. No broadcast: MJPEG through ffmpeg, then ScreenStream once it starts"
for p in $(pgrep -f fake-screenstream.py); do kill "$p"; done
relay; watch 4; grep "video:" $T/relay.log
(python3 $B/fake-screenstream.py 18400 $T/stream.h264 >/tmp/fs.log 2>&1 &)
watch 14; grep "video:" $T/relay.log; echo "ffmpeg still running: $(pgrep -fc 'ffmpeg -hide_banner')"
kill_all
