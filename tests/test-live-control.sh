#!/bin/bash
# Live page control test: fake WDA + fake MJPEG + serve, drive the page with agent-browser, check WDA calls.
cd "$(dirname "$0")/.."
B=tests
S="--session iw-01a20c90"
for n in "iphone.py serve" fake-wda.py fake-mjpeg.py; do for p in $(pgrep -f "$n"); do [ "$p" != $$ ] && kill "$p" 2>/dev/null; done; done
(uv run -q --with pillow python $B/fake-wda.py 18100 >/tmp/fw.log 2>&1 &)
(uv run -q --with pillow python $B/fake-mjpeg.py 19100 >/tmp/fm.log 2>&1 &)
sleep 4
(WDA_URL=http://127.0.0.1:18100 WDA_MJPEG_PORT=19100 IPHONE_VIEW_PASSWORD=correct-horse IPHONE_PUBLIC_URL=http://127.0.0.1:18200 \
  host/iphone.py serve --port 18200 >/tmp/serve5.log 2>&1 &)
sleep 6
U=http://127.0.0.1:18200
C=$(curl -s -D - -o /dev/null -d password=correct-horse $U/login | grep -i '^set-cookie' | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//')
echo "cookie POST, foreign Origin: $(curl -s -o /dev/null -w %{http_code} -H "Cookie: $C" -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}' $U/home)"
echo "cookie POST, no Origin: $(curl -s -o /dev/null -w %{http_code} -H "Cookie: $C" -H 'Content-Type: application/json' -d '{}' $U/home)"
echo "no cookie POST, right Origin: $(curl -s -o /dev/null -w %{http_code} -H "Origin: $U" -H 'Content-Type: application/json' -d '{}' $U/home)"
agent-browser $S open $U/ >/dev/null
agent-browser $S set viewport 1000 1100 2 >/dev/null
agent-browser $S fill 'input[name=password]' correct-horse >/dev/null
agent-browser $S click 'button' >/dev/null
agent-browser $S open $U/mjpeg >/dev/null
sleep 3
curl -s -X POST $U/calls >/dev/null  # no-op
# image box -> click at 50%/25% (expect tap ~ (187,167)), drag from 50%/80% to 50%/30% (swipe up)
read X Y W H < <(agent-browser $S eval 'const r=document.getElementById("screen").getBoundingClientRect(); [r.x,r.y,r.width,r.height].join(" ")' | tr -d '"')
cx=$(python3 -c "print(round($X+$W*0.5))"); cy=$(python3 -c "print(round($Y+$H*0.25))")
agent-browser $S mouse move $cx $cy >/dev/null; agent-browser $S mouse down >/dev/null; agent-browser $S mouse up >/dev/null
sleep 0.2; agent-browser $S screenshot "$PWD/.amp/in/artifacts/live-control-tap.png" >/dev/null
sy=$(python3 -c "print(round($Y+$H*0.8))"); ey=$(python3 -c "print(round($Y+$H*0.3))")
agent-browser $S mouse move $cx $sy >/dev/null; agent-browser $S mouse down >/dev/null
for f in 0.7 0.6 0.5 0.4; do agent-browser $S mouse move $cx $(python3 -c "print(round($Y+$H*$f))") >/dev/null; done
agent-browser $S mouse move $cx $ey >/dev/null; agent-browser $S mouse up >/dev/null
agent-browser $S click 'button[data-press=home]' >/dev/null
agent-browser $S fill '#text' 'hello' >/dev/null
agent-browser $S press Enter >/dev/null
agent-browser $S click '#enter' >/dev/null
sleep 1
agent-browser $S screenshot "$PWD/.amp/in/artifacts/live-control.png" >/dev/null
curl -s http://127.0.0.1:18100/calls | python3 -c '
import json,sys
for path, body in json.load(sys.stdin)["value"]:
    if "/session" == path: continue
    print(path.split("/S1",1)[-1], json.dumps(body))'
