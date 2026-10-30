"""Candidate CLI skill availability/invocation checks, separate from hook tests."""
from __future__ import annotations

import argparse
import json
import threading
from pathlib import Path

from driver import DEFAULT_MODEL, PersistentSession, assistant_text
from grading import check_subscription, file_digest, load, write_new
from observation import ObservationServer
from spend import SpendLedger


def skill_calls(events):
    return [b for e in events if e.get("type") == "assistant" for b in e.get("message", {}).get("content", [])
            if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == "Skill"]


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
    runtime, repo = Path(__file__).resolve().parent, Path(__file__).resolve().parents[2]
    sources = [*(repo / "hooks").glob("*.ts"), *(repo / "skills").rglob("SKILL.md"), repo / ".claude-plugin/plugin.json",
               *(runtime / f"{n}.py" for n in ["capture", "driver", "grading", "observation", "spend", "device_skill_probe"]),
               runtime / "observer/hooks/register.ts"]
    identity = {str(path): file_digest(path) for path in sources}
    write_new(args.root / "source-before.json", identity)
    ledger = SpendLedger(args.ledger)
    results, session, observer = [], None, None
    try:
        for repetition in range(1, args.repetitions + 1):
            for skill in ["project-state", "consolidate", None]:
                name = skill or "vanilla"
                run = args.root / f"{name}-{repetition}"
                task = run / "task"
                task.mkdir(parents=True)
                (task / "INTENT.md").write_text("Verify the installed skill's availability and actual invocation. This is an evaluator-owned diagnostic.\n")
                (task / "PHASE.md").write_text("Now: invoke the requested skill and report its guidance.\n")
                (task / "sessions").mkdir()
                observer = ObservationServer(task, run / "observer", ledger, f"{args.root.name}-{name}-{repetition}")
                threading.Thread(target=observer.serve_forever, daemon=True).start()
                options = {"stopGate": "off", "toolGate": "off", "toolJev": "off", "instructions": "off", "foldJev": "off", "instructionFilter": "off", "foldAtPercent": 0}
                session = PersistentSession(binary=args.claude, config=args.config, model=DEFAULT_MODEL, workspace=task, evidence=run / "evidence", plugin=repo if skill else None, observer=observer,
                    settings={"alwaysThinkingEnabled": True, "enabledPlugins": {}, "pluginConfigs": {"context-harness@inline": {"options": options}} if skill else {}})
                prompt = (f"This is a controlled availability diagnostic. Invoke the Skill tool with skill='context-harness:{skill}' exactly once, then briefly report the guidance it returned. Do not edit any files or call other tools."
                          if skill else "This is a controlled inventory diagnostic. Do not use any tools. Reply with exactly OK.")
                events = session.stage(prompt, stage_id=1, timeout=180)
                closure = session.close(drain_seconds=2.5)
                initial = next(e for e in session.events if e.get("subtype") == "init")
                calls = skill_calls(events)
                inventory = initial.get("skills", [])
                tool_results = [b for e in events if e.get("type") == "user" for b in e.get("message", {}).get("content", []) if isinstance(b, dict) and b.get("type") == "tool_result"]
                expected = f"context-harness:{skill}" if skill else None
                checks = {"clean_close": closure["runner_observed_end"] and closure["evidence_complete"],
                          "inventory_exact": sorted(inventory) == (["context-harness:consolidate", "context-harness:project-state", "context-harness:tune-policy"] if skill else []),
                          "requested_skill_invoked_once": len(calls) == (1 if skill else 0) and (not skill or calls[0].get("input", {}).get("skill") == expected),
                          "vanilla_reply": skill is not None or assistant_text(events) == "OK",
                          "no_jev_calls": ledger.call_count(f"{args.root.name}-{name}-{repetition}") == 0}
                # A call in the assistant's text is insufficient; require its
                # corresponding successful tool result in the real stream.
                if skill:
                    checks["skill_result_success"] = any(b.get("tool_use_id") == calls[0].get("id") and not b.get("is_error", False) for b in tool_results) if calls else False
                    body = (repo / f"skills/{skill}/SKILL.md").read_text().split("---", 2)[-1].strip()
                    delivered = "\n".join(b.get("text", "") for e in events if e.get("type") == "user" for b in e.get("message", {}).get("content", []) if isinstance(b, dict) and b.get("type") == "text")
                    checks["exact_skill_body_delivered"] = body in delivered
                row = {"case": f"skills.{skill}-listed-and-invoked" if skill else "skills.vanilla-no-harness-skills", "repetition": repetition,
                       "checks": checks, "passed": all(checks.values()), "inventory": inventory, "skill_calls": calls, "closure": closure,
                       "model_compliance_observation": checks["requested_skill_invoked_once"], "hook_correctness_claim": False}
                write_new(run / "case.json", row)
                results.append(row)
                session = None
                observer.shutdown()
                observer.server_close()
                observer = None
                if not row["passed"]: raise ValueError(f"Candidate skill diagnostic failed: {name}, repetition {repetition}")
        changed = [path for path, digest in identity.items() if file_digest(Path(path)) != digest]
        result = {"version": version, "cases": results, "source_changed": changed, "candidate_only": True, "phase_1_complete": False,
                  "credited_device_cases": 0, "passed": all(r["passed"] for r in results) and not changed}
        write_new(args.root / "probe.json", result)
        print(json.dumps({"passed": result["passed"], "case_executions": len(results), "source_changed": changed, "phase_1_complete": False}))
        return 0 if result["passed"] else 2
    except BaseException as exc:
        if session is not None: session.abort()
        write_new(args.root / "error.json", {"error": type(exc).__name__, "message": str(exc), "cases_completed": len(results)})
        raise
    finally:
        if observer is not None:
            observer.shutdown()
            observer.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
