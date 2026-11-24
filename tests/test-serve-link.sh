#!/bin/bash
# Tests the screenshot link endpoint of iphone.py serve against fake-wda.py on 18100.
cd "$(dirname "$0")/.."
for pid in $(pgrep -f "iphone.py serve"); do kill "$pid"; done
pgrep -f fake-wda.py >/dev/null || (uv run -q --with pillow python tests/fake-wda.py 18100 >/tmp/fw.log 2>&1 &)
sleep 3
(WDA_URL=http://127.0.0.1:18100 IPHONE_PUBLIC_URL=http://127.0.0.1:18200/ host/iphone.py serve --port 18200 >/tmp/serve3.log 2>&1 &)
sleep 6
A="Authorization: Bearer $IPHONE_API_TOKEN"
R=$(curl -s -X POST -H "$A" http://127.0.0.1:18200/screenshot/link); echo "$R"
URL=$(echo "$R" | python3 -c 'import json,sys;print(json.load(sys.stdin)["value"]["url"])')
echo "fetch link without auth: $(curl -s -o /tmp/l.jpg -w '%{http_code} %{content_type} %{size_download}' "$URL")"
echo "guessed link: $(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:18200/shots/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.jpg)"
echo "link no auth POST: $(curl -s -o /dev/null -w %{http_code} -X POST http://127.0.0.1:18200/screenshot/link)"
for pid in $(pgrep -f "iphone.py serve"); do kill "$pid"; done
for pid in $(pgrep -f "fake-wda.py"); do kill "$pid"; done
for pid in $(pgrep -f "fake-tunneld.py"); do kill "$pid"; done
