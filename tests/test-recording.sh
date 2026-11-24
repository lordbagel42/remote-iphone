#!/bin/bash
# POST /recording/start and /recording/stop: records the fake MJPEG stream to an MP4 served at an unguessable URL.
cd "$(dirname "$0")/.."
B=tests
U=http://127.0.0.1:18200
TOKEN=$(head -c 32 /dev/urandom | xxd -p -c 64)
for n in "iphone.py serve" fake-wda.py fake-mjpeg.py; do for p in $(pgrep -f "$n"); do [ "$p" != $$ ] && kill "$p" 2>/dev/null; done; done
sleep 1
(uv run -q --with pillow python $B/fake-wda.py 18100 >/tmp/fw.log 2>&1 &)
(IPHONE_API_TOKEN=$TOKEN WDA_URL=http://127.0.0.1:18100 WDA_MJPEG_PORT=19100 IPHONE_PUBLIC_URL=$U \
  host/iphone.py serve --port 18200 >/tmp/serve-rec.log 2>&1 &)
sleep 6
A=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
echo "no stream: $(curl -s -w ' [%{http_code}]' "${A[@]}" -d '{}' $U/recording/start)"
(uv run -q --with pillow python $B/fake-mjpeg.py 19100 >/tmp/fm.log 2>&1 &)
sleep 3
echo "no token: $(curl -s -o /dev/null -w %{http_code} -d '{}' $U/recording/start)"
echo "stop idle: $(curl -s -w ' [%{http_code}]' "${A[@]}" -d '{}' $U/recording/stop)"
echo "bad max: $(curl -s -w ' [%{http_code}]' "${A[@]}" -d '{"max_seconds":0}' $U/recording/start)"
echo "start: $(curl -s -w ' [%{http_code}]' "${A[@]}" -d '{}' $U/recording/start)"
echo "start again: $(curl -s -w ' [%{http_code}]' "${A[@]}" -d '{}' $U/recording/start)"
echo "tap while recording: $(curl -s -w ' [%{http_code}]' "${A[@]}" -d '{"x":10,"y":10}' $U/tap)"
sleep 3
echo "status: $(curl -s "${A[@]}" $U/recording)"
R=$(curl -s "${A[@]}" -d '{}' $U/recording/stop); echo "stop: $R"
URL=$(echo "$R" | jq -r .value.url)
curl -s -o /tmp/rec.mp4 -w "download (no auth): %{http_code} %{content_type}\n" "$URL"
ffprobe -v error -select_streams v -count_frames -show_entries stream=codec_name,width,height,nb_read_frames:format=duration -of compact /tmp/rec.mp4
echo "unknown id: $(curl -s -o /dev/null -w %{http_code} $U/recordings/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.mp4)"
echo "auto-stop: $(curl -s "${A[@]}" -d '{"max_seconds":2}' $U/recording/start)"
sleep 4
echo "status after max: $(curl -s "${A[@]}" $U/recording)"
R=$(curl -s "${A[@]}" -d '{}' $U/recording/stop); echo "stop after max: $R"
curl -s -o /tmp/rec2.mp4 "$(echo "$R" | jq -r .value.url)"
ffprobe -v error -show_entries format=duration -of compact /tmp/rec2.mp4
echo "start, then the stream dies: $(curl -s "${A[@]}" -d '{}' $U/recording/start)"
sleep 3; for p in $(pgrep -f fake-mjpeg.py); do kill "$p"; done; sleep 2
echo "status after the stream died: $(curl -s "${A[@]}" $U/recording)"
R=$(curl -s "${A[@]}" -d '{}' $U/recording/stop); echo "stop: $R"
curl -s -o /tmp/rec3.mp4 "$(echo "$R" | jq -r .value.url)"; ffprobe -v error -show_entries format=duration -of compact /tmp/rec3.mp4
echo "start with the stream down: $(curl -s -w ' [%{http_code}]' "${A[@]}" -d '{}' $U/recording/start)"
D=$(ls -d /tmp/iphone-recordings-* | tail -1); echo "files before exit: $(ls $D | wc -l)"
for n in "iphone.py serve" fake-wda.py fake-mjpeg.py; do for p in $(pgrep -f "$n"); do [ "$p" != $$ ] && kill "$p" 2>/dev/null; done; done
sleep 2; echo "folder after SIGTERM: $(ls -d $D 2>/dev/null || echo gone)"
