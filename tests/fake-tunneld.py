import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"00008110-000870C036EB801E": [{"tunnel-address": "fd00::1", "tunnel-port": 1, "interface": "mobdev2-00008110-000870C036EB801E-127.0.0.1"}]}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 49151), H).serve_forever()
