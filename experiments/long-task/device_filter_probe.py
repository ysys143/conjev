"""Candidate live instruction-filter adapter checks; not a frozen Q2 receipt."""
from __future__ import annotations

import argparse
import copy
import json
import shutil
import threading
from pathlib import Path

from acceptance import content_text
from device_adapter_probe import wrapper
from driver import DEFAULT_MODEL, PersistentSession, assistant_text
from grading import check_subscription, file_digest, load, write_new
from observation import ObservationServer
from spend import SpendLedger

CASES = ["duplicate-once", "unique-preserved", "organization-preserved", "memory-preserved"]


def normalized(files):
    return [{k: f[k] for k in ["path", "kind", "content"]} for f in files]


def instruction_envelopes(body, first_path):
    """The pinned CLI carries project instructions in a system-reminder.

    Select by the current declared source path, so retained history cannot
    supply a marker missing from the current instruction envelope.
    """
    text = [*content_text(body.get("system", [])),
            *(t for message in body.get("messages", []) for t in content_text(message.get("content", [])))]
    return [t for t in text if f"Contents of {first_path}" in t]


def case_checks(name, original, delivered, rows, systems, expected, marker):
    chunks = 1 if name in ["unique-preserved", "memory-preserved"] else 2
    drops = int(name == "duplicate-once")
    return {
        "input_observed": bool(original),
        "each_input_has_one_delivery": len(original) == len(delivered),
        "all_deliveries_exact": bool(delivered) and all(normalized(f) == expected for f in delivered),
        "exact_chunk_record_count": len(rows) == chunks * len(original),
        "exact_duplicate_drop_count": sum(r.get("decision") == "drop" for r in rows) == drops * len(original),
        "expected_record_modes": bool(rows) and all(r.get("mode") == "active" and r.get("point") == "instr-filter" and r.get("sent") is None for r in rows),
        "no_jev_readings": all(r.get("facts", {}).get("jev") in ["no-key", "-"] and "usage" not in r and "jev" not in r for r in rows),
        "marker_occurs_on_wire": bool(systems) and all(s.count(marker) == (1 if name in ["duplicate-once", "unique-preserved"] else 2) for s in systems),
        "drop_note_occurs_on_wire": all(("[context-harness: left out" in s) == (name == "duplicate-once") for s in systems),
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--ledger", type=Path, required=True)
    p.add_argument("--repetitions", type=int, default=3)
    p.add_argument("--claude", type=Path, default=Path.home() / ".local/share/claude/versions/2.1.309")
    args = p.parse_args()
    if args.repetitions < 1: raise ValueError("Positive repetition count required")
    version = check_subscription(args.claude, args.config)
    args.root.mkdir(parents=True, exist_ok=False, mode=0o700)
    runtime = Path(__file__).resolve().parent
    repo = runtime.parents[1]
    core = args.root / "core-no-key"
    (core / ".claude-plugin").mkdir(parents=True)
    shutil.copyfile(repo / ".claude-plugin/plugin.json", core / ".claude-plugin/plugin.json")
    for name in ["hooks", "skills"]: shutil.copytree(repo / name, core / name)
    task = args.root / "task"
    task.mkdir()
    spec_path = args.root / "stimulus.json"
    sources = [*(core / "hooks").glob("*.ts"), core / ".claude-plugin/plugin.json", *list((runtime / "device_fixture").rglob("*.ts")),
               *list((runtime / "device_sink").rglob("*.ts")), *(runtime / f"{n}.py" for n in ["capture", "driver", "grading", "observation", "spend", "device_adapter_probe", "device_filter_probe"])]
    identity = {str(path): file_digest(path) for path in sources}
    write_new(args.root / "source-before.json", identity)
    ledger = SpendLedger(args.ledger)
    observer = ObservationServer(task, args.root / "observer", ledger, args.root.name)
    threading.Thread(target=observer.serve_forever, daemon=True).start()
    session = None
    results = []
    closures = []
    try:
        stage = 0
        for repetition in range(1, args.repetitions + 1):
            for name in CASES:
                stage += 1
                run = args.root / "cases" / f"{stage:02}"
                run.mkdir(parents=True)
                logs, evidence, bridge = run / "fixture-log", run / "evidence", run / "device-claude"
                wrapper(bridge, binary=args.claude, core=core, fixture=runtime / "device_fixture", sink=runtime / "device_sink", evidence=run / "underlying-launch.json")
                marker = f"DEVICE-FILTER-{name}-{repetition}-UNIQUE"
                text = f"## Control policy\n\nPreserve the instruction {marker} throughout this controlled diagnostic.\n"
                first = {"path": str(task / f"source-{stage}.md"), "kind": "user", "content": text}
                second = {"path": str(task / f"target-{stage}.md"), "kind": "managed" if name == "organization-preserved" else "memory" if name == "memory-preserved" else "project", "content": text}
                files = [first] if name == "unique-preserved" else [first, second]
                expected = copy.deepcopy(files)
                if name == "duplicate-once": expected[1]["content"] = f'[context-harness: left out "Control policy", loaded from {first["path"]}]\n\n'
                spec_path.write_text(json.dumps({"operation": "ping", "instructions": files}))
                write_new(args.root / f"stimulus-{stage:02}.json", {"case": name, "repetition": repetition, "instructions": files, "expected_delivered": expected})
                known_logs = set(logs.glob("*.json"))
                known_requests = set((evidence / "requests").glob("*.json"))
                known_rows = set((evidence / "plugin-state").rglob("*.json"))
                # prompt.context is loaded once by this CLI, so each changed
                # instruction stimulus needs a fresh process. Changing a spec
                # file between ordinary turns does not reload instructions.
                options = {"stopGate": "off", "toolGate": "off", "toolJev": "off", "instructions": "off", "foldJev": "off", "instructionFilter": "active", "foldAtPercent": 0}
                session = PersistentSession(binary=bridge, config=args.config, model=DEFAULT_MODEL, workspace=task, evidence=evidence, plugin=core, observer=observer,
                    settings={"alwaysThinkingEnabled": True, "enabledPlugins": {}, "env": {"CH_DEVICE_SPEC_FILE": str(spec_path), "CH_DEVICE_LOG_DIR": str(logs)}, "pluginConfigs": {"context-harness@inline": {"options": options}}})
                turn = session.stage("This controlled diagnostic requires no work or tools. Reply with exactly OK.", stage_id=stage, timeout=120)
                observed = [load(path) for path in sorted(set(logs.glob("*.json")) - known_logs)]
                original = [r["value"]["files"] for r in observed if r["kind"] == "instruction-input"]
                delivered = [r["value"] for r in observed if r["kind"] == "instruction-delivered"]
                row_paths = [path for path in set((evidence / "plugin-state").rglob("*.json")) - known_rows if "/records/" in str(path)]
                rows = [load(path) for path in row_paths]
                requests = [load(path) for path in set((evidence / "requests").glob("*.json")) - known_requests]
                message_requests = [r for r in requests if r.get("path", "").split("?", 1)[0] == "/v1/messages"]
                systems = ["\n".join(instruction_envelopes(json.loads(r["request_body"]), first["path"])) for r in message_requests]
                checks = case_checks(name, original, delivered, rows, systems, expected, marker)
                checks["declared_input_exact"] = all(normalized(f) == files for f in original)
                checks["actual_reply_ok"] = assistant_text(turn) == "OK"
                checks["complete_messages"] = bool(message_requests) and all(r.get("complete") for r in message_requests)
                # Require meaningful rejection of both a deleted record and lost
                # instruction content while retaining the rest of the evidence.
                deleted_record = case_checks(name, original, delivered, rows[1:], systems, expected, marker)
                lost = copy.deepcopy(delivered)
                if lost: lost[0][0]["content"] = lost[0][0]["content"].replace(marker, "LOST")
                deleted_text = case_checks(name, original, lost, rows, systems, expected, marker)
                checks["record_deletion_rejected"] = not all(deleted_record.values())
                checks["instruction_loss_rejected"] = not all(deleted_text.values())
                closure = session.close(drain_seconds=2.5)
                closures.append(closure)
                session = None
                checks["observed_clean_close"] = closure["runner_observed_end"] and closure["evidence_complete"]
                result = {"case": name, "repetition": repetition, "stage": stage, "checks": checks, "passed": all(checks.values()),
                          "input_events": len(original), "records": len(rows), "request_count": len(message_requests),
                          "evidence_sha256": {str(path): file_digest(path) for path in [bridge, run / "underlying-launch.json", *(set(logs.glob("*.json")) - known_logs), *row_paths, *(set((evidence / "requests").glob("*.json")) - known_requests)]}}
                write_new(args.root / f"case-{stage:02}.json", result)
                results.append(result)
                if not result["passed"]: raise ValueError(f"Candidate case failed: {name}, repetition {repetition}")
        changed = [path for path, digest in identity.items() if file_digest(Path(path)) != digest]
        result = {"version": version, "cases": results, "closures": closures, "source_changed": changed,
                  "no_jev_calls": ledger.call_count(args.root.name) == 0, "credited_device_cases": 0, "phase_1_complete": False,
                  "candidate_only": True, "synthetic_instructions": True, "real_organization_or_auto_memory_validation": False}
        result["passed"] = all(r["passed"] for r in results) and all(c["evidence_complete"] and c["runner_observed_end"] for c in closures) and not changed and result["no_jev_calls"]
        write_new(args.root / "probe.json", result)
        print(json.dumps({k: v for k, v in result.items() if k != "cases"}, indent=2))
        return 0 if result["passed"] else 2
    except BaseException as exc:
        if session is not None: session.abort()
        write_new(args.root / "error.json", {"error": type(exc).__name__, "message": str(exc), "cases_completed": len(results), "observer_errors": observer.errors})
        raise
    finally:
        observer.shutdown()
        observer.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
