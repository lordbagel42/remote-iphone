#!/bin/bash
# `up` keeps at most two 5 MB XCUITest logs however much the runner writes (here 12 MB).
cd "$(dirname "$0")/.."
B=$PWD/tests
rm -rf /tmp/iwl
pgrep -f fake-tunneld.py >/dev/null || (python3 $B/fake-tunneld.py >/dev/null 2>&1 &)
(uv run -q --with pillow python $B/fake-wda.py 18100 >/tmp/fw.log 2>&1 &)
sleep 3
(PMD3=$B/fake-pmd3.sh IPHONE_WDA_HOME=/tmp/iwl WDA_PORT=18100 FAKE_SPAM=12000000 FAKE_LIFETIME=15 host/iphone.py up </dev/null >/tmp/up-log.log 2>&1 &)
sleep 14
ls -la /tmp/iwl/
head -c 200 /tmp/iwl/xcuitest.log.1 | head -2
grep "WDA ready" /tmp/up-log.log
for p in $(pgrep -f "iphone.py up"); do kill "$p"; done
for p in $(pgrep -f "fake-wda.py"); do kill "$p"; done
