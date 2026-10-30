"""Evaluator-owned Stop census and immutable task snapshots. No scoring feedback.

The identical observer wraps both Q3 arms. Its requests precede the underlying
Stop hook; its replies carry only receipt IDs, never rubrics or oracle results.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from grading import digest, file_digest, load, write_new
from spend import SpendLedger


def snapshot(workspace: Path, destination: Path) -> dict:
    destination.mkdir(parents=True, exist_ok=False, mode=0o700)
    files = {}
    total = 0
    for directory, dirs, names in os.walk(workspace, followlinks=False):
        links = [name for name in dirs if (Path(directory) / name).is_symlink()]
        dirs[:] = sorted(name for name in dirs if name not in links)
        for name in sorted(names + links):
            source = Path(directory) / name
            relative = source.relative_to(workspace).as_posix()
            if source.is_symlink():
                files[relative] = {"kind": "symlink", "target": os.readlink(source)}
                continue
            before = source.stat()
            if not source.is_file():
                raise ValueError("Non-file task artifact cannot be silently omitted")
            total += before.st_size
            if total > 64 * 1024 * 1024 or len(files) >= 10_000:
                raise ValueError("Task snapshot ceiling reached; evidence is incomplete")
            body = source.read_bytes()
            after = source.stat()
            if (before.st_ino, before.st_mtime_ns, before.st_size) != (after.st_ino, after.st_mtime_ns, after.st_size):
                raise ValueError("Task changed during its pre-decision snapshot")
            target = destination / "files" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as out:
                out.write(body)
            files[relative] = {"kind": "file", "sha256": hashlib.sha256(body).hexdigest(), "mode": before.st_mode & 0o777}
    receipt = {"files": files, "sha256": digest(files), "bytes": total}
    write_new(destination / "snapshot.json", receipt)
    return receipt


def verify_snapshot(path: Path) -> dict:
    receipt = load(path / "snapshot.json")
    if digest(receipt["files"]) != receipt["sha256"]:
        raise ValueError("Snapshot manifest changed")
    for name, entry in receipt["files"].items():
        if Path(name).is_absolute() or ".." in Path(name).parts:
            raise ValueError("Escaped snapshot path")
        target = path / "files" / name
        if entry["kind"] == "file" and (target.is_symlink() or file_digest(target) != entry["sha256"]):
            raise ValueError("Snapshot artifact changed")
        if entry["kind"] not in ("file", "symlink"):
            raise ValueError("Unknown snapshot entry")
    return receipt


class ObservationServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, workspace: Path, store: Path, ledger: SpendLedger, run_id: str):
        self.workspace, self.store = workspace.resolve(), store.resolve()
        if self.store.is_relative_to(self.workspace):
            raise ValueError("Evaluator observations must be outside the task folder")
        self.store.mkdir(parents=True, exist_ok=False, mode=0o700)
        self.ledger, self.run_id = ledger, run_id
        self.lock = threading.RLock()
        self.stage = 0
        self.stage_active = False
        self.sequence = 0
        self.candidates: list[str] = []
        self.pending: str | None = None
        self.open_candidate: str | None = None
        self.session_id: str | None = None
        self.errors: list[str] = []
        super().__init__(("127.0.0.1", 0), ObservationHandler)

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server_port}"

    def event(self, kind: str, data: dict) -> int:
        self.sequence += 1
        write_new(self.store / "events" / f"{self.sequence:06}.json",
                  {"sequence": self.sequence, "kind": kind, "at": time.time(), "stage": self.stage, **data})
        return self.sequence

    def begin_stage(self, stage: int):
        with self.lock:
            if stage <= self.stage or self.stage_active or self.pending is not None or self.open_candidate is not None:
                raise ValueError("Previous Stop/continuation has not settled")
            self.stage, self.candidates = stage, []
            self.stage_active = True
            self.event("stage-start", {})

    def candidate(self, payload: dict) -> dict:
        with self.lock:
            event = payload["event"]
            if not self.stage_active or self.open_candidate is not None or event.get("agent_id") is not None:
                raise ValueError("No active main-agent Stop stage")
            if event.get("session_id") != self.session_id or not isinstance(payload.get("messages"), list):
                raise ValueError("Stop identity or pre-decision transcript is missing")
            identity = uuid.uuid4().hex
            snap = snapshot(self.workspace, self.store / "snapshots" / identity)
            record = {"id": identity, "stage": self.stage, "ordinal": len(self.candidates) + 1,
                      "continuation_of": self.pending, "snapshot_sha256": snap["sha256"],
                      "event": event, "messages": payload["messages"], "observed_at": time.time()}
            write_new(self.store / "candidates" / f"{identity}.json", record)
            self.candidates.append(identity)
            self.open_candidate = identity
            self.event("candidate-before", {"candidate_id": identity, "continuation_of": self.pending})
            self.pending = None
            return {"candidate_id": identity}

    def decision(self, payload: dict) -> dict:
        with self.lock:
            identity = payload["candidate_id"]
            if identity != self.open_candidate or not isinstance(payload.get("result"), dict):
                raise ValueError("Unmatched Stop result")
            write_new(self.store / "decisions" / f"{identity}.json", payload)
            self.event("candidate-after", {"candidate_id": identity, "blocked": "block" in payload["result"]})
            self.pending = identity if "block" in payload["result"] else None
            self.open_candidate = None
            return {"recorded": True}

    def finish_stage(self, events: list[dict]) -> dict:
        with self.lock:
            if self.pending or self.open_candidate or not self.candidates:
                raise ValueError("Missing Stop result or dropped automatic continuation")
            if not any(e.get("type") == "result" and e.get("subtype") == "success" and not e.get("is_error") for e in events):
                raise ValueError("No successful stage handback")
            snap_id = f"stage-{self.stage:02}-end"
            snap = snapshot(self.workspace, self.store / "snapshots" / snap_id)
            receipt = {"stage": self.stage, "candidate_ids": self.candidates,
                       "snapshot": snap_id, "snapshot_sha256": snap["sha256"], "events": events}
            write_new(self.store / "stages" / f"{self.stage:02}.json", receipt)
            self.event("stage-end", {"candidate_ids": self.candidates})
            self.stage_active = False
            return receipt

    def reserve(self, payload: dict) -> dict:
        with self.lock:
            call = self.ledger.reserve(self.run_id, payload["request"], long_context=payload.get("long_context", False))
            self.event("jev-reserved", {"call_id": call, "candidate_id": self.open_candidate,
                                        "request_sha256": digest(payload["request"])})
            return {"call_id": call}

    def settle(self, payload: dict) -> dict:
        with self.lock:
            response = payload.get("response", {})
            self.ledger.settle(payload["call_id"], response)
            self.event("jev-settled", {"call_id": payload["call_id"], "model": response.get("model"), "usage": response.get("usage")})
            return {"recorded": True}

    def lifecycle(self, payload: dict) -> dict:
        with self.lock:
            self.event("lifecycle", payload)
            return {"recorded": True}


class ObservationHandler(BaseHTTPRequestHandler):
    server: ObservationServer

    def log_message(self, *args):
        pass

    def do_POST(self):
        routes = {"/candidate": self.server.candidate, "/decision": self.server.decision,
                  "/reserve": self.server.reserve, "/settle": self.server.settle,
                  "/lifecycle": self.server.lifecycle}
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if self.path not in routes or not 0 < length <= 16 * 1024 * 1024:
                raise ValueError("Invalid evaluator request")
            payload = json.loads(self.rfile.read(length))
            result = routes[self.path](payload)
            status = 200
        except Exception as exc:
            with self.server.lock:
                self.server.errors.append(f"{type(exc).__name__}: {exc}")
                self.server.event("observer-error", {"error": type(exc).__name__, "message": str(exc)})
            result, status = {"error": type(exc).__name__}, 422
        encoded = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def validate_observations(store: Path) -> dict:
    events = [load(p) for p in sorted((store / "events").glob("*.json"))]
    if not events or [e["sequence"] for e in events] != list(range(1, len(events) + 1)):
        raise ValueError("Missing observer event")
    if any(e["kind"] == "observer-error" for e in events):
        raise ValueError("Observer errors keep the run incomplete")
    expected = [e["candidate_id"] for e in events if e["kind"] == "candidate-before"]
    candidates = {p.stem: load(p) for p in (store / "candidates").glob("*.json")}
    decisions = {p.stem: load(p) for p in (store / "decisions").glob("*.json")}
    if not expected or len(set(expected)) != len(expected) or set(expected) != set(candidates) or set(expected) != set(decisions):
        raise ValueError("Missing or extra Stop candidate/result")
    for identity in expected:
        candidate = candidates[identity]
        snap = verify_snapshot(store / "snapshots" / identity)
        if snap["sha256"] != candidate["snapshot_sha256"]:
            raise ValueError("Pre-decision snapshot does not match the candidate")
        prior = candidate["continuation_of"]
        if prior and (prior not in decisions or "block" not in decisions[prior]["result"] or candidates[prior]["stage"] != candidate["stage"]):
            raise ValueError("Unmatched continuation")
        if "block" in decisions[identity]["result"] and sum(c["continuation_of"] == identity for c in candidates.values()) != 1:
            raise ValueError("Dropped or duplicated automatic continuation")
    stages = [load(p) for p in sorted((store / "stages").glob("*.json"))]
    if sorted(x for s in stages for x in s["candidate_ids"]) != sorted(expected):
        raise ValueError("Stop candidates are not covered by closed stages")
    for stage in stages:
        snap = verify_snapshot(store / "snapshots" / stage["snapshot"])
        if snap["sha256"] != stage["snapshot_sha256"]:
            raise ValueError("Stage snapshot changed")
    return {"stages": len(stages), "candidates": len(expected),
            "blocked": sum("block" in d["result"] for d in decisions.values()), "complete": True}
