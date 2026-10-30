"""Audit explicit captured tool targets against a run's allowed read scope.

This is not an OS syscall trace. Opaque commands and missing outcomes remain
unresolved; a path printed in user/tool data is never treated as a file access.
"""
from __future__ import annotations

import json
import shlex
from dataclasses import dataclass
from pathlib import Path

from grading import canonical, digest


@dataclass
class Scope:
    task: Path
    session_record: Path
    plugin_skills: tuple[Path, ...] = ()

    def resolve(self, value: str) -> Path:
        path = Path(value).expanduser()
        return (path if path.is_absolute() else self.task / path).resolve()

    def allowed(self, path: Path) -> bool:
        return path.is_relative_to(self.task.resolve()) or path == self.session_record.resolve() or path in {p.resolve() for p in self.plugin_skills}


def collect(events: list[dict]) -> tuple[list[dict], dict[str, list[dict]]]:
    calls, results = {}, {}
    for event in events:
        message = event.get("message", event)
        role = message.get("role", event.get("type"))
        blocks = message.get("content", [])
        if not isinstance(blocks, list):
            continue
        for block in blocks:
            if block.get("type") == "tool_use" and role == "assistant":
                item = {"id": block["id"], "name": block["name"], "input": block.get("input", {})}
                if item["id"] in calls and calls[item["id"]] != item:
                    raise ValueError("Conflicting captured tool call identity")
                calls[item["id"]] = item
            elif block.get("type") == "tool_result" and role == "user":
                results.setdefault(block["tool_use_id"], []).append(block)
    return list(calls.values()), results


def history_normalization(original: dict, wire: dict, workspace: Path) -> str | None:
    """Recognize only observed CLI history rewrites, without changing actions."""
    if original["name"] != wire["name"]:
        return None
    left, right = dict(original["input"]), dict(wire["input"])
    if original["name"] == "Edit":
        for value in (left, right):
            if value.get("replace_all") is False:
                del value["replace_all"]
        if left == right:
            return "edit-default-false-omitted"
    if original["name"] == "Bash":
        a, b = left.pop("command", None), right.pop("command", None)
        prefix = "cd " + shlex.quote(str(workspace.resolve())) + " && "
        if left == right and isinstance(a, str) and isinstance(b, str) and (b == prefix + a or a == prefix + b):
            return "bash-task-cwd-prefix"
    return None


def captured_calls(run: Path, *, workspace: Path | None = None,
                   reconciliation: list[dict] | None = None) -> tuple[list[dict], dict[str, list[dict]]]:
    # A source is internally strict. Only the boundary between stdout actions
    # and the CLI's normalized request history allows the two named rewrites.
    events = [json.loads(s) for s in (run / "stdout.jsonl").read_text().splitlines()]
    originals, results = collect(events)
    wire_events = []
    for path in sorted((run / "requests").glob("*.json")):
        record = json.loads(path.read_text())
        if record.get("path", "").split("?", 1)[0] == "/v1/messages":
            wire_events.extend(json.loads(record["request_body"]).get("messages", []))
    wire_calls, wire_results = collect(wire_events)
    calls = {c["id"]: c for c in originals}
    workspace = workspace or run.parent / "task"
    for wire in wire_calls:
        original = calls.get(wire["id"])
        if original is None:
            calls[wire["id"]] = wire
        elif original != wire:
            kind = history_normalization(original, wire, workspace)
            if kind is None:
                raise ValueError("Unexplained cross-source tool call identity change")
            if reconciliation is not None:
                reconciliation.append({"call_id": wire["id"], "normalization": kind,
                                       "stdout_sha256": digest(original), "wire_sha256": digest(wire)})
    for identifier, values in wire_results.items():
        known = {canonical(v) for v in results.get(identifier, [])}
        for value in values:
            if canonical(value) not in known:
                results.setdefault(identifier, []).append(value)
                known.add(canonical(value))
    return list(calls.values()), results


def bash_targets(command: str) -> tuple[list[str], bool]:
    if any(marker in command for marker in ("$(", "`", "<<", "${", "$HOME", " -c ")):
        return [], False
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|<>")
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return [], False
    groups, current = [], []
    for token in tokens:
        if token in (";", "&&", "||", "|"):
            if current:
                groups.append(current)
            current = []
        else:
            current.append(token)
    if current:
        groups.append(current)
    paths = []
    for group in groups:
        arguments = []
        index = 0
        while index < len(group):
            token = group[index]
            if token in (">", ">>", "<"):
                if index + 1 == len(group) or group[index + 1] in (">", ">>", "<"):
                    return [], False
                target = group[index + 1]
                if not (token in (">", ">>") and target == "/dev/null"):
                    paths.append(target)
                index += 2
            elif any(c in token for c in "<>"):
                return [], False
            else:
                arguments.append(token)
                index += 1
        if not arguments:
            return [], False
        group = arguments
        name = Path(group[0]).name
        if name in ("echo", "printf", "pwd", "date", "true", "false"):
            if any(t in group for t in (">", ">>")):
                return [], False
            continue
        if name in ("cat", "head", "tail", "stat", "ls", "find", "wc"):
            paths += [t for t in group[1:] if not t.startswith("-") and not t.isdigit() and t not in (">", ">>")]
        elif name in ("python", "python3") and "-m" in group and "unittest" in group:
            # The protocol permits project test execution. This says nothing
            # about unobserved file reads inside that project's Python code.
            paths += [t for t in group[1:] if t.startswith(("/", "../", "~/"))]
        else:
            return [], False
    return paths, True


def audit(calls: list[dict], results: dict[str, list[dict]], scope: Scope) -> dict:
    rows = []
    for call in calls:
        name, data = call["name"], call["input"]
        paths, understood = [], True
        if name in ("Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit"):
            for key in ("file_path", "path", "notebook_path"):
                if isinstance(data.get(key), str):
                    paths.append(data[key])
            if name == "Glob" and isinstance(data.get("pattern"), str) and data["pattern"].startswith(("/", "../", "~/")):
                paths.append(data["pattern"].split("*", 1)[0])
        elif name == "Bash":
            paths, understood = bash_targets(data.get("command", ""))
        elif name in ("ToolSearch", "mcp__context-harness__read_coordinate", "mcp__context-harness__policy_report"):
            pass
        elif name == "Skill" and str(data.get("skill", "")).startswith("context-harness:"):
            pass
        else:
            understood = False
        outcome = results.get(call["id"], [])
        outside = [str(scope.resolve(p)) for p in paths if not scope.allowed(scope.resolve(p))]
        succeeded = bool(outcome) and all(not r.get("is_error", False) for r in outcome)
        state = "contaminated" if outside and succeeded else "unresolved" if outside or not understood or not outcome else "allowed"
        rows.append({"call_id": call["id"], "tool": name, "classification": state, "outside_targets": outside,
                     "outcome_observed": bool(outcome), "understood": understood})
    state = "contaminated" if any(r["classification"] == "contaminated" for r in rows) else "unresolved" if any(r["classification"] == "unresolved" for r in rows) else "clean"
    return {"classification": state, "calls": len(rows), "rows": rows,
            "claim_scope": "Explicit captured tool targets; not OS syscalls or arbitrary code's internal file reads"}
