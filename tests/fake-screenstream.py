# Fake ScreenStream broadcast extension: serves an H.264 file's access units as length-prefixed frames
# at 60 fps, starting at a keyframe for each client, like the real extension on port 8400.
#   python3 fake-screenstream.py PORT FILE.h264   (Annex B with AUD NAL units, e.g. x264 aud=1)
import socket, struct, sys, threading, time

port, path = int(sys.argv[1]), sys.argv[2]
data = open(path, "rb").read()
starts = [i for i in range(len(data) - 4) if data[i:i + 4] == b"\x00\x00\x00\x01" and data[i + 4] & 31 == 9]
units = [data[a:b] for a, b in zip(starts, starts[1:] + [len(data)])]
keys = [i for i, u in enumerate(units) if b"\x00\x00\x00\x01\x65" in u or b"\x00\x00\x01\x65" in u]


def serve(conn: socket.socket) -> None:
    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    i = keys[0]
    try:
        while True:
            conn.sendall(struct.pack(">I", len(units[i])) + units[i])
            i = i + 1 if i + 1 < len(units) else keys[0]
            time.sleep(1 / 60)
    except OSError:
        pass


s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port))
s.listen()
print(f"fake ScreenStream on {port}: {len(units)} frames, keyframes at {keys[:5]}", flush=True)
while True:
    c, _ = s.accept()
    threading.Thread(target=serve, args=(c,), daemon=True).start()
