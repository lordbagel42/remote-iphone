#!/bin/bash
# The screen-relay engine (relay/relay.ts) behind `serve`, with a fake WDA and MJPEG stream:
# auth on the forwarded paths, screen-relay's CLI driving the fake phone, and the viewer in a browser.
cd "$(dirname "$0")/.."
B=tests
S="--session iw-01a20c90"
U=http://127.0.0.1:18200
TOKEN=$(head -c 32 /dev/urandom | xxd -p -c 64)
for n in "iphone.py serve" fake-wda.py fake-mjpeg.py relay.ts; do for p in $(pgrep -f "$n"); do [ "$p" != $$ ] && kill "$p" 2>/dev/null; done; done
sleep 1
(uv run -q --with pillow python $B/fake-wda.py 18100 >/tmp/fw.log 2>&1 &)
(uv run -q --with pillow python $B/fake-mjpeg.py 19100 >/tmp/fm.log 2>&1 &)
(IPHONE_API_TOKEN=$TOKEN WDA_URL=http://127.0.0.1:18100 WDA_MJPEG_PORT=19100 RELAY_PORT=18300 IPHONE_VIEW_PASSWORD=correct-horse \
  IPHONE_PUBLIC_URL=$U host/iphone.py serve --port 18200 >/tmp/serve-relay.log 2>&1 &)
(cd relay && IPHONE_API_TOKEN=$TOKEN IPHONE_API=$U RELAY_PORT=18300 RELAY_MJPEG_URL=http://127.0.0.1:19100 node relay.ts >/tmp/relay.log 2>&1 &)
sleep 7
C=$(curl -s -D - -o /dev/null -d password=correct-horse $U/login | grep -i '^set-cookie' | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//')
echo "capabilities, no auth: $(curl -s -o /dev/null -w %{http_code} $U/capabilities)"
echo "capabilities, token: $(curl -s -H "Authorization: Bearer $TOKEN" $U/capabilities | head -c 80)"
echo "capabilities, cookie: $(curl -s -o /dev/null -w %{http_code} -H "Cookie: $C" $U/capabilities)"
echo "/relay, no auth: $(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' $U/relay)"
echo "/relay, cookie: $(curl -s -H "Cookie: $C" $U/relay | grep -o '<title>[^<]*')"
WS=(-H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Protocol: nsl1')
echo "ws, cookie, foreign Origin: $(curl -s -m 3 -o /dev/null -w %{http_code} "${WS[@]}" -H "Cookie: $C" -H 'Origin: https://evil.example' $U/stream?view=1)"
echo "ws, cookie, no Origin: $(curl -s -m 3 -o /dev/null -w %{http_code} "${WS[@]}" -H "Cookie: $C" $U/stream?view=1)"
echo "ws, cookie, right Origin: $(curl -s -m 3 -o /dev/null -w %{http_code} "${WS[@]}" -H "Cookie: $C" -H "Origin: $U" $U/stream?view=1)"
echo "input POST, cookie, no Origin: $(curl -s -o /dev/null -w %{http_code} -H "Cookie: $C" --data-binary @/dev/null $U/input)"

echo "$TOKEN" >/tmp/relay-token && chmod 600 /tmp/relay-token
SR() { timeout 30 node relay/node_modules/screen-relay/dist/cli/relay.mjs "$@" --url $U --token-file /tmp/relay-token --json; echo " [exit $?]"; }
SR click 0.5 0.25
SR scroll 0.5 0.5 --dy 3
SR type "hi there"
SR key Enter Home
SR screenshot /tmp/relay-shot.png
echo "WDA calls:"
curl -s http://127.0.0.1:18100/calls | python3 -c 'import json,sys; [print(" ", c[0], json.dumps(c[1])[:160]) for c in json.load(sys.stdin)["value"]]'

agent-browser $S open $U/ >/dev/null
agent-browser $S set viewport 1000 1100 2 >/dev/null
agent-browser $S fill 'input[name=password]' correct-horse >/dev/null
agent-browser $S click 'button[type=submit]' >/dev/null
timeout 20 agent-browser $S open $U/relay >/dev/null
sleep 4
agent-browser $S eval 'document.querySelector("#status").textContent + " | " + document.querySelector("#screen").width + "x" + document.querySelector("#screen").height'
agent-browser $S screenshot "$PWD/../.amp/in/artifacts/relay-viewer.png" >/dev/null
echo "relay log:"; cat /tmp/relay.log
