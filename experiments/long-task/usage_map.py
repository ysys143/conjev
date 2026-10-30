"""Map Jev records to originating calls without summing copied batch usage."""
from __future__ import annotations

import argparse
import json
import sqlite3
from contextlib import closing
from pathlib import Path

from grading import file_digest, load, write_new
from spend import NANODOLLARS_PER_INPUT_TOKEN, RESERVATION

POINTS = {"stop", "tool", "fold", "instructions", "instr-filter", "instr-defer", "instr-tool"}
LOCAL_SKIPS = {"no-key", "cap", "circuit"}
SOURCES = ["hooks/register.ts", "hooks/fragment-flow.ts", "hooks/fold-flow.ts", "hooks/tool-flow.ts", "hooks/filter-flow.ts", "hooks/instruction-docs.ts", "hooks/instructions.ts"]
RULES = {
    "stop": "One record per eligible Stop; skipped/no-key/cap/circuit records make no outgoing call.",
    "tool": "Only facts.kind=jev may carry a call. Floor records and cached target hits make no Jev call.",
    "fold": "One batch per session and timestamp; at most 24 rows. Usage is on the first row only; at most 48 sampled results per compaction.",
    "instructions": "One batch per session, prompt joinKey and timestamp. Its usage is copied onto every fragment decision, including keyword decisions alongside a Jev call; count that usage once.",
    "instr-filter": "Only decision=sent is a call record, one per scope-1 or cover-1 request. Per-chunk readings carry no additional usage.",
    "instr-defer": "One batch per session, request joinKey and timestamp. Usage appears on the first deferred chunk only.",
    "instr-tool": "A deterministic observed tool-use signature, never a Jev call.",
}


def source_map(root: Path) -> dict:
    return {"version": 1, "rules": RULES, "source_sha256": {p: file_digest(root / p) for p in SOURCES},
            "limits": ["Per-device live acceptance belongs to phase 1, not this accounting fixture.",
                       "Missing usage is unknown, not zero. Expected call count must come from the independent study ledger.",
                       "Expected record multiplicities and missing individual batch members are checked by the device-case manifest."]}


def account(records: list[dict], *, expected_calls: int) -> dict:
    if type(expected_calls) is not int or expected_calls < 0:
        raise ValueError("An independent originating-call count is required")
    ids = [r.get("id") for r in records]
    if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("Duplicate or missing raw record ID")
    groups: dict[tuple, list[dict]] = {}
    record_counts = {p: 0 for p in POINTS}
    for record in records:
        point = record.get("point")
        if point not in POINTS:
            raise ValueError("Unknown device point; cannot silently drop its usage")
        record_counts[point] += 1
        usage = record.get("usage")
        deterministic = point == "instr-tool" or (point == "tool" and record.get("facts", {}).get("kind") != "jev") or (point == "instr-filter" and record.get("decision") != "sent")
        if deterministic:
            if usage is not None:
                raise ValueError("Usage on a deterministic record contradicts the source map")
            continue
        if record.get("skipped") or record.get("error") in LOCAL_SKIPS:
            if usage is not None:
                raise ValueError("A zero-call skip cannot carry billed usage")
            continue
        called = usage is not None or record.get("error") is not None or record.get("jev") is not None or (point == "instr-filter" and record.get("decision") == "sent")
        if not called:
            continue
        if point in ("fold", "instructions", "instr-defer"):
            if not isinstance(record.get("ts"), str) or not isinstance(record.get("sessionId"), str):
                raise ValueError("Batch identity is missing")
            key = (point, record["sessionId"], record.get("joinKey") if point != "fold" else None, record["ts"])
        else:
            key = (point, record["id"])
        groups.setdefault(key, []).append(record)
    totals = {p: {"records": record_counts[p], "calls": 0, "known_calls": 0, "unknown_calls": 0,
                  "input_tokens": 0, "output_tokens": 0, "known_spend_usd": 0.0, "unknown_reserved_usd": 0.0} for p in sorted(POINTS)}
    for key, members in groups.items():
        point = key[0]
        usages = [r["usage"] for r in members if r.get("usage") is not None]
        total = totals[point]
        total["calls"] += 1
        if not usages:
            total["unknown_calls"] += 1
            total["unknown_reserved_usd"] += RESERVATION / 1e9
            continue
        if any(u != usages[0] for u in usages):
            raise ValueError("Conflicting copies of one call's usage")
        usage = usages[0]
        if any(type(usage.get(k)) is not int or usage[k] < 0 for k in ["input_tokens", "output_tokens"]):
            raise ValueError("Invalid token usage")
        total["known_calls"] += 1
        total["input_tokens"] += usage["input_tokens"]
        total["output_tokens"] += usage["output_tokens"]
        total["known_spend_usd"] += usage["input_tokens"] * NANODOLLARS_PER_INPUT_TOKEN / 1e9
    calls = sum(t["calls"] for t in totals.values())
    if calls != expected_calls:
        raise ValueError(f"Record/call census mismatch: {calls} reconstructed, {expected_calls} independently reserved")
    return {"expected_calls": expected_calls, "calls": calls, "unknown_usage_calls": sum(t["unknown_calls"] for t in totals.values()),
            "known_spend_usd": sum(t["known_spend_usd"] for t in totals.values()), "by_point": totals}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-map", type=Path)
    parser.add_argument("--state", type=Path)
    parser.add_argument("--ledger", type=Path)
    parser.add_argument("--run-id")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    mapping = source_map(root)
    if args.write_map:
        write_new(args.write_map, mapping)
        return 0
    if not all([args.state, args.ledger, args.run_id, args.output]):
        parser.error("Supply state, independent ledger, run ID, and new output")
    frozen = load(Path(__file__).resolve().parent / "jev-usage-map.json")
    if frozen != mapping:
        raise ValueError("The source-bound device usage map needs revalidation")
    records = [load(p) for p in args.state.rglob("*.json") if "records" in p.relative_to(args.state).parts]
    with closing(sqlite3.connect(args.ledger)) as db:
        expected = db.execute("SELECT count(*) FROM calls WHERE run=?", (args.run_id,)).fetchone()[0]
    result = account(records, expected_calls=expected)
    write_new(args.output, result)
    print(json.dumps({k:v for k,v in result.items() if k != "by_point"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
