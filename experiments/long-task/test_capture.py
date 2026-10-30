from __future__ import annotations

import gzip
import http.client
import json
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import capture
from grading import write_new


class CaptureTests(unittest.TestCase):
    def test_sequential_requests_reuse_the_same_upstream_connection(self):
        peers = []
        payload = b'data: {"type":"message_stop"}\n\n'

        class Upstream(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                peers.append(self.client_address)
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()

            def log_message(self, *args): pass

        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as td:
                proxy = capture.Recorder(Path(td), upstream=('127.0.0.1', upstream.server_port, False))
                threading.Thread(target=proxy.serve_forever, daemon=True).start()
                try:
                    for _ in range(2):
                        client = http.client.HTTPConnection('127.0.0.1', proxy.server_port, timeout=5)
                        try:
                            client.request('POST', '/v1/messages', body=b'{}')
                            self.assertEqual(client.getresponse().read(), payload)
                            with proxy.changed:
                                self.assertTrue(proxy.changed.wait_for(lambda: proxy.active == 0, timeout=5))
                        finally:
                            client.close()
                finally:
                    proxy.shutdown()
                    proxy.server_close()
                rows = sorted((json.loads(p.read_text()) for p in Path(td).glob('*.json')), key=lambda r: r['started_at'])
                self.assertEqual(len(peers), 2)
                self.assertEqual(peers[0], peers[1], 'The upstream TCP connection was reopened')
                self.assertEqual([r['upstream_connection_reused'] for r in rows], [False, True])
                self.assertEqual(rows[0]['upstream_connection_id'], rows[1]['upstream_connection_id'])
                self.assertTrue(proxy.records_complete())
        finally:
            upstream.shutdown()
            upstream.server_close()

    def test_large_request_is_sent_byte_for_byte_and_upload_progress_is_recorded(self):
        seen = []
        payload = b'{"padding":"' + b'x' * 1_100_000 + b'"}'
        response_body = b'data: {"type":"message_stop"}\n\n'

        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                seen.append(self.rfile.read(int(self.headers['Content-Length'])))
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(response_body)))
                self.end_headers()
                self.wfile.write(response_body)

            def log_message(self, *args):
                pass

        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as td:
                proxy = capture.Recorder(Path(td), upstream=('127.0.0.1', upstream.server_port, False))
                threading.Thread(target=proxy.serve_forever, daemon=True).start()
                client = http.client.HTTPConnection('127.0.0.1', proxy.server_port, timeout=5)
                try:
                    client.request('POST', '/v1/messages', body=payload)
                    self.assertEqual(client.getresponse().read(), response_body)
                finally:
                    client.close()
                    proxy.shutdown()
                    proxy.server_close()
                record = json.loads(next(Path(td).glob('*.json')).read_text())
                self.assertEqual(seen, [payload])
                self.assertEqual(record['body_bytes_sent'], len(payload))
                self.assertLessEqual(record['upstream_connected_at'], record['upstream_request_sent_at'])
                self.assertTrue(proxy.records_complete())
        finally:
            upstream.shutdown()
            upstream.server_close()

    def test_partial_upload_failure_is_preserved_and_never_admitted(self):
        client_type = http.client.HTTPConnection

        class BrokenUpload:
            sock = None

            def __init__(self, *args, **kwargs):
                self.sent = 0

            def connect(self): pass
            def putrequest(self, *args, **kwargs): pass
            def putheader(self, *args, **kwargs): pass
            def endheaders(self, *args): pass
            def close(self): pass

            def send(self, body):
                if self.sent:
                    raise BrokenPipeError('synthetic private detail must not be copied')
                self.sent += len(body)

        with tempfile.TemporaryDirectory() as td:
            proxy = capture.Recorder(Path(td), upstream=('127.0.0.1', 1, False))
            threading.Thread(target=proxy.serve_forever, daemon=True).start()
            client = client_type('127.0.0.1', proxy.server_port, timeout=5)
            try:
                with patch.object(capture.http.client, 'HTTPConnection', BrokenUpload):
                    client.request('POST', '/v1/messages', body=b'x' * 50000)
                    response = client.getresponse()
                    self.assertEqual(response.status, 502)
                    response.read()
                    with proxy.changed:
                        self.assertTrue(proxy.changed.wait_for(lambda: proxy.active == 0, timeout=5))
            finally:
                client.close()
                proxy.shutdown()
                proxy.server_close()
            record = json.loads(next(Path(td).glob('*.json')).read_text())
            self.assertEqual(record['error_phase'], 'send-upstream-body')
            self.assertEqual(record['error'], 'BrokenPipeError')
            self.assertEqual(record['body_bytes_sent'], 16384)
            self.assertEqual(record['response_bytes'], 0)
            self.assertFalse(record['complete'])
            self.assertNotIn('synthetic private detail', json.dumps(record))
            self.assertFalse(proxy.records_complete())

    def test_an_unreconciled_request_start_cannot_hide_behind_a_completed_one(self):
        with tempfile.TemporaryDirectory() as td:
            store = Path(td)
            proxy = capture.Recorder(store)
            try:
                write_new(store / "started/one.json", {"id": "one"})
                write_new(store / "one.json", {"id": "one", "path": "/v1/messages", "complete": True, "body_redacted": False})
                self.assertTrue(proxy.records_complete())
                write_new(store / "started/orphan.json", {"id": "orphan"})
                self.assertFalse(proxy.records_complete())
            finally:
                proxy.server_close()

    def test_cancelled_stream_is_committed_before_proxy_teardown_returns(self):
        release = threading.Event()
        first = (b'data: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":1}}}\n\n'
                 b'data: {"type":"ping"}\n\n')
        last = b'data: {"type":"message_stop"}\n\n'

        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(first) + len(last)))
                self.end_headers()
                self.wfile.write(first)
                self.wfile.flush()
                release.wait(5)
                try:
                    self.wfile.write(last)
                    self.wfile.flush()
                except OSError:
                    pass

            def log_message(self, *args):
                pass

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        with tempfile.TemporaryDirectory() as td:
            proxy = capture.Recorder(Path(td), upstream=("127.0.0.1", upstream.server_port, False))
            threading.Thread(target=proxy.serve_forever, daemon=True).start()
            client = http.client.HTTPConnection("127.0.0.1", proxy.server_port, timeout=2)
            try:
                client.request("POST", "/v1/messages", body=b'{}')
                response = client.getresponse()
                self.assertEqual(response.read1(len(first)), first)
                response.close()
                client.close()
                proxy.shutdown()
                proxy.server_close()
                self.assertFalse(release.is_set())
                records = [json.loads(p.read_text()) for p in Path(td).glob("*.json")]
                self.assertEqual(len(records), 1, "Cancellation lost the in-flight request record")
                self.assertFalse(records[0]["complete"])
                self.assertFalse(records[0]["message_stop"])
                self.assertEqual(records[0]["usage"], {"input_tokens": 9, "output_tokens": 1})
            finally:
                release.set()
                client.close()
                deadline = time.monotonic() + 3
                while not proxy.idle() and time.monotonic() < deadline:
                    threading.Event().wait(0.01)
                upstream.shutdown()
                upstream.server_close()

    def test_brotli_and_zstd_capture_decoding_preserves_the_original_bytes(self):
        from compression import zstd
        body = b'{"error":{"message":"weekly limit fixture"}}'
        compressor = 'process.stdout.write(require("node:zlib").brotliCompressSync(require("node:fs").readFileSync(0)))'
        encoded = subprocess.check_output(["node", "-e", compressor], input=body)
        original = bytes(encoded)
        self.assertEqual(capture.decode_record(encoded, "br"), body.decode())
        self.assertEqual(encoded, original)
        self.assertEqual(capture.decode_record(zstd.compress(body), "zstd"), body.decode())

    def test_truncated_compressed_capture_keeps_the_available_sse_usage(self):
        body = b'data: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":1}}}\n\n'
        truncated = gzip.compress(body)[:-8]
        with self.assertRaises((EOFError, OSError)):
            capture.decode_record(truncated, "gzip")
        decoded = capture.decode_record(truncated, "gzip", partial=True)
        self.assertEqual(decoded, body.decode())
        self.assertEqual(capture.stream_facts(decoded)["usage"], {"input_tokens": 9, "output_tokens": 1})

    def test_cumulative_usage_is_not_summed_and_stop_adds_nothing(self):
        events = [
            {"type": "message_start", "message": {"usage": {"input_tokens": 20, "output_tokens": 1}}},
            {"type": "message_delta", "usage": {"output_tokens": 4}},
            {"type": "message_delta", "usage": {"output_tokens": 9}},
            {"type": "message_stop"},
        ]
        text = "".join("data: " + json.dumps(e) + "\n\n" for e in events)
        facts = capture.stream_facts(text)
        self.assertEqual(facts["usage"], {"input_tokens": 20, "output_tokens": 9})
        self.assertTrue(facts["message_stop"])
        self.assertFalse(capture.stream_facts(text.rsplit("data:", 1)[0])["message_stop"])
        self.assertTrue(capture.stream_facts(text + 'data: {bad}\n\n')["issues"])

    def test_counter_regression_is_not_accepted_as_complete_usage(self):
        facts = capture.stream_facts('data: {"type":"message_delta","usage":{"output_tokens":7}}\n\n'
                                     'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n')
        self.assertIn("usage-counter-regression:output_tokens", facts["issues"])

    def test_stream_first_chunk_is_delivered_before_upstream_finishes(self):
        release = threading.Event()
        first = b'data: {"type":"ping"}\n\n'
        last = b'data: {"type":"message_stop"}\n\n'

        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(first) + len(last)))
                self.end_headers()
                self.wfile.write(first)
                self.wfile.flush()
                release.wait(3)
                self.wfile.write(last)
                self.wfile.flush()

            def log_message(self, *args):
                pass

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as td:
                proxy = capture.Recorder(Path(td), upstream=("127.0.0.1", upstream.server_port, False))
                threading.Thread(target=proxy.serve_forever, daemon=True).start()
                conn = http.client.HTTPConnection("127.0.0.1", proxy.server_port, timeout=1)
                try:
                    conn.request("POST", "/v1/messages", body=b'{}')
                    response = conn.getresponse()
                    self.assertEqual(response.read1(len(first)), first)
                    self.assertFalse(release.is_set())
                    release.set()
                    self.assertEqual(response.read(), last)
                finally:
                    release.set()
                    conn.close()
                    proxy.shutdown()
                    proxy.server_close()
        finally:
            upstream.shutdown()
            upstream.server_close()

    def test_request_response_transport_and_credential_redaction(self):
        seen = []
        payload = gzip.compress(b'upstream response bytes')

        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                seen.append((self.path, dict(self.headers), body))
                self.send_response(429)
                self.send_header("Retry-After", "11")
                self.send_header("Content-Encoding", "gzip")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        with tempfile.TemporaryDirectory() as td:
            proxy = capture.Recorder(Path(td), upstream=("127.0.0.1", upstream.server_port, False), backend="curl")
            threading.Thread(target=proxy.serve_forever, daemon=True).start()
            try:
                conn = http.client.HTTPConnection("127.0.0.1", proxy.server_port, timeout=5)
                body = gzip.compress(b'{"synthetic":true}')
                conn.request("POST", "/v1/messages?beta=fixture", body=body, headers={
                    "Authorization": "Bearer fixture-private", "anthropic-version": "fixture-version",
                    "anthropic-beta": "fixture-oauth", "Content-Encoding": "gzip",
                })
                response = conn.getresponse()
                self.assertEqual(response.status, 429)
                self.assertEqual(response.getheader("Retry-After"), "11")
                self.assertEqual(response.getheader("Content-Encoding"), "gzip")
                self.assertEqual(response.read(), payload)
                conn.close()
            finally:
                proxy.shutdown()
                proxy.server_close()
            # Response forwarding finishes before the record is committed; wait
            # for this test-owned handler to settle through a bounded join.
            for _ in range(100):
                if proxy.idle():
                    break
                threading.Event().wait(0.01)
            records = [json.loads(p.read_text()) for p in Path(td).glob("*.json")]
            self.assertEqual(len(records), 1)
            record = records[0]
            self.assertEqual(seen[0][0], "/v1/messages?beta=fixture")
            self.assertEqual(seen[0][2], body)
            self.assertEqual(seen[0][1]["Authorization"], "Bearer fixture-private")
            self.assertEqual(seen[0][1]["anthropic-version"], "fixture-version")
            self.assertEqual(seen[0][1]["anthropic-beta"], "fixture-oauth")
            self.assertNotIn("fixture-private", json.dumps(record))
            self.assertEqual(record["request_body"], '{"synthetic":true}')
            self.assertEqual(record["response_body"], "upstream response bytes")
            self.assertTrue(record["complete"])
            self.assertEqual(record['curl_exit_code'], 0)
            self.assertEqual(record['body_bytes_sent'], len(body))
        upstream.shutdown()
        upstream.server_close()

    def assert_truncated_response_is_rejected(self, backend):
        partial = (b'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":1}}}\n\n'
                   b'data: {"type":"message_stop"}\n\n')

        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(partial) + 100))
                self.end_headers()
                self.wfile.write(partial)
                self.wfile.flush()
                self.close_connection = True

            def log_message(self, *args): pass

        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as td:
                proxy = capture.Recorder(Path(td), upstream=('127.0.0.1', upstream.server_port, False), backend=backend)
                threading.Thread(target=proxy.serve_forever, daemon=True).start()
                client = http.client.HTTPConnection('127.0.0.1', proxy.server_port, timeout=5)
                try:
                    client.request('POST', '/v1/messages', body=b'{}')
                    response = client.getresponse()
                    try:
                        response.read()
                    except http.client.IncompleteRead:
                        pass
                finally:
                    client.close()
                    proxy.shutdown()
                    proxy.server_close()
                record = json.loads(next(Path(td).glob('*.json')).read_text())
                self.assertEqual(record['response_body'], partial.decode())
                self.assertEqual(record['usage'], {'input_tokens': 7, 'output_tokens': 1})
                if backend == 'curl':
                    self.assertNotEqual(record['curl_exit_code'], 0)
                else:
                    self.assertEqual(record.get('error'), 'IncompleteRead')
                self.assertFalse(record['complete'])
                self.assertFalse(proxy.records_complete())
        finally:
            upstream.shutdown()
            upstream.server_close()

    def test_curl_truncated_response_retains_partial_usage_and_fails_admission(self):
        self.assert_truncated_response_is_rejected('curl')

    def test_pooled_truncated_response_with_message_stop_still_fails_admission(self):
        self.assert_truncated_response_is_rejected('stdlib-pooled')


if __name__ == "__main__":
    unittest.main()
