"""Accept the evaluator-only fixture adapter; never credit phase-1 case counts."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import threading
from pathlib import Path

from driver import DEFAULT_MODEL, PersistentSession, assistant_text
from grading import check_subscription, file_digest, load, write_new
from observation import ObservationServer
from spend import SpendLedger


def wrapper(path: Path, *, binary: Path, core: Path, fixture: Path, sink: Path, evidence: Path):
    payload = {"binary": str(binary), "core": str(core), "fixture": str(fixture), "sink": str(sink), "evidence": str(evidence)}
    path.write_text("#!/opt/homebrew/bin/python3\nimport json,os,sys\nfrom pathlib import Path\njob=" + repr(payload) + "\n"
                    "args=sys.argv[1:]\ni=args.index(job['core'])\nassert args[i-1]=='--plugin-dir'\n"
                    "args[i-1:i-1]=['--plugin-dir',job['fixture']]\ni=args.index(job['core'])\n"
                    "args[i+1:i+1]=['--plugin-dir',job['sink']]\n"
                    "Path(job['evidence']).write_text(json.dumps({'argv':[job['binary'],*args]},indent=2)+'\\n')\n"
                    "os.execv(job['binary'],[job['binary'],*args])\n")
    path.chmod(0o700)


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
    repo = runtime.parents[1]
    core = args.root / "core-no-key"
    (core / ".claude-plugin").mkdir(parents=True)
    shutil.copyfile(repo / ".claude-plugin/plugin.json", core / ".claude-plugin/plugin.json")
    shutil.copytree(repo / "hooks", core / "hooks")
    shutil.copytree(repo / "skills", core / "skills")
    if (core / ".env").exists():
        raise ValueError("The no-key fixture must not copy credentials")
    task = args.root / "task"
    task.mkdir()
    marker = "DEVICE-ADAPTER-READ-CONTROL"
    sample = task / "sample.txt"
    sample.write_text(marker + "\n")
    spec_path, logs = args.root / "stimulus.json", args.root / "fixture-log"
    managed_marker = "DEVICE-MANAGED-FIXTURE-UNVERIFIED"
    spec = {"operation": "ping", "instructions": [{"path": str(task / "managed-fixture.md"), "kind": "managed", "content": "## Fixture policy\n\n" + managed_marker + "\nThis is evaluator-generated text, not an organization policy.\n"}]}
    spec_path.write_text(json.dumps(spec))
    bridge = args.root / "device-claude"
    wrapper(bridge, binary=args.claude, core=core, fixture=runtime / "device_fixture", sink=runtime / "device_sink", evidence=args.root / "underlying-launch.json")
    ledger = SpendLedger(args.ledger)
    observer = ObservationServer(task, args.root / "observer", ledger, args.root.name)
    threading.Thread(target=observer.serve_forever, daemon=True).start()
    inputs = [*core.rglob("*.ts"), core / ".claude-plugin/plugin.json", *list((runtime / "device_fixture").rglob("*.ts")), *list((runtime / "device_sink").rglob("*.ts")), Path(__file__), bridge]
    identity = {str(p): file_digest(p) for p in inputs}
    write_new(args.root / "source-before.json", identity)
    session = None
    try:
        options = {"stopGate": "off", "toolGate": "off", "toolJev": "off", "instructions": "off", "foldJev": "off", "instructionFilter": "active", "foldAtPercent": 0}
        session = PersistentSession(binary=bridge, config=args.config, model=DEFAULT_MODEL, workspace=task, evidence=args.root / "evidence", plugin=core,
                                    observer=observer, settings={"alwaysThinkingEnabled": True, "enabledPlugins": {}, "env": {"CH_DEVICE_SPEC_FILE": str(spec_path), "CH_DEVICE_LOG_DIR": str(logs)},
                                    "pluginConfigs": {"context-harness@inline": {"options": options}}})
        ping = session.stage("/device", timeout=45)
        write_new(args.root / "ping.json", {"events": ping})
        spec.update({"operation": "tools", "tools": [{"tool": "Read", "file_path": str(sample)}]})
        spec_path.write_text(json.dumps(spec))
        tools = session.stage("/device", timeout=45)
        write_new(args.root / "tools.json", {"events": tools})
        text = "DEVICE-ARCHIVE-CONTROL\n" + "A" * 2000
        transcript = [{"role": "user", "text": "Preserve the diagnostic result", "toolUses": []},
                      {"role": "assistant", "text": "", "toolUses": [{"tool_use_id": "toolu_device_fixture", "tool": "Read", "input": {"file_path": str(sample)}}]},
                      {"role": "user", "text": "", "toolUses": [], "toolResults": [{"tool_use_id": "toolu_device_fixture", "text": text, "isError": False}]},
                      {"role": "user", "text": "next", "toolUses": []}, {"role": "user", "text": "next again", "toolUses": []}]
        spec.update({"operation": "compact", "transcript": transcript})
        spec_path.write_text(json.dumps(spec))
        compact = session.stage("/compact", timeout=90)
        write_new(args.root / "compact.json", {"events": compact})
        spec["operation"] = "inspect"
        spec_path.write_text(json.dumps(spec))
        session.stage("/device", timeout=45)
        final = session.stage("This controlled diagnostic is complete. Reply with exactly OK. Do not use tools.", stage_id=1, timeout=90)
        closure = session.close(drain_seconds=2.5)
        records = [load(p) for p in logs.glob("*.json")]
        archives = list((args.root / "evidence/plugin-state/.local/state/context-harness/archive").rglob("toolu_device_fixture.json"))
        delivered = [e["value"] for e in records if e["kind"] == "instruction-delivered"]
        root_plugins = next(e for e in session.events if e.get("subtype") == "init").get("plugins", [])
        names = [p["name"] for p in root_plugins if p.get("path") != "builtin"]
        checks = {"plugin_order": names == ["long-task-observer", "device-fixture", "context-harness", "device-sink"],
                  "first_command_registered": any(e["kind"] == "command-complete" and e["value"]["operation"] == "ping" for e in records),
                  "real_file_read": any(e["kind"] == "tool-result" and marker in json.dumps(e["value"]) for e in records),
                  "synthetic_compaction_declared": any(e["kind"] == "compact-input" and e["value"]["synthetic"] for e in records),
                  "root_archived_exact_input": len(archives) == 1 and load(archives[0]).get("text") == text,
                  "folded_result_installed": any(e["kind"] == "transcript-after" and "[folded Read" in json.dumps(e["value"]) for e in records),
                  "managed_fixture_preserved": any(any(f.get("kind") == "managed" and managed_marker in f.get("content", "") for f in files) for files in delivered),
                  "managed_fixture_marked_unverified": any(any(f.get("kind") == "managed" and f.get("isUnverified") is True for f in files) for files in delivered),
                  "one_probe_reply": assistant_text(final) == "OK", "observed_clean_close": closure["runner_observed_end"],
                  "no_jev_calls": ledger.call_count(args.root.name) == 0,
                  "source_unchanged": all(file_digest(Path(p)) == expected for p, expected in identity.items())}
        result = {"version": version, "checks": checks, "passed": all(checks.values()), "observer_errors": observer.errors,
                  "credited_device_cases": 0, "phase_1_complete": False, "underlying_binary_sha256": file_digest(args.claude)}
        write_new(args.root / "probe.json", result)
        print(json.dumps(result, indent=2))
        return 0 if result["passed"] else 2
    except BaseException as exc:
        if session is not None:
            session.abort()
        write_new(args.root / "error.json", {"error": type(exc).__name__, "message": str(exc), "observer_errors": observer.errors})
        raise
    finally:
        observer.shutdown()
        observer.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
