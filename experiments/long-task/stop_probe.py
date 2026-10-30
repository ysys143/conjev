"""Controlled Stop/observer integration. Forced text is not a Q3 outcome case."""
from __future__ import annotations

import argparse
import json
import threading
from pathlib import Path

from driver import DEFAULT_MODEL, PersistentSession
from grading import check_subscription, file_digest, load, write_new
from observation import ObservationServer, validate_observations
from spend import SpendLedger

CASES = [
    ("announce", "Next, I will inspect the parser."),
    ("report", "The diagnostic is complete."),
    ("question", "Which parser should I inspect?"),
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--mode", choices=["off", "active"], required=True)
    parser.add_argument("--claude", type=Path, default=Path.home() / ".local/share/claude/versions/2.1.309")
    args = parser.parse_args()
    version = check_subscription(args.claude, args.config)
    args.root.mkdir(parents=True, exist_ok=False, mode=0o700)
    runtime = Path(__file__).resolve().parent
    plugin = runtime.parents[1]
    inputs = [*(plugin / "hooks").glob("*.ts"), plugin / ".claude-plugin/plugin.json",
              runtime / "observer/hooks/register.ts", runtime / "observer/.claude-plugin/plugin.json",
              *(runtime / f"{name}.py" for name in ["capture", "driver", "curl_transport", "grading", "observation", "spend", "stop_probe"])]
    source_before = {str(p): file_digest(p) for p in inputs}
    write_new(args.root / "source-before.json", source_before)
    task = args.root / "task"
    task.mkdir()
    (task / "fixture.txt").write_text("Unchanged Stop integration fixture.\n")
    ledger = SpendLedger(args.ledger)
    before = ledger.summary()
    observer = ObservationServer(task, args.root / "observer", ledger, args.root.name)
    threading.Thread(target=observer.serve_forever, daemon=True).start()
    session = None
    try:
        options = {"stopGate": args.mode, "toolGate": "off", "toolJev": "off", "instructions": "off",
                   "foldJev": "off", "instructionFilter": "off", "foldAtPercent": 0, "timeoutMs": 8000,
                   "stopThreshold": 0.7, "stopCap": 200}
        session = PersistentSession(binary=args.claude, config=args.config, model=DEFAULT_MODEL, workspace=task,
                                    evidence=args.root / "evidence", plugin=Path(__file__).resolve().parents[2], observer=observer,
                                    settings={"alwaysThinkingEnabled": True, "enabledPlugins": {},
                                              "pluginConfigs": {"context-harness@inline": {"options": options}}})
        rows = []
        stage = 0
        for repetition in range(1, 4):
            for name, text in CASES:
                stage += 1
                prompt = "For this controlled hook diagnostic, do not use tools. Reply with exactly this one sentence: " + text
                events = session.stage(prompt, stage_id=stage, timeout=180)
                receipt = load(observer.store / "stages" / f"{stage:02}.json")
                candidates = [load(observer.store / "candidates" / f"{i}.json") for i in receipt["candidate_ids"]]
                decisions = [load(observer.store / "decisions" / f"{i}.json") for i in receipt["candidate_ids"]]
                blocks = [d for d in decisions if "block" in d["result"]]
                stimulus = candidates[0]["event"].get("last_assistant_message", "").strip() == text
                should_block = args.mode == "active" and name == "announce"
                branch = (len(blocks) == 1 and len(candidates) == 2 and
                          candidates[1]["continuation_of"] == candidates[0]["id"] and
                          candidates[1]["event"].get("stop_hook_active") is True) if should_block else (not blocks and len(candidates) == 1)
                row = {"stage": stage, "case": name, "repetition": repetition, "stimulus_matched": stimulus,
                       "candidates": len(candidates), "blocks": len(blocks), "expected_branch": bool(branch),
                       "process_pid": session.process.pid}
                rows.append(row)
                write_new(args.root / f"stage-{stage:02}.json", {"prompt": prompt, "events": events, **row})
        closure = session.close(drain_seconds=60)
        census = validate_observations(observer.store)
        records = [load(p) for p in (args.root / "evidence/plugin-state").rglob("*.json") if "/records/" in str(p)]
        stop = [r for r in records if r.get("point") == "stop"]
        events = [load(p) for p in sorted((observer.store / "events").glob("*.json"))]
        ordering = True
        for event in events:
            if event["kind"] != "jev-reserved":
                continue
            identity = event.get("candidate_id")
            pre = [e["sequence"] for e in events if e["kind"] == "candidate-before" and e["candidate_id"] == identity]
            post = [e["sequence"] for e in events if e["kind"] == "candidate-after" and e["candidate_id"] == identity]
            ordering = ordering and len(pre) == len(post) == 1 and pre[0] < event["sequence"] < post[0]
        expected_records = census["candidates"] if args.mode == "active" else 0
        result = {"mode": args.mode, "version": version, "cases": rows, "closure": closure,
                  "census": census, "stop_records": len(stop), "stop_records_reconciled": len(stop) == expected_records,
                  "observer_before_jev": ordering, "spend_before": before, "spend_after": ledger.summary(),
                  "phase_0_complete": False, "phase_1_complete": False, "q3_outcome": False}
        result["source_changed"] = [name for name, expected in source_before.items() if file_digest(Path(name)) != expected]
        result["diagnostic_complete"] = (all(r["stimulus_matched"] and r["expected_branch"] for r in rows) and
                                          closure["runner_observed_end"] and closure["evidence_complete"] and
                                          result["stop_records_reconciled"] and ordering and not result["source_changed"])
        write_new(args.root / "probe.json", result)
        print(json.dumps(result, indent=2))
        return 0 if result["diagnostic_complete"] else 2
    except BaseException as exc:
        if session is not None:
            session.abort()
        write_new(args.root / "error.json", {"error": type(exc).__name__, "message": str(exc),
                  "observer_errors": observer.errors, "spend_after": ledger.summary()})
        raise
    finally:
        observer.shutdown()
        observer.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
