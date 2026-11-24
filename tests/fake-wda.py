# Minimal fake WebDriverAgent for testing iphone.py serve/up --listen without a phone.
import base64, io, json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image

buf = io.BytesIO()
Image.new("RGB", (750, 1334), (30, 120, 200)).save(buf, "PNG")
PNG = base64.b64encode(buf.getvalue()).decode()
TREE = {"type": "XCUIElementTypeApplication", "label": "Settings", "rect": {"x": 0, "y": 0, "width": 375, "height": 667},
        "children": [{"type": "XCUIElementTypeButton", "label": "General", "rect": {"x": 16, "y": 303, "width": 343, "height": 45}}]}
calls = []


class H(BaseHTTPRequestHandler):
    def reply(self, value, status=200, sid=None):
        data = json.dumps({"value": value, "sessionId": sid}).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        p = self.path
        if p == "/status": return self.reply({"ready": True, "ios": {"ip": os.environ.get("FAKE_IP", "10.9.9.9")}})
        if p == "/window/size": return self.reply({"width": 375, "height": 667})
        if p == "/screenshot": return self.reply(PNG)
        if p.startswith("/source"): return self.reply(TREE)
        if p == "/wda/activeAppInfo": return self.reply({"bundleId": "com.apple.Preferences"})
        if p == "/calls": return self.reply(calls)
        if p.endswith("/rect"): return self.reply({"x": 16, "y": 303, "width": 343, "height": 45})
        self.reply({"error": "unknown command", "message": p}, 404)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        calls.append([self.path, body])
        if self.path == "/session": return self.reply({"sessionId": "S1"}, sid="S1")
        if self.path.endswith("/element"):
            if "Nope" in body["value"]: return self.reply({"error": "no such element", "message": "nope"}, 404)
            return self.reply({"ELEMENT": "E1"})
        return self.reply(None)

    def log_message(self, *a): pass


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
