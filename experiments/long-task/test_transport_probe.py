from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from capture import Recorder
from transport_probe import FORCED_BODY, FaultRelay, captures, header


class TransportProbeTests(unittest.TestCase):
    def test_forced_error_and_retry_forwarding_preserve_headers_body_and_private_credentials(self):
        seen = []
        sse = (b'data: {"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\n'
               b'data: {"type":"message_stop"}\n\n')
        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                seen.append((body, self.headers.get("Authorization"), self.headers.get("anthropic-beta")))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(sse)))
                self.end_headers()
                self.wfile.write(sse)
                self.wfile.flush()
            def log_message(self, *args):
                pass
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            relay = FaultRelay(root / "relay", upstream=("127.0.0.1", upstream.server_port, False))
            outer = Recorder(root / "outer", upstream=("127.0.0.1", relay.server_port, False))
            threading.Thread(target=relay.serve_forever, daemon=True).start()
            threading.Thread(target=outer.serve_forever, daemon=True).start()
            try:
                bodies = []
                statuses = []
                for _ in range(2):
                    client = http.client.HTTPConnection("127.0.0.1", outer.server_port, timeout=3)
                    client.request("POST", "/v1/messages?probe=1", body=b'{"fixture":true}', headers={
                        "Authorization": "Bearer fixture-private", "anthropic-beta": "fixture-oauth", "anthropic-version": "fixture-version"})
                    response = client.getresponse()
                    statuses.append(response.status)
                    bodies.append(response.read())
                    client.close()
                self.assertEqual(statuses, [429, 200])
                self.assertEqual(bodies, [FORCED_BODY.encode(), sse])
            finally:
                outer.shutdown()
                outer.server_close()
                relay.shutdown()
                relay.server_close()
                upstream.shutdown()
                upstream.server_close()
            records = captures(outer.store)
            self.assertEqual(header(records[0], "retry-after"), "1")
            self.assertEqual(seen, [(b'{"fixture":true}', 'Bearer fixture-private', 'fixture-oauth')])
            self.assertTrue(outer.records_complete())
            self.assertTrue(relay.records_complete())
            self.assertTrue(all(relay.retry_checks[0].values()))
            self.assertNotIn("fixture-private", json.dumps(records))
            self.assertEqual([r["path"] for r in records], ["/v1/messages?probe=1"] * 2)


if __name__ == "__main__":
    unittest.main()
