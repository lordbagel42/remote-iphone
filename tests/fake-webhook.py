# Fake Amp webhook: records each POST's Idempotency-Key and JSON body in /tmp/fake-webhook.jsonl.
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        with open("/tmp/fake-webhook.jsonl", "a") as f:
            f.write(json.dumps({"key": self.headers.get("Idempotency-Key"), "body": json.loads(body)}) + "\n")
        self.send_response(202); self.send_header("Content-Length", "0"); self.end_headers()

    def log_message(self, *a): pass


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
