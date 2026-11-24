#!/bin/bash
# With the live page open, stop the fake WDA and click Home: the page should show the error, then clean up.
cd "$(dirname "$0")/.."
S="--session iw-01a20c90"
for p in $(pgrep -f fake-wda.py); do kill "$p"; done
sleep 1
agent-browser $S click 'button[data-press=home]' >/dev/null
sleep 1.5
echo "error shown: $(agent-browser $S eval 'document.getElementById("err").textContent')"
agent-browser $S screenshot "$PWD/.amp/in/artifacts/live-control-error.png" >/dev/null
agent-browser $S close >/dev/null
for n in "iphone.py serve" fake-mjpeg.py; do for p in $(pgrep -f "$n"); do [ "$p" != $$ ] && kill "$p" 2>/dev/null; done; done
echo cleaned
