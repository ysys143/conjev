"""Four staged pilot runs, admitted only after complete phase-1 acceptance."""
from __future__ import annotations

import argparse
import json
import random
import re
import subprocess
import threading
import time
from pathlib import Path

from contamination import Scope, audit as contamination_audit, captured_calls, collect
from driver import DEFAULT_MODEL, PersistentSession, assistant_text
from grading import check_subscription, digest, file_digest, load, write_new
from observation import ObservationServer, validate_observations, verify_snapshot
from spend import SpendLedger
from stage_scoring import score_stage
from task_generator import COMPACTIONS, make_case
from watcher import Watcher

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CEILINGS = {"stage_seconds": 600, "run_seconds": 7200, "tool_calls": 400, "input_tokens": 30_000_000, "output_tokens": 1_000_000, "clarifications_per_stage": 2}
CLARIFICATION_REPLY = "Use your judgement within the constraints."


def asks_for_clarification(events):
    text=assistant_text(events).strip()
    return text.endswith(('?','？')) or bool(re.search(r'(?:^|\n)(?:Please provide|I need you to provide)\b',text,re.I))


class PilotObserver(ObservationServer):
    def begin_stage(self,stage):
        super().begin_stage(stage)
        self.clarifications=0
        self.awaiting_clarification=False

    def finish_stage(self,events):
        if self.stage<=12 and asks_for_clarification(events) and self.clarifications<CEILINGS['clarifications_per_stage']:
            self.clarifications+=1
            self.awaiting_clarification=True
            write_new(self.store/'clarifications'/f'{self.stage:02}-{self.clarifications}.json',{'stage':self.stage,'events':events,'scripted_reply':CLARIFICATION_REPLY})
            return {'awaiting_clarification':True}
        self.awaiting_clarification=False
        return super().finish_stage(events)


def text_of(value):
    if isinstance(value, str): return value
    if isinstance(value, list): return "\n".join(text_of(v) for v in value)
    if isinstance(value, dict): return text_of(value.get("text", value.get("content", "")))
    return ""


def action_rows(events):
    calls, results = collect(events)
    return [{**c, "succeeded": all(not r.get("is_error", False) for r in results[c["id"]]) if c["id"] in results else None,
             "output": "\n".join(text_of(r.get("content", "")) for r in results.get(c["id"], []))} for c in calls]


def usage_at(evidence):
    rows = [load(p) for p in (evidence / "requests").glob("*.json")]
    totals = {"input_tokens": 0, "output_tokens": 0}
    for row in rows:
        usage = row.get("usage") or {}
        totals["input_tokens"] += sum(usage.get(k, 0) for k in ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"])
        totals["output_tokens"] += usage.get("output_tokens", 0)
    totals["requests"] = len(rows)
    return totals


def exposure_at(evidence, definition):
    rows = [load(p) for p in (evidence / "requests").glob("*.json")]
    message = max((r for r in rows if r.get("path", "").split("?", 1)[0] == "/v1/messages"), key=lambda r: r["started_at"])
    body = json.loads(message["request_body"])
    messages = body.get("messages", [])
    calls, results = collect(messages)
    opportunities = []
    for channel, marker in zip(definition["channels"], definition["markers"]):
        eligible = []
        for call in calls:
            if call["name"] != "Bash" or not re.search(r"\bemit\.py\s+" + re.escape(channel) + r"\b", call["input"].get("command", "")): continue
            output = "\n".join(text_of(r.get("content", "")) for r in results.get(call["id"], []))
            result_index = next((i for i, m in enumerate(messages) if any(b.get("tool_use_id") == call["id"] for b in m.get("content", []) if isinstance(b, dict))), None)
            later_prompts = sum(m.get("role") == "user" and any(b.get("type") == "text" and str(b.get("text", "")).strip().startswith("Stage ") for b in m.get("content", []) if isinstance(b, dict)) for m in messages[(result_index or 0) + 1:])
            if marker in output and len(output) >= 1000 and later_prompts >= 2:
                eligible.append({"id": call["id"], "chars": len(output), "later_stage_prompts": later_prompts})
        opportunities.append({"channel": channel, "eligible": eligible})
    found = [o["eligible"][-1] for o in opportunities if o["eligible"]]
    return {"boundary": definition["boundary"], "opportunities": opportunities, "eligible_results": len(found), "chars": sum(f["chars"] for f in found),
            "met": len(found) >= 2 and sum(f["chars"] for f in found) >= definition["minimum_chars"], "source_request": message["id"]}


def source_identity():
    paths = [*(REPO / "hooks").glob("*.ts"), *(REPO / "skills").rglob("SKILL.md"), REPO / ".claude-plugin/plugin.json",
             *(HERE / "task_families").glob("*.py"), *(HERE / f"{n}.py" for n in ["driver", "capture", "curl_transport", "grading", "observation", "spend", "watcher", "stage_scoring", "task_generator", "contamination", "pilot_run", "pilot_judge", "pilot_score"]),
             HERE / "observer/hooks/register.ts", Path('/usr/bin/curl')]
    return {str(p): file_digest(p) for p in paths}


def run_arm(args, case, arm, root):
    task = root / "task"
    case.materialize(task, arm)
    evidence = root / "evidence"
    fragments = root / "empty-fragments"
    fragments.mkdir()
    ledger = SpendLedger(args.ledger)
    before = ledger.summary()
    observer = PilotObserver(task, root / "observer", ledger, f"{args.root.name}-{arm}")
    threading.Thread(target=observer.serve_forever, daemon=True).start()
    watcher = Watcher(task, root / "fs-events.jsonl")
    session = None
    started = time.monotonic()
    stages, exposure, compacts = [], [], []
    try:
        watcher.start_handshake()
        options = {"stopGate": {"H": "shadow", "S0": "off", "S1": "active"}.get(arm, "off"), "toolGate": "off", "toolJev": "shadow",
                   "instructions": "shadow", "foldJev": "shadow", "instructionFilter": "active", "fragmentsDir": str(fragments),
                   "stopThreshold": 0.7, "timeoutMs": 2000, "stopCap": 200}
        session = PersistentSession(binary=args.claude, config=args.config, model=DEFAULT_MODEL, workspace=task, evidence=evidence, plugin=REPO if arm != "V" else None,
            observer=observer, settings={"alwaysThinkingEnabled": True, "enabledPlugins": {}, "pluginConfigs": {"context-harness@inline": {"options": options}} if arm != "V" else {}})
        write_new(root / "run-start.json", {"arm": arm, "session_id": session.session_id, "task_identity": case.identity, "spend_before": before, "ceilings": CEILINGS})
        for i, prompt in enumerate(case.prompts, 1):
            watcher.stage = i
            events = session.stage(prompt, stage_id=i, timeout=CEILINGS["stage_seconds"])
            while observer.awaiting_clarification:
                events+=session.stage(CLARIFICATION_REPLY,timeout=CEILINGS['stage_seconds'])
                observer.finish_stage(events)
            row = load(observer.store / "stages" / f"{i:02}.json")
            stages.append(row)
            write_new(root / "stages" / f"{i:02}.json", {"prompt": prompt, "events": events, "observer_receipt": row,"clarifications":observer.clarifications,"clarification_ceiling_reached":observer.clarifications==CEILINGS['clarifications_per_stage'] and asks_for_clarification(events)})
            cursor = len(watcher.rows)
            (task / ".evaluator-stage-barrier").write_text(str(i))
            if not watcher.wait_for(".evaluator-stage-barrier", after=cursor): raise RuntimeError("Stage watcher barrier missing")
            if i in COMPACTIONS:
                exposure.append(exposure_at(evidence, next(e for e in case.exposure if e["boundary"] == i)))
                compact_events = session.stage("/compact", timeout=CEILINGS["stage_seconds"])
                compacts.append({"after_stage": i, "events": compact_events})
            usage = usage_at(evidence)
            calls = sum(len(action_rows(s["events"])) for s in stages)
            if time.monotonic() - started >= CEILINGS["run_seconds"] or calls >= CEILINGS["tool_calls"] or any(usage[k] >= CEILINGS[k] for k in ["input_tokens", "output_tokens"]):
                raise RuntimeError("Pilot ceiling reached; preserve the reached-stage record")
        task_usage=usage_at(evidence)
        task_seconds=time.monotonic()-started
        restatement = session.stage("State the goal, the constraints and the decisions.", stage_id=13, timeout=CEILINGS["stage_seconds"])
        write_new(root / "restatement.json", {"prompt": "State the goal, the constraints and the decisions.", "events": restatement, "answer": assistant_text(restatement)})
        closure = session.close(drain_seconds=60)
        session = None
        write_new(root / "closure.json", closure)
        if not (closure["runner_observed_end"] and closure["evidence_complete"]):
            raise RuntimeError("Pilot executor did not close with complete evidence")
        watcher.close()
        census = validate_observations(observer.store)
        # Private answers appear on disk only after the executor has terminated.
        write_new(root / "private-definition.json", case.private_definition())
        scores = [score_stage(observer.store / "snapshots" / row["snapshot"], contract, watcher_events=watcher.rows,
                              tool_calls=action_rows(row["events"]), stage=i) for i, (row, contract) in enumerate(zip(stages, case.contracts), 1)]
        write_new(root / "stage-scores.json", {"stages": scores})
        reconciliations = []
        all_calls, all_results = captured_calls(evidence, workspace=task, reconciliation=reconciliations)
        write_new(root / "tool-call-reconciliation.json", {"calls": len(all_calls), "normalizations": reconciliations})
        project = args.config / "projects" / re.sub(r"[^a-zA-Z0-9_-]", "-", str(task.resolve()))
        scope = Scope(task, project / (load(evidence / "launch.json")["session_id"] + ".jsonl"), tuple((REPO / "skills").glob("*/SKILL.md")))
        contamination = contamination_audit(all_calls, all_results, scope)
        write_new(root / "contamination.json", contamination)
        captures = [load(p) for p in (evidence / "requests").glob("*.json")]
        bodies = [json.loads(c["request_body"]) for c in captures if c.get("path", "").split("?", 1)[0] == "/v1/messages"]
        settings_match = bool(bodies) and all(b.get("model") == DEFAULT_MODEL and b.get("output_config", {}).get("effort") == "max" and b.get("thinking", {}).get("type") == "adaptive" for b in bodies)
        result = {"arm": arm, "task_identity": case.identity, "stage_count": len(scores), "scores_complete": all(s["complete"] for s in scores),
                  "completed_stages": sum(s["all_pass"] is True for s in scores) if all(s['complete'] for s in scores) else None,
                  "known_completed_stages":sum(s['all_pass'] is True for s in scores),
                  "goal_failures": sum(s["goal_keeping_failures"] for s in scores) if all(s['goal_keeping_failures'] is not None for s in scores) else None,
                  "known_goal_failures":sum(s['known_goal_failures'] for s in scores),
                  "final_task": scores[-1]["task_hidden_checks"], "exposure": exposure, "compactions": compacts, "closure": closure, "census": census,
                  "actual_model_settings_match": settings_match, "usage": usage_at(evidence), "task_usage":task_usage,"task_wall_seconds":task_seconds,"wall_seconds": time.monotonic() - started,
                  "spend_before": before, "spend_after": ledger.summary(), "contamination": contamination["classification"], "semantic_grading_complete": False,
                  "phase_1_complete": args.admission.get("phase_1_complete", False)}
        write_new(root / "run-result.json", result)
        return result
    except BaseException as exc:
        if session is not None:
            session.abort()
            write_new(root / "abort.json", {"exit_code": session.process.returncode,
                      "reader_closed": not session.reader.is_alive(), "evidence_complete": session.captures_complete()})
        if watcher.child.poll() is None: watcher.close()
        write_new(root / "error.json", {"error": type(exc).__name__, "message": str(exc), "completed_stage_count": len(stages), "observer_errors": observer.errors})
        raise
    finally:
        observer.shutdown()
        observer.server_close()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--ledger", type=Path, required=True)
    p.add_argument("--admission", type=Path, required=True)
    p.add_argument("--claude", type=Path, default=Path.home() / ".local/share/claude/versions/2.1.309")
    args = p.parse_args()
    admission_path=args.admission
    args.admission = load(args.admission)
    if not (args.admission.get("phase_1_complete") is True and args.admission.get('case_count')==92 and args.admission.get('live_executions')==276
            and args.admission.get('deterministic_hook_cases')==89 and args.admission.get('product_mutants_rejected')==4 and args.admission.get('q3_negative_checks_passed') is True):
        raise ValueError("Pilot prerequisite is incomplete")
    manifest_path=admission_path.parent/'manifest.json'
    if file_digest(manifest_path)!=args.admission['manifest_sha256']:raise ValueError('Phase-1 manifest changed')
    phase1_manifest=load(manifest_path)
    if any(file_digest(Path(path))!=value for path,value in phase1_manifest['source_sha256'].items()):raise ValueError('Phase-1 execution sources changed')
    if phase1_manifest.get('curl_binary_sha256') != file_digest(Path('/usr/bin/curl')):raise ValueError('Phase-1 transport binary changed or was not pinned')
    version = check_subscription(args.claude, args.config)
    args.root.mkdir(parents=True, exist_ok=False, mode=0o700)
    case = make_case("ledger", 71)
    order = [["V", "H"], ["S0", "S1"]]
    rng = random.Random(71)
    for pair in order: rng.shuffle(pair)
    rng.shuffle(order)
    sources = source_identity()
    sources[str(args.claude)]=file_digest(args.claude)
    write_new(args.root / "pilot-spec.json", {"version": 4, "family": "ledger", "seed": 71, "task_identity": case.identity, "order": order, "ceilings": CEILINGS,
              "upstream_transport": "Session-scoped pooled HTTPS connections; failed or incomplete upstream captures still reject the trial.",
              "revision_reason": "Owner requested repairing and completing the pilot. New equal ceilings accommodate observed pilot usage; earlier ceiling outcomes remain unchanged and are not pooled with these fresh pairs.",
              "executor_model": DEFAULT_MODEL, "executor_effort": "max", "judge_model": "claude-opus-5-5", "judge_effort": "low", "cli_version": version,
              "admission": args.admission, "source_sha256": sources})
    rows = []
    for pair in order:
        for arm in pair:
            root = args.root / arm
            root.mkdir()
            rows.append(run_arm(args, case, arm, root))
            if any(file_digest(Path(path)) != expected for path, expected in sources.items()): raise ValueError("Pilot sources changed during execution")
    write_new(args.root / "execution-summary.json", {"runs": rows, "executions_complete": len(rows) == 4, "semantic_grading_complete": False, "main_runs": 0})
    print(json.dumps({"executions_complete": len(rows) == 4, "main_runs": 0, "semantic_grading_complete": False}))


if __name__ == "__main__":
    main()
