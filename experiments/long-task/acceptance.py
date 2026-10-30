"""Audit the closed persistent-driver diagnostic from original evidence.

This accepts one phase-0 component only. It cannot accept the entire phase,
device cases, pilots, or main study.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from driver import DEFAULT_EFFORT, DEFAULT_MODEL
from grading import load, write_new
from observation import validate_observations


def content_text(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for child in value:
            yield from content_text(child)
    elif isinstance(value, dict) and value.get("type") == "text" and isinstance(value.get("text"), str):
        yield value["text"]


def request_evidence(body: dict) -> dict:
    pointers, notes = [], []
    for message in body.get("messages", []):
        if message.get("role") != "user":
            continue
        blocks = message.get("content", [])
        if isinstance(blocks, str):
            notes.append(blocks)
            continue
        for block in blocks:
            if block.get("type") == "tool_result":
                pointers += [t for t in content_text(block.get("content")) if t.startswith("[folded ")]
            elif block.get("type") == "text":
                notes += list(content_text(block))
    # In particular, never treat examples in a tool description as a folded
    # result, nor an assistant quoting a note as delivery of that note.
    return {"folded_pointers_delivered": bool(pointers),
            "consolidation_note_delivered": any(t.startswith("[context-harness] Before this conversation is folded") for t in notes),
            "post_compaction_note_delivered": any(t.startswith("[context-harness] This conversation was just compacted") for t in notes)}


def conditional_ending(message: str) -> bool:
    prose = re.sub(r"```[\s\S]*?```", "\n\n", message)
    blocks = [b.strip() for b in re.split(r"\n\s*\n", prose) if b.strip() and not re.fullmatch(r"(?:\|.*\|\s*)+|[-=*_`\s]+", b.strip(), re.S)]
    sentences = [s.strip() for s in re.split(r"(?<=[.!?。])\s+|\n+", blocks[-1][-600:] if blocks else "") if s.strip()]
    return bool(sentences and re.search(r"[가-힣](시면|으면|면)(\s|,)|let me know|\bif you\b|\bonce\b|\bwhen (it|they|the|that|this|you|all|both)\b|\bafter (it|they|the|that|this|you)\b|\bas soon as\b", sentences[-1], re.I))


def stops_reconciled(candidates: list[dict], records: list[dict]) -> bool:
    # Questions and conditional endings are declared legitimate zero-call
    # cases; verify the actual ending instead of accepting a skip label alone.
    by_prompt = {c["event"].get("prompt_id"): c["event"] for c in candidates}
    if len(by_prompt) != len(candidates) or None in by_prompt or len(records) != len(candidates):
        return False
    if {r.get("joinKey") for r in records} != set(by_prompt):
        return False
    for record in records:
        if record.get("mode") != "shadow" or record.get("error"):
            return False
        event = by_prompt[record["joinKey"]]
        if record.get("skipped") == "question":
            if not event.get("last_assistant_message", "").rstrip().endswith(("?", "？")) or "jev" in record:
                return False
        elif record.get("skipped") == "conditional":
            if "jev" in record or not conditional_ending(event.get("last_assistant_message", "")):
                return False
        elif record.get("skipped") is not None or not isinstance(record.get("jev"), (int, float)):
            return False
    return True


def audit(root: Path) -> dict:
    probe = load(root / "probe.json")
    observations = validate_observations(root / "observer")
    stages = [load(p) for p in sorted(root.glob("stage-*.json"))]
    requests = [load(p) for p in (root / "evidence/requests").glob("*.json")]
    requests = [r for r in requests if r.get("method") == "POST" and r.get("path", "").split("?", 1)[0] == "/v1/messages"]
    bodies = [json.loads(r["request_body"]) for r in requests]
    delivered = [request_evidence(b) for b in bodies]
    records = [load(p) for p in (root / "evidence/plugin-state").rglob("*.json") if "/records/" in str(p)]
    lifecycle = [load(p) for p in sorted((root / "observer/events").glob("*.json"))]
    stop = [r for r in records if r.get("point") == "stop"]
    candidates = [load(p) for p in (root / "observer/candidates").glob("*.json")]
    checks = {
        "three_closed_stages": observations["stages"] == len(stages) == 3,
        "same_live_process": len({s.get("process_pid") for s in stages}) == 1 and all(type(s.get("process_pid")) is int for s in stages),
        "observed_clean_close": probe.get("closure", {}).get("runner_observed_end") is True,
        "complete_original_captures": bool(requests) and all(r.get("complete") and not r.get("body_redacted") for r in requests),
        "executor_settings_on_wire": bool(bodies) and all(b.get("model") == DEFAULT_MODEL and b.get("output_config", {}).get("effort") == DEFAULT_EFFORT and
                                                          b.get("thinking", {}).get("type") == "adaptive" for b in bodies),
        "source_unchanged_during_execution": probe.get("source_changed") == [],
        "automatic_compact_command": any(e.get("name") == "compact-command-before" and e.get("origin") == {"kind": "plugin", "name": "context-harness"} for e in lifecycle),
        "folded_pointers_returned": any(e.get("name") == "compact-after" and e.get("pointers", 0) > 0 for e in lifecycle),
        "all_stop_candidates_reconciled": stops_reconciled(candidates, stop),
        "fold_shadow_judgment": any(r.get("point") == "fold" and "jev" in r and not r.get("error") for r in records),
        "consolidate_skill_called": bool(probe.get("case_checks", {}).get("consolidate_skill_called")),
        "task_file_verified": probe.get("probe_file_updated") is True,
    }
    checks.update({name: any(d[name] for d in delivered) for name in ["folded_pointers_delivered", "consolidation_note_delivered", "post_compaction_note_delivered"]})
    return {"component": "persistent_driver_full_chain", "full_chain_complete": all(checks.values()),
            "checks": checks, "observations": observations, "phase_0_complete": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.run)
    write_new(args.output, result)
    print(json.dumps(result, indent=2))
    return 0 if result["full_chain_complete"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
