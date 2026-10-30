"""Live diagnostic acceptance probes, never pilot/main study observations."""
from __future__ import annotations

import argparse
import json
import threading
from pathlib import Path

from driver import DEFAULT_MODEL, PersistentSession, assistant_text
from grading import check_subscription, file_digest, write_new
from observation import ObservationServer, validate_observations
from spend import SpendLedger


def text_values(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for child in value:
            yield from text_values(child)
    elif isinstance(value, dict):
        for child in value.values():
            yield from text_values(child)


def chain_checks(root: Path, events: list[dict], records: list[dict]) -> dict:
    requests = [json.loads(p.read_text()) for p in (root / "evidence/requests").glob("*.json")]
    text = "\n".join(t for r in requests for t in text_values(json.loads(r["request_body"])))
    lifecycle = [json.loads(p.read_text()) for p in (root / "observer/events").glob("*.json")]
    return {
        "automatic_compact_command": any(e.get("name") == "compact-command-before" and
                                         e.get("origin") == {"kind": "plugin", "name": "context-harness"} for e in lifecycle),
        "folded_pointers_returned": any(e.get("name") == "compact-after" and e.get("pointers", 0) > 0 for e in lifecycle),
        "folded_pointers_delivered": "[folded Read" in text,
        "consolidation_note_delivered": "[context-harness] Before this conversation is folded" in text,
        "post_compaction_note_delivered": "[context-harness] This conversation was just compacted" in text,
        "consolidate_skill_called": any(b.get("type") == "tool_use" and b.get("name") == "Skill" and
                                       b.get("input", {}).get("skill") == "context-harness:consolidate"
                                       for e in events if e.get("type") == "assistant" for b in e.get("message", {}).get("content", [])),
        "stop_shadow_judgment": any(r.get("point") == "stop" and r.get("mode") == "shadow" and "jev" in r and not r.get("error") for r in records),
        "fold_shadow_judgment": any(r.get("point") == "fold" and "jev" in r and not r.get("error") for r in records),
    }


def probe(args) -> dict:
    version = check_subscription(args.claude, args.config)
    args.root.mkdir(parents=True, exist_ok=False, mode=0o700)
    runtime = Path(__file__).resolve().parent
    inputs = [*(args.plugin / "hooks").glob("*.ts"), args.plugin / ".claude-plugin/plugin.json",
              *(args.plugin / "skills").glob("*/SKILL.md"), runtime / "observer/hooks/register.ts",
              runtime / "observer/.claude-plugin/plugin.json",
              *(runtime / f"{name}.py" for name in ["capture", "driver", "curl_transport", "grading", "native_run", "observation", "spend", "lifecycle"])]
    source_before = {str(p): file_digest(p) for p in inputs}
    write_new(args.root / "source-before.json", source_before)
    for name, expected in source_before.items():
        path = Path(name)
        target = args.root / "source-execution" / path.relative_to(args.plugin)
        target.parent.mkdir(parents=True, exist_ok=True)
        body = path.read_bytes()
        if file_digest(path) != expected:
            raise ValueError("Source changed during archival")
        target.write_bytes(body)
    task = args.root / "task"
    task.mkdir()
    (task / "probe.txt").write_text("initial probe\n")
    (task / "INTENT.md").write_text("Complete this three-step lifecycle diagnostic: read the seeded catalog, change probe.txt to 'updated probe' plus one newline, and verify that exact file. Maintain PHASE.md and one session episode when context-harness asks. The task is done when the exact file contents are verified and those notes record completion. No further project work is assigned.\n")
    (task / "PHASE.md").write_text("Not started.\n")
    (task / "sessions").mkdir()
    if args.case == "full-chain":
        (task / "catalog.txt").write_text("".join(f"row {i:04}: code={i * 17 + 3} " + "context-lifecycle-fixture " * 4 + "\n" for i in range(500)))
    ledger = SpendLedger(args.ledger)
    before_spend = ledger.summary()
    observer = ObservationServer(task, args.root / "observer", ledger, args.root.name)
    threading.Thread(target=observer.serve_forever, daemon=True).start()
    options = {"stopGate": args.stop_mode, "instructions": "off", "toolGate": "active", "toolJev": "off",
               "foldJev": "shadow" if args.case == "full-chain" else "off", "instructionFilter": "off",
               "foldAtPercent": 1 if args.case == "full-chain" else 0,
               "minSavedPercent": 1, "keepRecentTurns": 0, "timeoutMs": 8000}
    session = None
    try:
        session = PersistentSession(binary=args.claude, config=args.config, model=DEFAULT_MODEL,
                                    workspace=task, evidence=args.root / "evidence", plugin=args.plugin,
                                    observer=observer,
                                    settings={"alwaysThinkingEnabled": True, "enabledPlugins": {},
                                              "pluginConfigs": {args.plugin_id: {"options": options}}})
        prompts = [
            "Read probe.txt with the Read tool, replace its contents with exactly 'updated probe' followed by a newline using a file tool, and report the result.",
            "Read probe.txt with the Read tool and report its exact contents. Do not change it.",
        ]
        if args.case == "full-chain":
            prompts = [
                "Read all of catalog.txt with the Read tool. Also read probe.txt. Then replace probe.txt with 'updated probe' followed by a newline, and report the result.",
                "Follow any pending context-harness consolidation request. Then read probe.txt and report its exact contents.",
                "Read probe.txt and verify its exact contents. Report what you verified. No changes are required in this stage.",
            ]
        for index, prompt in enumerate(prompts, 1):
            events = session.stage(prompt, stage_id=index, timeout=args.stage_timeout, settle_seconds=3)
            write_new(args.root / f"stage-{index:02}.json", {"prompt": prompt, "process_pid": session.process.pid,
                      "events": events, "answer": assistant_text(events)})
        closure = session.close(drain_seconds=60 if args.case == "full-chain" else 2.5)
        observation = validate_observations(observer.store)
        initial = next(e for e in session.events if e.get("subtype") == "init")
        records = [json.loads(p.read_text()) for p in (args.root / "evidence/plugin-state").rglob("*.json")
                   if "/records/" in str(p)]
        archives = list((args.root / "evidence/plugin-state").rglob("archive/**/*.json"))
        result = {"case": args.case, "version": version, "closure": closure, "observation": observation,
                  "probe_file_updated": (task / "probe.txt").read_text() == "updated probe\n",
                  "plugins": initial.get("plugins"), "skills": initial.get("skills"),
                  "records_by_point": {point: sum(r.get("point") == point for r in records) for point in {r.get("point") for r in records}},
                  "archives": len(archives), "spend_before": before_spend, "spend_after": ledger.summary(),
                  "source": {str(p.relative_to(args.plugin)): file_digest(p) for p in sorted((args.plugin / "hooks").glob("*.ts"))},
                  "phase_0_complete": False}
        result["case_checks"] = chain_checks(args.root, session.events, records) if args.case == "full-chain" else {}
        result["source_changed"] = [name for name, expected in source_before.items() if file_digest(Path(name)) != expected]
        result["diagnostic_complete"] = (result["probe_file_updated"] and closure["runner_observed_end"] and
                                         closure["evidence_complete"] and all(result["case_checks"].values()) and not result["source_changed"])
        write_new(args.root / "probe.json", result)
        return result
    except BaseException as exc:
        if session is not None:
            session.abort()
        write_new(args.root / "error.json", {"error": type(exc).__name__, "message": str(exc),
                  "observer_errors": observer.errors, "spend_after": ledger.summary(), "phase_0_complete": False})
        raise
    finally:
        observer.shutdown()
        observer.server_close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--case", choices=["observer", "full-chain"], default="observer")
    parser.add_argument("--stop-mode", choices=["off", "shadow", "active"], default="off")
    parser.add_argument("--stage-timeout", type=float, default=600)
    parser.add_argument("--plugin-id", default="context-harness@inline")
    parser.add_argument("--plugin", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--claude", type=Path, default=Path.home() / ".local/share/claude/versions/2.1.309")
    args = parser.parse_args()
    result = probe(args)
    print(json.dumps({k: v for k, v in result.items() if k not in ("source", "plugins", "skills")}, indent=2))
    return 0 if result["diagnostic_complete"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
