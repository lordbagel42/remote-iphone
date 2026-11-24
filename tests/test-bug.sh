#!/bin/bash
# POST /bug: forwards a report plus the phone's state to the webhook, and needs the token and a title.
cd "$(dirname "$0")/.."
B=tests
U=http://127.0.0.1:18200
TOKEN=$(head -c 32 /dev/urandom | xxd -p -c 64)
for n in "iphone.py serve" fake-wda.py fake-webhook.py; do for p in $(pgrep -f "$n"); do [ "$p" != $$ ] && kill "$p" 2>/dev/null; done; done
rm -f /tmp/fake-webhook.jsonl; sleep 1
(uv run -q --with pillow python $B/fake-wda.py 18100 >/tmp/fw.log 2>&1 &)
(python3 $B/fake-webhook.py 18400 >/dev/null 2>&1 &)
(IPHONE_API_TOKEN=$TOKEN WDA_URL=http://127.0.0.1:18100 IPHONE_BUG_WEBHOOK_URL=http://127.0.0.1:18400/hook \
  host/iphone.py serve --port 18200 >/tmp/serve-bug.log 2>&1 &)
sleep 6
A=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
echo "no token: $(curl -s -o /dev/null -w %{http_code} -d '{"title":"x"}' $U/bug)"
echo "no title: $(curl -s -w ' [%{http_code}]' "${A[@]}" -d '{"description":"x"}' $U/bug)"
echo "report: $(curl -s -w ' [%{http_code}]' "${A[@]}" -d '{"title":"Tap lands 20 pt low","description":"Tapping Clock opens News","steps":"tap 231,248","reporter":"test","extra":"dropped"}' $U/bug)"
echo "webhook received:"; cat /tmp/fake-webhook.jsonl
for n in "iphone.py serve" fake-wda.py fake-webhook.py; do for p in $(pgrep -f "$n"); do [ "$p" != $$ ] && kill "$p" 2>/dev/null; done; done
