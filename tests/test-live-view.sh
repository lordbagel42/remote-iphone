#!/bin/bash
# Starts fake WDA + fake MJPEG + iphone.py serve with a view password, then checks the login flow with curl.
cd "$(dirname "$0")/.."
B=tests
for p in $(pgrep -f "iphone.py serve"); do kill "$p"; done
pgrep -f fake-wda.py >/dev/null || (uv run -q --with pillow python $B/fake-wda.py 18100 >/tmp/fw.log 2>&1 &)
pgrep -f fake-mjpeg.py >/dev/null || (uv run -q --with pillow python $B/fake-mjpeg.py 19100 >/tmp/fm.log 2>&1 &)
sleep 4
(IPHONE_API_TOKEN=$(head -c 32 /dev/urandom | xxd -p -c 64) WDA_URL=http://127.0.0.1:18100 WDA_MJPEG_PORT=19100 IPHONE_VIEW_PASSWORD=correct-horse IPHONE_PUBLIC_URL=http://127.0.0.1:18200 \
  host/iphone.py serve --port 18200 >/tmp/serve4.log 2>&1 &)
sleep 6
U=http://127.0.0.1:18200
echo "page no cookie: $(curl -s $U/ | grep -o 'iPhone live view')"
echo "stream no cookie: $(curl -s -o /dev/null -w %{http_code} $U/live.mjpeg)"
echo "wrong password: $(curl -s -o /dev/null -w %{http_code} -d password=nope $U/login)"
echo "forged cookie: $(curl -s -o /dev/null -w %{http_code} -H 'Cookie: view=9999999999.deadbeef' $U/live.mjpeg)"
C=$(curl -s -D - -o /dev/null -d password=correct-horse $U/login | grep -i '^set-cookie' | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//')
echo "cookie attrs: $(curl -s -D - -o /dev/null -d password=correct-horse $U/login | grep -i '^set-cookie' | cut -d';' -f2-)"
echo "/ with cookie: $(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H "Cookie: $C" $U/)"
echo "/mjpeg with cookie: $(curl -s -H "Cookie: $C" $U/mjpeg | grep -o 'live.mjpeg' | head -1)"
echo "old tab (no v=2): $(curl -s -o /dev/null -w %{http_code} -H "Cookie: $C" $U/live.mjpeg)"
curl -s -m 3 -H "Cookie: $C" "$U/live.mjpeg?v=2" -o /tmp/stream.bin; echo "stream bytes in 3s: $(wc -c </tmp/stream.bin), frames: $(grep -ac 'Content-type: image/jpeg' /tmp/stream.bin)"
head -c 120 /tmp/stream.bin | head -3
echo "api still needs bearer: $(curl -s -o /dev/null -w %{http_code} -H "Cookie: $C" $U/status)"
