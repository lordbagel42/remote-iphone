#!/bin/bash
# Tests iphone.py serve (WDA down) and `up --listen` proxying with a fake WDA, tunneld and pymobiledevice3.
cd "$(dirname "$0")/.."
B=$PWD/tests
U=http://127.0.0.1:18200
for pid in $(pgrep -f "iphone.py serve"); do kill "$pid"; done
for pid in $(pgrep -f "fake-wda.py"); do kill "$pid"; done
sleep 1
(WDA_URL=http://127.0.0.1:18100 host/iphone.py serve --port 18200 >/tmp/serve2.log 2>&1 &)
sleep 6
echo "wda down: $(curl -s -w ' [%{http_code}]' -H "Authorization: Bearer $IPHONE_API_TOKEN" $U/status)"
(uv run -q --with pillow python $B/fake-wda.py 18100 >/tmp/fw.log 2>&1 &)
pgrep -f fake-tunneld.py >/dev/null || (python3 $B/fake-tunneld.py >/dev/null 2>&1 &)
sleep 4
rm -rf /tmp/iwu
(PMD3=$B/fake-pmd3.sh IPHONE_WDA_HOME=/tmp/iwu WDA_PORT=18100 FAKE_LIFETIME=12 host/iphone.py up --listen 18300 </dev/null >/tmp/up.log 2>&1 &)
sleep 8
echo "via proxy: $(curl -s -m5 http://127.0.0.1:18300/status)"
sleep 9
echo "during restart: $(curl -s -m5 -o /dev/null -w %{http_code} http://127.0.0.1:18300/status)"
sleep 10
echo "after restart: $(curl -s -m5 http://127.0.0.1:18300/window/size)"
for pid in $(pgrep -f "iphone.py up"); do kill "$pid"; done
sleep 2
cat /tmp/up.log
pgrep -fl fake-pmd3 || echo "no orphan xcuitest"
