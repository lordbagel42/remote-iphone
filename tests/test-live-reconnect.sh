#!/bin/bash
# With the live page open in agent-browser, kill and restart the fake MJPEG stream and watch the page state.
cd "$(dirname "$0")/.."
S="--session iw-01a20c90"
st() { agent-browser $S eval 'document.getElementById("state").textContent'; }
echo "before: $(st)"
for p in $(pgrep -f fake-mjpeg.py); do kill "$p"; done
sleep 4; echo "stream killed: $(st)"
(uv run -q --with pillow python tests/fake-mjpeg.py 19100 >/tmp/fm.log 2>&1 &)
sleep 8; echo "stream back: $(st)"
agent-browser $S screenshot "$PWD/.amp/in/artifacts/live-reconnected.png" >/dev/null
