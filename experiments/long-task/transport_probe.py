"""Native subscription transport acceptance; no scored trial or Jev calls."""
from __future__ import annotations

import argparse
import json
import threading
import time
import uuid
from pathlib import Path

from capture import Proxy, Recorder, public_headers, scrub_record
from driver import DEFAULT_MODEL, PersistentSession, assistant_text
from grading import check_subscription, file_digest, load, write_new

FORCED_BODY = json.dumps({"type": "error", "error": {"type": "rate_limit_error", "message": "Evaluator-forced upstream retry probe"}})


class FaultRelay(Recorder):
    def __init__(self, store: Path, **kwargs):
        super().__init__(store, **kwargs)
        self.RequestHandlerClass = FaultProxy
        self.error_issued = False
        self.private_first_headers: dict[str, str] = {}
        self.retry_checks: list[dict] = []


class FaultProxy(Proxy):
    server: FaultRelay

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/v1/messages":
            return super().forward()
        with self.server.lock:
            first = not self.server.error_issued
            self.server.error_issued = True
            names = ["authorization", "anthropic-version", "anthropic-beta"]
            if first:
                self.server.private_first_headers = {k: self.headers.get(k, "") for k in names}
            else:
                self.server.retry_checks.append({k + "_unchanged": bool(self.headers.get(k)) and
                    self.headers.get(k) == self.server.private_first_headers.get(k) for k in names})
        if not first:
            return super().forward()
        identity = uuid.uuid4().hex
        with self.server.lock:
            self.server.active += 1
        record = {"id": identity, "method": self.command, "path": self.path,
                  "started_at": time.time(), "request_headers": public_headers(self.headers),
                  "complete": False, "forced_failure": True}
        try:
            write_new(self.server.store / "started" / f"{identity}.json", record)
            body = self.rfile.read(int(self.headers["Content-Length"]))
            credentials = [self.headers.get("authorization", "")]
            record["request_body"], redacted = scrub_record(body.decode(), credentials)
            record["body_redacted"] = redacted
            record.update({"status": 429, "response_body": FORCED_BODY,
                           "response_headers": {"Content-Type": "application/json", "Retry-After": "1", "x-should-retry": "true"}})
            encoded = FORCED_BODY.encode()
            self.send_response(429)
            for name, value in record["response_headers"].items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(encoded)
            self.wfile.flush()
            record["complete"] = record["transport_complete"] = True
        finally:
            record["ended_at"] = time.time()
            write_new(self.server.store / f"{identity}.json", record)
            with self.server.changed:
                self.server.active -= 1
                self.server.completed += 1
                self.server.last_activity = time.monotonic()
                self.server.changed.notify_all()
            self.close_connection = True


def captures(store: Path) -> list[dict]:
    return sorted((load(p) for p in store.glob("*.json")), key=lambda r: r["started_at"])


def header(record: dict, name: str) -> str | None:
    return next((v for k, v in record.get("response_headers", {}).items() if k.lower() == name.lower()), None)


def successful_turn(args, root: Path, name: str, prompt: str, *, recording: bool, upstream=None) -> dict:
    check_subscription(args.claude, args.config)
    task = root / name / "task"
    task.mkdir(parents=True)
    session = PersistentSession(binary=args.claude, config=args.config, model=DEFAULT_MODEL, workspace=task,
                                evidence=root / name / "evidence", plugin=None, settings={"alwaysThinkingEnabled": True, "enabledPlugins": {}},
                                recording=recording, upstream=upstream)
    try:
        events = session.stage(prompt, timeout=300)
        closure = session.close(drain_seconds=2.5)
        models = {m for e in events if e.get("type") == "result" for m in e.get("modelUsage", {})}
        result = {"answer": assistant_text(events), "closure": closure, "resolved_models": sorted(models),
                  "process_pid": session.process.pid}
        write_new(root / name / "turn.json", {"prompt": prompt, "events": events, **result})
        return result
    except BaseException:
        session.abort()
        raise


def equivalence(args, root: Path) -> dict:
    prompt = "Reply with exactly OK. Do not use tools."
    direct = successful_turn(args, root, "direct", prompt, recording=False)
    recorded = successful_turn(args, root, "recorded", prompt, recording=True)
    checks = {"exact_same_answer": direct["answer"] == recorded["answer"] == "OK",
              "same_resolved_model": direct["resolved_models"] == recorded["resolved_models"] == [DEFAULT_MODEL],
              "both_closed": direct["closure"]["runner_observed_end"] and recorded["closure"]["runner_observed_end"],
              "recorded_evidence_complete": recorded["closure"]["evidence_complete"],
              "direct_not_reusable_as_scored_capture": direct["closure"]["evidence_complete"] is False}
    return {"checks": checks, "passed": all(checks.values()), "limit": "One tool-free turn with and without the recording proxy"}


def retry(args, root: Path) -> dict:
    rows = []
    for recording in (False, True):
        name = "recorded" if recording else "direct"
        relay = FaultRelay(root / name / "upstream")
        threading.Thread(target=relay.serve_forever, daemon=True).start()
        try:
            turn = successful_turn(args, root, name, "Reply with exactly OK. Do not use tools.", recording=recording,
                                   upstream=("127.0.0.1", relay.server_port, False))
        finally:
            relay.shutdown()
            relay.server_close()
        requests = captures(relay.store)
        checks = {"two_attempts": len(requests) == 2,
                  "forced_error_then_real_success": [r["status"] for r in requests] == [429, 200],
                  "exact_error_and_retry_after": requests[0]["response_body"] == FORCED_BODY and header(requests[0], "retry-after") == "1",
                  "credential_and_oauth_headers_retained": len(relay.retry_checks) == 1 and all(relay.retry_checks[0].values()),
                  "successful_answer": turn["answer"] == "OK" and turn["closure"]["runner_observed_end"]}
        if recording:
            outer = captures(root / name / "evidence/requests")
            checks["each_request_forwarded_unchanged"] = len(outer) == len(requests) and all(
                all(a.get(k) == b.get(k) for k in ("method", "path", "request_body")) and
                all(a["request_headers"].get(h) == b["request_headers"].get(h) for h in ["anthropic-version", "anthropic-beta"])
                for a, b in zip(outer, requests))
            checks["error_returned_unchanged"] = outer[0]["status"] == 429 and outer[0]["response_body"] == FORCED_BODY and header(outer[0], "retry-after") == "1"
            checks["recorded_evidence_complete"] = turn["closure"]["evidence_complete"]
        rows.append({"recording": recording, "checks": checks, "passed": all(checks.values())})
    return {"cases": rows, "passed": all(r["passed"] for r in rows),
            "limit": "One evaluator-forced upstream 429 per transport; the successful request reaches Anthropic"}


def long_stream(args, root: Path) -> dict:
    prompt = ("Do not use tools. Output exactly 320 lines, with no introduction or code fence. "
              "Number them 0001 through 0320. Every line must contain its number followed by ': streaming transport verification line'. Do not abbreviate the list.")
    turn = successful_turn(args, root, "recorded", prompt, recording=True)
    requests = captures(root / "recorded/evidence/requests")
    record = requests[-1]
    chunks = record.get("chunks", [])
    checks = {"long_visible_answer": len(turn["answer"]) >= 8_000,
              "multiple_flushed_chunks": len(chunks) >= 10,
              "stream_spans_time": bool(chunks) and chunks[-1]["received_at"] - chunks[0]["received_at"] >= 1,
              "first_chunk_forwarded_before_end": bool(chunks) and chunks[0]["flushed_at"] < record["ended_at"],
              "no_chunk_buffering": bool(chunks) and max(c["flushed_at"] - c["received_at"] for c in chunks) < 1,
              "message_stop_and_complete": record.get("message_stop") is True and turn["closure"]["evidence_complete"]}
    return {"checks": checks, "passed": all(checks.values()), "answer_chars": len(turn["answer"]),
            "chunks": len(chunks), "event_types": record.get("event_types"), "usage": record.get("usage")}


def cancelled(args, root: Path) -> dict:
    check_subscription(args.claude, args.config)
    task = root / "task"
    task.mkdir(parents=True)
    session = PersistentSession(binary=args.claude, config=args.config, model=DEFAULT_MODEL, workspace=task,
                                evidence=root / "evidence", plugin=None, settings={"alwaysThinkingEnabled": True, "enabledPlugins": {}})
    worker_result = {}
    def run():
        try:
            session.stage("Do not use tools. Write a numbered list of 2000 detailed streaming transport observations. Do not abbreviate.", timeout=180)
            worker_result["unexpected_completion"] = True
        except BaseException as exc:
            worker_result["interrupted_with"] = type(exc).__name__
        finally:
            with session.proxy.changed:
                session.proxy.changed.notify_all()
    worker = threading.Thread(target=run)
    worker.start()
    try:
        with session.proxy.changed:
            observed = session.proxy.changed.wait_for(lambda: bool(worker_result) or
                (session.proxy.active > 0 and any(e.get("type") == "system" and e.get("subtype") == "thinking_tokens" for e in session.events)), timeout=90)
        if not observed or worker_result:
            raise TimeoutError("No live stream progress observed before cancellation")
        cancelled_at = time.time()
        session.abort()
        worker.join(timeout=5)
        records = captures(root / "evidence/requests")
        checks = {"request_preserved": bool(records), "worker_stopped": not worker.is_alive() and not worker_result.get("unexpected_completion"),
                  "proxy_drained": session.proxy.teardown_complete is True,
                  "capture_marked_incomplete": bool(records) and all(r.get("complete") is False for r in records),
                  "no_message_stop": bool(records) and all(r.get("message_stop") is False for r in records),
                  "partial_usage_retained": bool(records) and any(r.get("usage", {}).get("input_tokens", 0) > 0 for r in records),
                  "not_reusable_as_completed_run": session.captures_complete() is False}
        return {"checks": checks, "passed": all(checks.values()), "cancelled_at": cancelled_at,
                "worker": worker_result, "usage": [r.get("usage") for r in records], "scorable_run": False}
    finally:
        if session.process.poll() is None:
            session.abort()
        worker.join(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--case", choices=["all", "equivalence", "retry", "long-stream", "cancel"], default="all")
    parser.add_argument("--claude", type=Path, default=Path.home() / ".local/share/claude/versions/2.1.309")
    args = parser.parse_args()
    args.root.mkdir(parents=True, exist_ok=False, mode=0o700)
    runtime = Path(__file__).resolve().parent
    identity = {str(runtime / f"{name}.py"): file_digest(runtime / f"{name}.py") for name in ["capture", "driver", "curl_transport", "grading", "transport_probe"]}
    write_new(args.root / "source-before.json", identity)
    archive = args.root / "source-execution"
    archive.mkdir()
    for name, expected in identity.items():
        path = Path(name)
        if file_digest(path) != expected:
            raise ValueError("Source changed while preparing its execution archive")
        (archive / path.name).write_bytes(path.read_bytes())
    cases = {"equivalence": equivalence, "retry": retry, "long-stream": long_stream, "cancel": cancelled}
    results = {}
    try:
        for name, function in cases.items():
            if args.case not in ("all", name):
                continue
            results[name] = function(args, args.root / name)
            write_new(args.root / f"{name}.json", results[name])
            if not results[name]["passed"]:
                break
        changed = [p for p, expected in identity.items() if file_digest(Path(p)) != expected]
        result = {"cases": results, "source_changed": changed, "passed": all(r["passed"] for r in results.values()) and not changed,
                  "phase_0_complete": False, "jev_calls": 0}
        write_new(args.root / "probe.json", result)
        print(json.dumps(result, indent=2))
        return 0 if result["passed"] else 2
    except BaseException as exc:
        write_new(args.root / "error.json", {"error": type(exc).__name__, "message": str(exc), "completed_cases": list(results)})
        raise


if __name__ == "__main__":
    raise SystemExit(main())
