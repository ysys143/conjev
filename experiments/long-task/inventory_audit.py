"""Byte-preserving instruction inventory checks over closed live evidence."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from grading import load, write_new


def intact(inventories: list[dict], expected: dict[str, str]) -> bool:
    if not inventories or not expected:
        return False
    for event in inventories:
        files = event.get("files")
        if not isinstance(files, list) or any(f.get("kind") == "memory" for f in files):
            return False
        actual = {f["path"]: f["content"] for f in files}
        if len(actual) != len(files) or actual != expected:
            return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    events = [load(p) for p in sorted((args.run / "observer/events").glob("*.json"))]
    inventory = [e for e in events if e.get("name") == "instruction-inventory"]
    compact = [e for e in events if e.get("name") == "compact-after"]
    expected_file = args.run / "task/CLAUDE.md"
    expected = {str(expected_file): expected_file.read_text()}
    before = [e for e in inventory if compact and e["sequence"] < compact[0]["sequence"]]
    after = [e for e in inventory if compact and e["sequence"] > compact[-1]["sequence"]]
    checks = {"full_instruction_bytes_before": intact(before, expected), "full_instruction_bytes_after": intact(after, expected)}
    result = {"checks": checks, "passed": all(checks.values()), "phase_0_complete": False,
              "limit": "Controlled diagnostic source-file inventory; other instruction configurations require their own expected manifests"}
    write_new(args.output, result)
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
