# Fake usbmuxd on a Unix socket: lists one USB phone and turns Connect into a TCP connection to
# 127.0.0.1:PORT, after usbmuxd's plist reply, like the real daemon does over USB.
#   python3 fake-usbmuxd.py SOCKET UDID
import os, plistlib, socket, struct, sys, threading

path, udid = sys.argv[1], sys.argv[2]


def reply(conn: socket.socket, tag: int, obj: dict) -> None:
    body = plistlib.dumps(obj)
    conn.sendall(struct.pack("<IIII", 16 + len(body), 1, 8, tag) + body)


def pump(a: socket.socket, b: socket.socket) -> None:
    try:
        while d := a.recv(65536):
            b.sendall(d)
    except OSError:
        pass
    finally:
        for x in (a, b):
            try:
                x.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def handle(conn: socket.socket) -> None:
    head = conn.recv(16)
    size, _, _, tag = struct.unpack("<IIII", head)
    body = b""
    while len(body) < size - 16:
        body += conn.recv(size - 16 - len(body))
    msg = plistlib.loads(body)
    if msg["MessageType"] == "ListDevices":
        props = {"ConnectionSpeed": 480000000, "ConnectionType": "USB", "DeviceID": 7, "LocationID": 0,
                 "ProductID": 4776, "SerialNumber": udid}
        return reply(conn, tag, {"DeviceList": [{"DeviceID": 7, "MessageType": "Attached", "Properties": props}]})
    if msg["MessageType"] == "Connect":
        port = ((msg["PortNumber"] & 0xFF) << 8) | (msg["PortNumber"] >> 8)
        try:
            up = socket.create_connection(("127.0.0.1", port))
        except OSError:
            return reply(conn, tag, {"MessageType": "Result", "Number": 3})  # connection refused
        reply(conn, tag, {"MessageType": "Result", "Number": 0})
        threading.Thread(target=pump, args=(up, conn), daemon=True).start()
        pump(conn, up)


if os.path.exists(path):
    os.unlink(path)
s = socket.socket(socket.AF_UNIX)
s.bind(path)
s.listen()
print(f"fake usbmuxd on {path}", flush=True)
while True:
    c, _ = s.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
