"""Loopback-only recording proxy. Stream bytes unchanged; redact the record only."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import http.client
import json
import queue
import re
import socket
import subprocess
import threading
import time
import uuid
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from grading import write_new
from curl_transport import CurlConnection

PRIVATE_HEADERS = {"authorization", "x-api-key", "proxy-authorization", "cookie", "set-cookie"}
HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"}


def public_headers(headers) -> dict:
    return {k: "<redacted>" if k.lower() in PRIVATE_HEADERS else v for k, v in headers.items()}


def decode_record(body: bytes, encoding: str, *, partial: bool = False) -> str:
    if encoding == "gzip":
        body = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(body) if partial else gzip.decompress(body)
    elif encoding == "deflate":
        body = zlib.decompressobj().decompress(body) if partial else zlib.decompress(body)
    elif encoding == "br":
        # Node is already a runner prerequisite. Decode only the capture copy;
        # the original compressed entity is sent to Claude unchanged.
        decoder = ('const z=require("node:zlib");process.stdout.write(z.brotliDecompressSync(require("node:fs").readFileSync(0),'
                   + ('{finishFlush:z.constants.BROTLI_OPERATION_FLUSH}' if partial else '{}') + '))')
        result = subprocess.run(["node", "-e", decoder], input=body, capture_output=True, timeout=30)
        if result.returncode != 0:
            raise ValueError("Brotli capture decoding failed")
        body = result.stdout
    elif encoding == "zstd":
        from compression import zstd
        body = zstd.ZstdDecompressor().decompress(body) if partial else zstd.decompress(body)
    elif encoding not in ("", "identity"):
        raise ValueError(f"Unsupported capture content encoding: {encoding}")
    return body.decode("utf-8", errors="replace" if partial else "strict")


def scrub_record(text: str, credentials: list[str]) -> tuple[str, bool]:
    original = text
    for value in credentials:
        if value:
            text = text.replace(value, "<redacted>")
    text = re.sub(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b", "<redacted>", text)
    return text, text != original


def stream_facts(text: str) -> dict:
    """SSE usage fields are cumulative updates, not independent token charges."""
    usage, seen = {}, set()
    complete = False
    issues = []
    for event in re.split(r"\r?\n\r?\n", text):
        data = "\n".join(line[5:].lstrip() for line in event.splitlines() if line.startswith("data:"))
        if not data or data == "[DONE]":
            continue
        try:
            value = json.loads(data)
        except ValueError:
            issues.append("invalid-sse-json")
            continue
        kind = value.get("type")
        seen.add(kind)
        if kind == "message_start":
            current = (value.get("message") or {}).get("usage") or {}
        elif kind == "message_delta":
            current = value.get("usage") or {}
        else:
            current = {}
        for key, count in current.items():
            if key.endswith("tokens") and type(count) is int and count >= 0:
                if key in usage and count < usage[key]:
                    issues.append(f"usage-counter-regression:{key}")
                usage[key] = count
        if kind == "message_stop":
            complete = True
    return {"usage": usage, "message_stop": complete, "event_types": sorted(k for k in seen if isinstance(k, str)), "issues": issues}


class Recorder(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, store: Path, *, upstream: tuple[str, int, bool] = ("api.anthropic.com", 443, True), backend: str | None = None):
        self.store = store
        self.store.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.upstream = upstream
        self.backend = backend or "stdlib-pooled"
        if self.backend not in ("curl", "stdlib", "stdlib-pooled"):
            raise ValueError("Unknown upstream transport")
        self.pool = queue.LifoQueue()
        self.closing = False
        self.active = 0
        self.completed = 0
        self.lock = threading.Lock()
        self.changed = threading.Condition(self.lock)
        self.sockets: dict[str, socket.socket] = {}
        self.cancelled: set[str] = set()
        self.record_errors: set[str] = set()
        self.progress: dict[str, dict] = {}
        self.teardown_complete: bool | None = None
        self.last_activity = time.monotonic()
        super().__init__(("127.0.0.1", 0), Proxy)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_port}"

    def idle(self) -> bool:
        with self.lock:
            return self.active == 0

    def connection(self):
        host, port, secure = self.upstream
        if self.backend == 'stdlib-pooled':
            while True:
                try:
                    conn, identity, last_used = self.pool.get_nowait()
                except queue.Empty:
                    break
                if conn.sock is not None and time.monotonic() - last_used < 20:
                    return conn, identity, True
                conn.close()
        factory = http.client.HTTPSConnection if secure else http.client.HTTPConnection
        return factory(host, port, timeout=120), uuid.uuid4().hex, False

    def release(self, conn, identity):
        with self.lock:
            if not self.closing and conn.sock is not None:
                self.pool.put((conn, identity, time.monotonic()))
                return
        conn.close()

    def server_close(self):
        # A daemon request thread otherwise disappears with its evaluator,
        # losing both the cancelled capture and its partial usage.
        with self.lock:
            self.closing = True
            active = list(self.sockets.items())
            self.cancelled.update(identity for identity, _ in active)
        for _, connection in active:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        with self.changed:
            self.teardown_complete = self.changed.wait_for(lambda: self.active == 0, timeout=10)
        while True:
            try:
                conn, _, _ = self.pool.get_nowait()
                conn.close()
            except queue.Empty:
                break
        super().server_close()

    def records_complete(self) -> bool:
        starts = {p.stem for p in (self.store / "started").glob("*.json")}
        records = [json.loads(p.read_text()) for p in self.store.glob("*.json")]
        messages = [r for r in records if r.get("path", "").split("?", 1)[0].endswith("/messages")]
        return (not self.record_errors and self.teardown_complete is not False and self.idle()
                and starts == {r.get("id") for r in records} and bool(messages)
                and all(r.get("complete") and not r.get("body_redacted") for r in messages))


class Proxy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: Recorder

    def log_message(self, *args):
        # Neither URLs, credentials nor private text goes to the terminal.
        pass

    def forward(self):
        if not self.path.startswith("/") or self.path.startswith("//") or self.headers.get("Transfer-Encoding"):
            self.send_error(400, "Only origin-form requests with Content-Length are supported")
            return
        identity = uuid.uuid4().hex
        with self.server.lock:
            self.server.active += 1
            self.server.last_activity = time.monotonic()
        record = {"id": identity, "method": self.command, "path": self.path,
                  "request_headers": public_headers(self.headers), "started_at": time.time(), "complete": False,
                  "chunks": []}
        credentials = [value for name, value in self.headers.items() if name.lower() in PRIVATE_HEADERS]
        conn = None
        sent_headers = False
        raw_response = bytearray()
        encoding = ""
        phase = "read-client-request"
        connection_id = None
        try:
            write_new(self.server.store / "started" / f"{identity}.json", record)
            request = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            text = decode_record(request, self.headers.get("Content-Encoding", ""))
            record["request_body"], redacted = scrub_record(text, credentials)
            record["body_redacted"] = redacted
            host, port, secure = self.server.upstream
            use_curl = self.server.backend == "curl"
            if use_curl:
                conn = CurlConnection(host, port, timeout=120, secure=secure)
                reused = False
            else:
                conn, connection_id, reused = self.server.connection()
            record["upstream_backend"] = self.server.backend
            record["upstream_connection_id"] = connection_id
            record["upstream_connection_reused"] = reused
            phase = "connect-upstream"
            if not reused:
                conn.connect()
            with self.server.lock:
                if conn.sock is not None:
                    self.server.sockets[identity] = conn.sock
            record["upstream_transport_prepared_at" if use_curl else "upstream_connected_at"] = time.time()
            # Keep repeated end-to-end headers instead of collapsing them into
            # a dict; only the hop and the upstream Host are reconstructed.
            conn.putrequest(self.command, self.path, skip_host=True, skip_accept_encoding=True)
            for name, value in self.headers.items():
                if name.lower() not in HOP_HEADERS | {"host", "content-length"}:
                    conn.putheader(name, value)
            conn.putheader("Host", host if port in (80, 443) else f"{host}:{port}")
            conn.putheader("Content-Length", str(len(request)))
            phase = "send-upstream-headers"
            conn.endheaders()
            phase = "send-upstream-body"
            record["request_bytes"] = len(request)
            upload_count = "body_bytes_queued" if use_curl else "body_bytes_sent"
            record[upload_count] = 0
            for offset in range(0, len(request), 16384):
                chunk = request[offset:offset + 16384]
                conn.send(chunk)
                record[upload_count] += len(chunk)
            record["upstream_request_buffered_at" if use_curl else "upstream_request_sent_at"] = time.time()
            phase = "read-upstream-headers"
            response = conn.getresponse()
            record["status"] = response.status
            record["response_headers"] = public_headers(dict(response.getheaders()))
            encoding = response.getheader("Content-Encoding", "")
            for name, value in response.getheaders():
                if name.lower() in PRIVATE_HEADERS:
                    credentials.append(value)
            self.send_response_only(response.status, response.reason)
            for name, value in response.getheaders():
                if name.lower() not in HOP_HEADERS | {"content-length"}:
                    self.send_header(name, value)
            # This proxy chooses downstream chunk boundaries; entity bytes and
            # their Content-Encoding are forwarded unchanged.
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Connection", "close")
            self.end_headers()
            sent_headers = True
            phase = "read-upstream-body"
            while True:
                chunk = response.read1(65536)
                if not chunk:
                    break
                received = time.time()
                raw_response.extend(chunk)
                with self.server.changed:
                    previous = self.server.progress.get(identity, {})
                    self.server.progress[identity] = {"received_bytes": len(raw_response),
                        "first_chunk_at": previous.get("first_chunk_at", received), "last_chunk_at": received}
                    self.server.last_activity = time.monotonic()
                    self.server.changed.notify_all()
                phase = "forward-client-body"
                self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                self.wfile.flush()
                record["chunks"].append({"bytes": len(chunk), "sha256": hashlib.sha256(chunk).hexdigest(),
                                         "received_at": received, "flushed_at": time.time()})
                phase = "read-upstream-body"
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            record["transport_complete"] = True
            with self.server.lock:
                self.server.sockets.pop(identity, None)
        except Exception as exc:
            # Do not stringify transport errors: an upstream library may put a
            # header value in its message. Preserve the class and phase instead.
            record["error"] = type(exc).__name__
            record["error_phase"] = phase
            if not sent_headers:
                try:
                    self.send_response(502)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                except OSError:
                    record["client_disconnected"] = True
        finally:
            if conn is not None:
                if self.server.backend == 'stdlib-pooled' and record.get('transport_complete') and not record.get('error') and identity not in self.server.cancelled:
                    self.server.release(conn, connection_id)
                else:
                    conn.close()
                if isinstance(conn, CurlConnection):
                    record["curl_exit_code"] = conn.exit_code
                    record["curl_metrics"] = conn.metrics
                    record["body_bytes_sent"] = conn.metrics.get("size_upload")
            try:
                record["cancelled"] = identity in self.server.cancelled
                record["response_bytes"] = len(raw_response)
                record["response_sha256"] = hashlib.sha256(raw_response).hexdigest()
                partial = not record.get("transport_complete") or record["cancelled"]
                text = decode_record(bytes(raw_response), encoding, partial=partial)
                record["response_body"], redacted = scrub_record(text, credentials)
                record["body_redacted"] = record.get("body_redacted", False) or redacted
                is_stream = "text/event-stream" in next((v for k, v in record.get("response_headers", {}).items() if k.lower() == "content-type"), "")
                if is_stream:
                    record.update(stream_facts(record["response_body"]))
                    record["complete"] = bool(record.get("transport_complete") and not record["cancelled"] and record["message_stop"] and not record["issues"])
                else:
                    record["complete"] = bool(record.get("transport_complete") and not record["cancelled"])
            except Exception as exc:
                record["capture_error"] = type(exc).__name__
            record["ended_at"] = time.time()
            try:
                write_new(self.server.store / f"{identity}.json", record)
            except OSError:
                self.server.record_errors.add(identity)
                raise
            finally:
                with self.server.changed:
                    self.server.sockets.pop(identity, None)
                    self.server.active -= 1
                    self.server.completed += 1
                    self.server.last_activity = time.monotonic()
                    self.server.changed.notify_all()
            self.close_connection = True

    do_GET = do_POST = do_DELETE = do_PATCH = do_PUT = forward


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", type=Path, required=True)
    args = parser.parse_args()
    server = Recorder(args.store)
    print(server.url, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
