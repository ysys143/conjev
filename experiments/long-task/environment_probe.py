"""Live instruction, memory, provider-trust and task-permission acceptance."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import threading
import uuid
from pathlib import Path

from acceptance import content_text
from driver import DEFAULT_MODEL, PersistentSession
from grading import check_subscription, file_digest, load, subscription_env, write_new
from observation import ObservationServer, validate_observations
from spend import SpendLedger
from watcher import CHANGES, Watcher, probe as watcher_probe


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--claude", type=Path, default=Path.home() / ".local/share/claude/versions/2.1.309")
    args = parser.parse_args()
    version = check_subscription(args.claude, args.config)
    args.root.mkdir(parents=True, exist_ok=False, mode=0o700)
    runtime = Path(__file__).resolve().parent
    plugin = runtime.parents[1]
    inputs = [*(plugin / "hooks").glob("*.ts"), plugin / ".claude-plugin/plugin.json",
              runtime / "observer/hooks/register.ts", runtime / "observer/.claude-plugin/plugin.json",
              *(runtime / f"{name}.py" for name in ["capture", "driver", "curl_transport", "grading", "observation", "spend", "watcher", "acceptance", "environment_probe"])]
    identity = {str(p): file_digest(p) for p in inputs}
    write_new(args.root / "source-before.json", identity)
    for name, expected in identity.items():
        path = Path(name)
        target = args.root / "source-execution" / path.relative_to(plugin)
        target.parent.mkdir(parents=True, exist_ok=True)
        body = path.read_bytes()
        if file_digest(path) != expected:
            raise ValueError("Source changed during archival")
        target.write_bytes(body)
    transient_probe = watcher_probe(args.root / "watcher-probe")
    task = args.root / "task"
    task.mkdir()
    marker = "CH_INVENTORY_" + uuid.uuid4().hex
    (task / "CLAUDE.md").write_text(f"Instruction inventory marker: {marker}.\nWork only on this supplied diagnostic.\n")
    (task / "INTENT.md").write_text("Fix api.add without changing test_api.py, run its tests, then verify again after compaction. Done means both tests pass.\n")
    (task / "PHASE.md").write_text("Now: fix add and run the two tests.\n")
    (task / "api.py").write_text("def add(a, b):\n    return a - b\n")
    (task / "test_api.py").write_text("import unittest\nfrom api import add\nclass TestAPI(unittest.TestCase):\n    def test_add(self): self.assertEqual(add(2, 3), 5)\n    def test_negative(self): self.assertEqual(add(-2, 1), -1)\n")
    test_hash = file_digest(task / "test_api.py")
    initial = subprocess.run([sys.executable, "-m", "unittest", "-v"], cwd=task, env=subscription_env(), capture_output=True, text=True)
    write_new(args.root / "precondition-tests.json", {"exit_code": initial.returncode, "stdout": initial.stdout, "stderr": initial.stderr})
    if initial.returncode == 0:
        raise ValueError("Broken reference fixture did not fail before the model ran")
    project = args.config / "projects" / re.sub(r"[^a-zA-Z0-9_-]", "-", str(task.resolve()))
    project.mkdir(parents=True, exist_ok=False)
    profile_watch = Watcher(project, args.root / "profile-events.jsonl")
    task_watch = Watcher(task, args.root / "task-events.jsonl")
    ledger = SpendLedger(args.ledger)
    observer = ObservationServer(task, args.root / "observer", ledger, args.root.name)
    threading.Thread(target=observer.serve_forever, daemon=True).start()
    session = None
    try:
        profile_watch.start_handshake()
        task_watch.start_handshake()
        profile_watch.stage = task_watch.stage = 1
        options = {"stopGate": "off", "toolGate": "active", "toolJev": "off", "instructions": "off",
                   "foldJev": "off", "instructionFilter": "off", "foldAtPercent": 0, "minFoldChars": 1_000_000}
        session = PersistentSession(binary=args.claude, config=args.config, model=DEFAULT_MODEL, workspace=task,
                                    evidence=args.root / "evidence", plugin=plugin, observer=observer,
                                    settings={"alwaysThinkingEnabled": True, "enabledPlugins": {},
                                              "pluginConfigs": {"context-harness@inline": {"options": options}}})
        first = session.stage("Read api.py and test_api.py. Fix add to return a+b without changing test_api.py. Run python3 -m unittest -v, update PHASE.md with the measured outcome, and report that result.", stage_id=1, timeout=300)
        write_new(args.root / "before-compact.json", {"events": first})
        report = session.stage("/jev-report", timeout=30)
        write_new(args.root / "provider-report-turn.json", {"events": report})
        compact = session.stage("/compact", timeout=300)
        write_new(args.root / "compact-turn.json", {"events": compact})
        second = session.stage("Read api.py and run python3 -m unittest -v again. Report the measured result. Do not change the tests.", stage_id=2, timeout=300)
        write_new(args.root / "after-compact.json", {"events": second})
        closure = session.close(drain_seconds=2.5)
        # A new barrier after the CLI exits bounds the event-log drain without
        # treating a directory listing as proof that no transient write occurred.
        cursor = len(profile_watch.rows)
        (project / ".evaluator-final-barrier").write_text("closed")
        barrier_seen = profile_watch.wait_for(".evaluator-final-barrier", after=cursor)
        profile_watch.close()
        task_watch.close()
        census = validate_observations(observer.store)
        events = [load(p) for p in sorted((observer.store / "events").glob("*.json"))]
        inventories = [e for e in events if e.get("name") == "instruction-inventory"]
        compacts = [e for e in events if e.get("name") == "compact-after"]
        reports = [e.get("text", "") for e in events if e.get("name") == "jev-report-output"]
        before = [e for e in inventories if compacts and e["sequence"] < compacts[0]["sequence"]]
        after = [e for e in inventories if compacts and e["sequence"] > compacts[-1]["sequence"]]
        files = [f for e in inventories for f in e.get("files", [])]
        unexpected = [f["path"] for f in files if Path(f["path"]).resolve() != task / "CLAUDE.md"]
        memory_events = [r for r in profile_watch.rows if (r["path"] == "memory" or r["path"].startswith("memory/")) and CHANGES.intersection(r["flags"])]
        requests = [load(p) for p in (args.root / "evidence/requests").glob("*.json")]
        wire = [json.loads(r["request_body"]) for r in sorted(requests, key=lambda r: r["started_at"]) if r.get("path", "").split("?", 1)[0] == "/v1/messages"]
        first_request_text = json.dumps(wire[0]) if wire else ""
        last_request_text = json.dumps(wire[-1]) if wire else ""
        final_tests = subprocess.run([sys.executable, "-m", "unittest", "-v"], cwd=task, env=subscription_env(), capture_output=True, text=True)
        write_new(args.root / "postcondition-tests.json", {"exit_code": final_tests.returncode, "stdout": final_tests.stdout, "stderr": final_tests.stderr})
        initial_event = next(e for e in session.events if e.get("subtype") == "init")
        source_changed = [p for p, expected in identity.items() if file_digest(Path(p)) != expected]
        checks = {"watcher_transient_probe": all(transient_probe[k] for k in ["observed", "final_bytes_restored", "transient_violation_detected"]),
                  "both_model_stages_closed": census["stages"] == 2 and closure["runner_observed_end"] and closure["evidence_complete"],
                  "provider_classified_first_party_trusted_proxy": any("provider first-party (trusted 127.0.0.1:" in t for t in reports),
                  "read_edit_and_test_permissions": final_tests.returncode == 0 and file_digest(task / "test_api.py") == test_hash and
                     any(b.get("type") == "tool_use" and b.get("name") == "Bash" and "unittest" in b.get("input", {}).get("command", "")
                         for e in first if e.get("type") == "assistant" for b in e.get("message", {}).get("content", [])),
                  "instruction_inventory_before": any(marker in f.get("content", "") for e in before for f in e.get("files", [])),
                  "instruction_inventory_after": any(marker in f.get("content", "") for e in after for f in e.get("files", [])),
                  "instruction_delivered_before_after": marker in first_request_text and marker in last_request_text,
                  "no_unexpected_instruction_files": bool(files) and not unexpected,
                  "no_memory_instruction_or_nonempty_block": not any(f.get("kind") == "memory" for f in files) and
                     not any("memory" in b.get("name", "").lower() and b.get("text", "").strip() for e in inventories for b in e.get("blocks", [])),
                  "fresh_profile_path_verified": (project / (session.session_id + ".jsonl")).is_file(),
                  "no_memory_writes": barrier_seen and not memory_events and not (project / "memory").exists(),
                  "only_harness_skills": sorted(initial_event.get("skills", [])) == ["context-harness:consolidate", "context-harness:project-state", "context-harness:tune-policy"],
                  "no_external_mcp_or_output_style": initial_event.get("output_style") == "default" and
                      all(m.get("name") == "context-harness" for m in initial_event.get("mcp_servers", [])),
                  "no_jev_calls": ledger.call_count(args.root.name) == 0,
                  "source_unchanged": not source_changed}
        result = {"version": version, "checks": checks, "passed": all(checks.values()), "phase_0_complete": False,
                  "census": census, "unexpected_instruction_files": unexpected, "memory_events": memory_events,
                  "profile_event_count": len(profile_watch.rows), "provider_reports": reports,
                  "source_changed": source_changed, "jev_calls": ledger.call_count(args.root.name)}
        write_new(args.root / "probe.json", result)
        print(json.dumps(result, indent=2))
        return 0 if result["passed"] else 2
    except BaseException as exc:
        if session is not None:
            session.abort()
        write_new(args.root / "error.json", {"error": type(exc).__name__, "message": str(exc), "observer_errors": observer.errors})
        raise
    finally:
        for watcher in (profile_watch, task_watch):
            if watcher.child.poll() is None:
                watcher.close()
        observer.shutdown()
        observer.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
