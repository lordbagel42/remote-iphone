# Fake WDA MJPEG server: answers any connection with WDA's raw HTTP/1.0 multipart stream.
import io, socket, sys, threading, time
from PIL import Image, ImageDraw


W, H = (int(v) for v in (sys.argv[2:4] or (750, 1334)))


def frame(i: int) -> bytes:
    img = Image.new("RGB", (W, H), (20, 20 + (i * 7) % 200, 120))
    ImageDraw.Draw(img).text((60, 600), f"frame {i}", fill=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=60)
    return buf.getvalue()


def serve(conn: socket.socket) -> None:
    try:
        conn.recv(1024)
        conn.sendall(b"HTTP/1.0 200 OK\r\nServer: WDA MJPEG Server\r\nConnection: close\r\nMax-Age: 0\r\nExpires: 0\r\n"
                     b"Cache-Control: no-cache, private\r\nPragma: no-cache\r\n"
                     b"Content-Type: multipart/x-mixed-replace; boundary=--BoundaryString\r\n\r\n")
        i = 0
        while True:
            jpg = frame(i)
            conn.sendall(b"--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(jpg) + jpg + b"\r\n\r\n")
            i += 1
            time.sleep(0.1)
    except OSError:
        pass
    finally:
        conn.close()


s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1])))
s.listen()
while True:
    c, _ = s.accept()
    threading.Thread(target=serve, args=(c,), daemon=True).start()
