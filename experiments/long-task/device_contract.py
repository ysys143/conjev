"""Concrete Q2 case recipes and evaluator-owned deterministic hook execution.

The candidate contract is executable CPU preparation, not phase-1 acceptance.
Live bindings, a frozen identity and three repetitions remain mandatory.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path

from grading import file_digest, load, write_new

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
HOME = "/home/me"
ROOT = f"{HOME}/.local/state/context-harness"
ARCHIVE = f"{ROOT}/archive/sess-1"
BIG = "DEVICE-LINE\n" * 501
START = {"cwd": "/proj", "surface": "terminal", "isInteractive": True}
END = {"answer": "Diagnostic complete.", "durationMs": 1, "isAborted": False, "turnId": "t1", "reason": "answer"}
STOP = {"session_id": "sess-1", "prompt_id": "turn-control", "stop_hook_active": False,
        "last_assistant_message": "Next, I will inspect the parser."}
KEY = {"TYPESAFE_API_KEY": "synthetic-test-key"}


def prompt(text):
    return {"role": "user", "text": text, "toolUses": []}


def conversation_without_tools():
    return [prompt("Preserve this diagnostic conversation without tool results."),
            {"role": "assistant", "text": "The diagnostic has no tool results to fold.", "toolUses": []},
            prompt("Compact this conversation now.")]


def result(identifier="old", tool="Read", text=BIG, error=False):
    return [{"role": "assistant", "text": "", "toolUses": [{"tool_use_id": identifier, "tool": tool,
             "input": {"file_path": f"/proj/{identifier}.txt"} if tool != "Bash" else {"command": f"cat /proj/{identifier}.txt"}}]},
            {"role": "user", "text": "", "toolUses": [], "toolResults": [{"tool_use_id": identifier, "text": text, "isError": error}]}]


def transcript(*, recent=False, tool="Read", text=BIG, error=False):
    return [prompt("Preserve this diagnostic result"), *result(tool=tool, text=text, error=error),
            *([] if recent else [prompt("next"), prompt("next again")])]


def action(event, **input):
    return {"event": event, "input": input}


def compact(messages=None):
    return action("session.compact", trigger="manual", messages=messages if messages is not None else transcript())


def submit(text="Inspect the deployment diagnostic.", **fields):
    return action("prompt.submit", text=text, wait=False, origin={"kind": "sdk"}, turnId="turn-control", **fields)


def rule(source, **kwargs):
    return {"source": source, **kwargs}


def records(count=0, **where):
    return rule("records", **({"where": where} if where else {}), count=count)


def no_jev():
    return rule("fetches", count=0)


def build_cases():
    cases = {}

    def add(identifier, *, steps, assertions, options=None, setup=None, response=None, zero=None, compliance=None):
        cases[identifier] = {"id": identifier, "options": {"foldAtPercent": 0, **(options or {})},
                             "setup": {"mtimes": {}, **(setup or {})}, "steps": steps,
                             "response": response or {}, "assertions": assertions,
                             "deterministic_runner": "device_contract.fixture.ts",
                             "live_status": "binding_pending", "minimum_deterministic": 1, "minimum_live": 3,
                             "legitimate_zero_records": zero or [
                                 {"condition": f"Case {identifier} executes the stated recipe; no record may match this selector.", "selector": r.get("where", {})}
                                 for r in assertions if r["source"] == "records" and r.get("count") == 0], "compliance": compliance}

    ordinary = [
        ("eligible-old-large", transcript(), True),
        ("recent-kept", transcript(recent=True), False),
        ("short-error-kept", transcript(text="controlled error " * 80, error=True), False),
        ("keep-tools-kept", transcript(tool="TodoWrite"), False),
        ("below-size-kept", transcript(text="short result"), False),
    ]
    for name, messages, folds in ordinary:
        add("fold-ordinary." + name, steps=[compact(messages)], assertions=[
            rule("archives", count=int(folds)), rule("outputs", contains="[folded Read" if folds else "summary"),
            records(), no_jev()], zero=["All judgment modes are off; folding itself writes archives, not judgment records."])
    add("fold-other-paths.nothing-eligible-summary", steps=[compact(conversation_without_tools())],
        assertions=[rule("outputs", contains="summary"), rule("archives", count=0), records(), no_jev()])
    add("fold-other-paths.archive-write-failure-summary", setup={"failWrite": "/archive/"}, steps=[compact()],
        assertions=[rule("outputs", contains="summary"), rule("archives", count=0), records(), no_jev()])
    add("fold-other-paths.folded-still-large-summary", setup={"window": 10}, steps=[compact()],
        assertions=[rule("outputs", contains="summary"), rule("archives", count=1), records(), no_jev()])
    # Input for pass 2 is a manually specified pointer, not product-computed output.
    again = [prompt("Continue"), *result(identifier="prior", text='[folded Read · /proj/prior.txt · 501 lines — read_coordinate("prior")]'),
             *result(identifier="new"), prompt("next"), prompt("next again")]
    add("fold-other-paths.second-fold-only-new", steps=[compact(again)], assertions=[
        rule("archives", count=1), rule("archives", where={"id": "new"}, count=1),
        rule("outputs", contains='read_coordinate(\\"prior\\")'), records(), no_jev()])
    add("fold-other-paths.skipped-compaction-no-records", options={"foldJev": "shadow"},
        setup={"env": KEY, "compactBelow": "skip"}, steps=[compact(transcript(recent=True))], assertions=[
            rule("outputs", contains="skipped below"), records(), rule("appended", count=0), no_jev()],
        zero=["The lower compaction hook vetoes a no-fold compaction, so no fold records or note are due."])

    archived = {"id": "toolu_known", "tool": "Read", "input": {"file_path": "/proj/original.txt"}, "text": BIG, "isError": False}
    read_files = {f"{ARCHIVE}/toolu_known.json": json.dumps(archived),
                  f"{ROOT}/archive/foreign/toolu_foreign.json": json.dumps({**archived, "text": "FOREIGN-CONTROL"})}
    for name, identifier, offset, limit, expected in [
        ("exact-original", "toolu_known", 1, 600, 'Read {"file_path":"/proj/original.txt"} — lines 1-502 of 502\n' + BIG),
        ("offset-and-limit-beyond-400", "toolu_known", 401, 102, 'Read {"file_path":"/proj/original.txt"} — lines 401-502 of 502\n' + "DEVICE-LINE\n" * 101),
        ("unknown-id", "missing", 1, 400, None), ("malformed-id", "../../escape", 1, 400, None),
        ("other-session-id", "toolu_foreign", 1, 400, None),
    ]:
        checks = [records(), no_jev(), rule("outputs", excludes="FOREIGN-CONTROL")]
        checks += [rule("outputs", where={"result": expected}, count=1)] if expected is not None else [rule("outputs", where={"deny": f'No folded result is kept under "{identifier}".'}, count=1)]
        add("read-coordinate." + name, setup={"files": read_files}, steps=[action("tool.call", tool="mcp__context-harness__read_coordinate", id=identifier, offset=offset, limit=limit)], assertions=checks)
    add("archive-storage.private-directories-before-first-write", steps=[compact()], assertions=[
        rule("runs", contains='["chmod","700","/home/me/.local/state/context-harness","/home/me/.local/state/context-harness/archive","/home/me/.local/state/context-harness/archive/sess-1"]'),
        rule("disk", equals=["run mkdir", "run chmod", f"write {ARCHIVE}/old.json"]), rule("archives", count=1), records(), no_jev()])
    add("archive-storage.chmod-failure-writes-nothing", setup={"failRun": "chmod"}, steps=[compact()], assertions=[rule("outputs", contains="summary"), rule("disk", equals=["run mkdir", "run chmod"]), rule("archives", count=0), records(), no_jev()])
    for name, percent, savings, want in [("thresholds-met", 90, 20, ["compact"]), ("below-context-threshold", 79, 20, []), ("below-savings-threshold", 90, 99, [])]:
        add("automatic-compact." + name, options={"foldAtPercent": 80, "minSavedPercent": savings},
            setup={"percent": percent, "messages": transcript()}, steps=[{"event": "turn.complete", "input": END}],
            assertions=[rule("commands", equals=want), rule("appended", count=0), records(), no_jev()])

    for name, path in [("stale-phase", "/proj/PHASE.md"), ("stale-episodes", "/proj/sessions/control.md")]:
        key = "phaseFile" if name == "stale-phase" else "episodeDir"
        add("consolidation." + name, options={"foldAtPercent": 80, key: "/proj/PHASE.md" if key == "phaseFile" else "/proj/sessions"},
            setup={"messages": transcript(), "percent": 90, "startedAt": 2, "files": {path: "stale"}, "mtimes": {path: 1}}, steps=[{"event": "turn.complete", "input": END}],
            assertions=[rule("appended", count=1, contains="consolidate"), rule("appended", contains="PHASE.md" if key == "phaseFile" else "sessions"), rule("commands", count=0), records(), no_jev()])
    add("consolidation.at-most-two-deferrals", options={"foldAtPercent": 80, "phaseFile": "/proj/PHASE.md"},
        setup={"messages": transcript(), "percent": 90, "files": {"/proj/PHASE.md": "stale"}, "mtimes": {"/proj/PHASE.md": -1}},
        steps=[{"event": "turn.complete", "input": {**END, "turnId": f"t{i}"}} for i in range(3)] + [compact()],
        assertions=[rule("commands", equals=["compact"]), rule("appended", count=3, contains="Not written"), records(), no_jev()])
    add("consolidation.current-files-no-request", options={"foldAtPercent": 80, "phaseFile": "/proj/PHASE.md", "episodeDir": "/proj/sessions"},
        setup={"messages": transcript(), "percent": 90, "files": {"/proj/PHASE.md": "current", "/proj/sessions/log.md": "current"}, "mtimes": {"/proj/PHASE.md": 10, "/proj/sessions/log.md": 10}},
        steps=[{"event": "turn.complete", "input": END}], assertions=[rule("commands", equals=["compact"]), rule("appended", count=0), records(), no_jev()])
    add("consolidation.forced-compact-no-request", options={"phaseFile": "/proj/PHASE.md"}, setup={"files": {"/proj/PHASE.md": "stale"}, "mtimes": {"/proj/PHASE.md": -1}},
        steps=[compact()], assertions=[rule("appended", count=1, excludes="Before compacting"), rule("archives", count=1), records(), no_jev()])
    for name, messages, files, marker, count in [
        ("folded-results-note", transcript(), {}, "1 tool results were folded", 1),
        ("project-files-note", conversation_without_tools(), {"/proj/INTENT.md": "goal", "/proj/PHASE.md": "status"}, "INTENT.md", 1),
        ("neither-no-note", conversation_without_tools(), {}, None, 0),
    ]:
        add("post-compact-note." + name, options={"intentFile": "/proj/INTENT.md", "phaseFile": "/proj/PHASE.md"}, setup={"files": files}, steps=[compact(messages)],
            assertions=[rule("appended", count=count, **({"contains": marker} if marker else {})), records(), no_jev()])
    for name, exists in [("canonical-order-after-compact", True), ("no-note-no-reread-obligation", False)]:
        checks = [rule("appended", count=int(exists)), records(), no_jev()]
        if exists:
            checks += [rule("appended", ordered=["INTENT.md", "PHASE.md"])]
        add("project-reread." + name, options={"intentFile": "/proj/INTENT.md", "phaseFile": "/proj/PHASE.md"},
            setup={"files": {"/proj/INTENT.md": "goal", "/proj/PHASE.md": "status"} if exists else {}}, steps=[compact(conversation_without_tools())],
            assertions=checks, compliance="Live: record ordered Read calls before any new-work call; score note delivery separately from whether the model complies.")

    for name, text, facts, skip, http, key in [
        ("announce-retry-once", STOP["last_assistant_message"], {}, None, None, True),
        ("completed-report-allowed", "The diagnostic is complete.", {}, None, None, True),
        ("question-allowed", "Which parser should I inspect?", {}, "question", None, True),
        ("conditional-ending-allowed", "If you approve, I will inspect the parser.", {}, "conditional", None, True),
        ("plan-mode-skip", STOP["last_assistant_message"], {"permission_mode": "plan"}, "plan-mode", None, True),
        ("background-task-skip", STOP["last_assistant_message"], {"background_tasks": [{"id": "synthetic", "type": "bash", "status": "running", "description": "fixture"}]}, "background-tasks", None, True),
        ("scheduled-task-skip", STOP["last_assistant_message"], {"session_crons": [{"id": "synthetic", "cron": "* * * * *", "prompt": "fixture"}]}, "scheduled-tasks", None, True),
        ("reentry-skip", STOP["last_assistant_message"], {"stop_hook_active": True}, "stop-hook-active", None, True),
        ("missing-key-fail-open", STOP["last_assistant_message"], {}, None, None, False),
        ("timeout-fail-open", STOP["last_assistant_message"], {}, None, "timeout", True),
        ("cap-fail-open", STOP["last_assistant_message"], {}, None, None, True),
        ("circuit-fail-open", STOP["last_assistant_message"], {}, None, "error", True),
        ("underlying-stop-precedence", STOP["last_assistant_message"], {}, None, None, True),
        ("approval-or-input-wait", "Work is blocked until you provide the required source file.", {}, None, None, True),
        ("explicit-user-stop", "Stopped as you requested. No work remains running.", {}, None, None, True),
    ]:
        options = {"stopGate": "active"}
        if http == "timeout": options["timeoutMs"] = 200
        setup = {"env": KEY if key else {}, "isTimerStopped": http != "timeout"}
        if name == "plan-mode-skip": setup["nativePermissionMode"] = "plan"
        if name == "cap-fail-open": options["stopCap"] = 0
        if name == "underlying-stop-precedence": setup["stopBelow"] = {"block": "underlying diagnostic block"}
        steps = [action("classic.Stop", **{**STOP, "last_assistant_message": text, **facts})]
        nrecords = 0 if name == "underlying-stop-precedence" else 4 if name == "circuit-fail-open" else 1
        calls = 0 if skip or not key or name in ["cap-fail-open", "underlying-stop-precedence"] else 3 if name == "circuit-fail-open" else 1
        checks = [records(nrecords), rule("fetches", count=calls)]
        if name == "announce-retry-once":
            steps += [action("classic.Stop", **{**STOP, "stop_hook_active": True})]
            checks = [records(2), records(1, decision="continue"), records(1, skipped="stop-hook-active"), rule("fetches", count=1), rule("outputs", count=2), rule("outputs", where={"block": "Your last paragraph announces work you have not done yet. If you can do it now, do it. If you are waiting for the person, say plainly what you need from them."}, count=1)]
        elif name == "circuit-fail-open":
            steps *= 4
            checks += [records(1, error="circuit"), rule("outputs", equals=[{}] * 4)]
        elif name == "underlying-stop-precedence": checks += [rule("outputs", equals=[{"block": "underlying diagnostic block"}])]
        else:
            checks += [rule("outputs", equals=[{}])]
            if skip: checks += [records(1, skipped=skip, sent=None)]
            elif not key: checks += [records(1, error="no-key", sent=None)]
            elif name == "timeout-fail-open": checks += [records(1, error="timeout")]
            elif name == "cap-fail-open": checks += [records(1, error="cap")]
            else: checks += [records(1, decision="stop")]
        add("stop-active." + name, options=options, setup=setup, steps=steps, assertions=checks,
            response={"announce": 0.99 if name == "announce-retry-once" else 0.01, "http": http},
            zero=["A lower Stop block suppresses all product Stop records and Jev calls."] if name == "underlying-stop-precedence" else [])
    for name, below, skip in [("eligible-record-and-delayed-judgment", False, False), ("skip-reason-record", False, True), ("underlying-block-no-jev", True, False)]:
        add("stop-shadow." + name, options={"stopGate": "shadow"}, setup={"env": KEY, "isTimerStopped": True, **({"stopBelow": {"block": "underlying diagnostic block"}} if below else {})},
            steps=[action("classic.Stop", **{**STOP, **({"stop_hook_active": True} if skip else {})})], response={"announce": 0.99},
            assertions=[records(0 if below else 1), rule("fetches", count=0 if below or skip else 1),
                        *([records(1, decision="would-continue")] if not below and not skip else [records(1, skipped="stop-hook-active")] if skip else []),
                        rule("outputs", equals=[{"block": "underlying diagnostic block"}] if below else [{}])])

    fragment = "---\nwhen: The request asks to publish a release.\nkeywords: deploy\n---\nCheck the rollback plan first.\n"
    fragment_files = {"/proj/fragments/control.md": fragment}
    for name in ["keyword-attach-once", "semantic-no-keyword-attach-once", "pinned-in-system", "nonmatch-no-attach", "reattach-after-summary", "no-reattach-after-fold-only"]:
        setup = {"files": fragment_files, "env": KEY, "isTimerStopped": True}
        steps = [submit("deploy now" if name == "keyword-attach-once" else "Publish a release")]
        expected_calls = 0 if name == "keyword-attach-once" else 1
        count = 1
        checks = []
        if name == "pinned-in-system":
            setup["files"] = {"/proj/fragments/pin.md": "---\npin: true\n---\nPINNED-CONTROL-MARKER\n"}
            steps = [action("prompt.compose", model="fixture", promptModel="fixture", surfaces=[], tools=[], outputStyle={"name": "default", "isKeepingCodingInstructions": True}, traits=[])]
            checks = [rule("outputs", contains="PINNED-CONTROL-MARKER"), records(), no_jev()]
        else:
            if name == "nonmatch-no-attach": count = 0
            elif name in ["keyword-attach-once", "semantic-no-keyword-attach-once"]: steps += [submit("Publish another release")]
            elif name in ["reattach-after-summary", "no-reattach-after-fold-only"]:
                steps += [compact(conversation_without_tools()) if name == "reattach-after-summary" else compact(), submit("Publish another release")]
                if name == "reattach-after-summary": expected_calls, count = 2, 2
            checks = [records(count if name != "nonmatch-no-attach" else 1), rule("fetches", count=expected_calls),
                      rule("submitted", where={"context": ['<instruction name="control" source="context-harness">\nCheck the rollback plan first.\n</instruction>']}, count=count)]
        add("conditional-instructions." + name, options={"instructions": "active", "fragmentsDir": "/proj/fragments"}, setup=setup,
            steps=steps, response={"applies": 0.01 if name == "nonmatch-no-attach" else 0.99}, assertions=checks)

    for name, tool, fields, external, deny, hit in [
        ("external-secret-file-denied", "Read", {"file_path": "/proj/.env"}, True, True, True),
        ("external-secret-print-denied", "Bash", {"command": "printenv"}, True, True, True),
        ("external-direct-archive-denied", "Read", {"file_path": f"{ARCHIVE}/control.json"}, True, True, True),
        ("ordinary-file-allowed", "Read", {"file_path": "/proj/ordinary.txt"}, True, False, False),
        ("first-party-protected-write-denied", "Write", {"file_path": f"{ROOT}/archive/sess-1/control.json", "content": "{}"}, False, True, True),
        ("first-party-read-allowed", "Read", {"file_path": "/proj/.env"}, False, False, True),
    ]:
        add("tool-floor." + name, options={"toolGate": "active", **({"providerTrust": "external"} if external else {})}, steps=[action("tool.call", tool=tool, tool_use_id="tool-control", **fields)],
            assertions=[records(int(hit)), *([records(1, decision="deny" if deny else "allow", sent=None)] if hit else []), no_jev(), rule("outputs", **({"contains": "deny"} if deny else {"equals": [{"result": "ok"}]}))])
    for name in ["external-restricted-denied", "external-open-allowed", "first-party-no-call", "cached-target-no-repeat-call"]:
        external = name != "first-party-no-call"
        deny = name == "external-restricted-denied"
        steps = [action("tool.call", tool="Read", file_path="/proj/customer-export.txt", tool_use_id="tool-control")]
        if name == "cached-target-no-repeat-call": steps *= 2
        add("tool-jev." + name, options={"toolJev": "active", **({"providerTrust": "external"} if external else {})}, setup={"env": KEY, "isTimerStopped": True}, steps=steps,
            response={"restricted": deny}, assertions=[records(int(external)), rule("fetches", count=int(external)), rule("outputs", **({"contains": "deny"} if deny else {"equals": [{"result": "ok"}] * len(steps)}))])

    busy = [prompt("Use the results for the diagnostic")]
    for i in range(60): busy += result(identifier=f"t{i}", text="x" * (500 + 37 * i))
    busy += result(identifier="kept-error", text="e" * 1500, error=True) + [prompt("next"), prompt("Finish the diagnostic")]
    # Independent enumeration: t13..t59 plus the 1500-character error = 48.
    sample = [f"t{i}" for i in range(13, 60)] + ["kept-error"]
    for name in ["sizes-and-more-than-48-independent-sample", "outside-sample-no-record", "missing-key-no-call", "no-person-prompt-no-call", "failed-call-error-no-probability"]:
        no_call = name in ["missing-key-no-call", "no-person-prompt-no-call"]
        messages = busy if name != "no-person-prompt-no-call" else result(identifier="promptless-a") + result(identifier="promptless-b")
        checks = [records(0 if no_call else 48), rule("fetches", count=0 if no_call else 2)]
        if not no_call:
            checks += [records(1, joinKey=i) for i in sample]
            checks += [records(0, joinKey=f"t{i}") for i in range(13)]
            checks += [records(1, joinKey="kept-error", heuristic=False), records(1, joinKey="t59", heuristic=True)]
            if name == "failed-call-error-no-probability": checks += [rule("records", all={"error": "http 503"}, excludes='"jev":')]
            else: checks += [rule("records", all={"jev": 0.7, "mode": "shadow"})]
        add("fold-shadow." + name, options={"foldJev": "shadow", "keepRecentTurns": 1, "minFoldChars": 500},
            setup={"env": {} if name == "missing-key-no-call" else KEY, "isTimerStopped": True}, steps=[compact(messages)], assertions=checks,
            response={"http": "error" if name == "failed-call-error-no-probability" else None}, zero=["No key or no human prompt prevents all fold judgments."] if no_call else [])

    unique = "## Control policy\n\nKeep the unique instruction DEVICE-UNIQUE intact at every request.\n"
    web = "## Web page fetch\n\nWhen asked to fetch a web page, use the declared fetching route for the diagnostic.\n"
    llm = "## LLM routing\n\nUse the subscription runtime to execute the language model request in this diagnostic.\n"
    keep = "## Language\n\nKeep the response language fixed to Korean throughout this diagnostic.\n"
    doc = lambda path, kind, text: {"path": path, "kind": kind, "content": text}
    for name in ["duplicate-once", "unique-preserved", "organization-preserved", "memory-preserved"]:
        kind = "managed" if name == "organization-preserved" else "memory" if name == "memory-preserved" else "project"
        files = [doc(f"{HOME}/CLAUDE.md", "user", unique), doc("/proj/CLAUDE.md", kind, unique)] if name != "unique-preserved" else [doc("/proj/CLAUDE.md", "project", unique)]
        drops = int(name == "duplicate-once")
        checks = [no_jev(), records(1 if name in ["unique-preserved", "memory-preserved"] else 2), records(drops, decision="drop")]
        if drops: checks += [rule("loaded", contains="left out"), rule("loaded", where={}, count=1)]
        else: checks += [rule("loaded", equals=[files])]
        add("instruction-filter-deterministic." + name, options={"instructionFilter": "active"}, steps=[action("prompt.context", blocks=[], instructionFiles=files)], assertions=checks,
            zero=["Memory files are excluded from chunk records; managed chunks are recorded but preserved."] if kind == "memory" else [])
    filter_files = [doc(f"{HOME}/CLAUDE.md", "user", keep + unique + web + llm)]
    for name in ["scope-and-cover-readings", "always-kept-preserved", "shadow-keeps-system-prompt"]:
        add("instruction-filter-jev." + name, options={"instructionFilter": "shadow"}, setup={"env": KEY, "isTimerStopped": True},
            response={"scope": 0.01, "cover": 0.99}, steps=[action("prompt.context", blocks=[], instructionFiles=filter_files)], assertions=[
                rule("loaded", equals=[filter_files]), rule("fetches", count=2), records(6), records(2, decision="sent"),
                records(1, **{"facts.heading": "## Language", "decision": "would-keep", "facts.reason": "always kept"}),
                records(1, **{"facts.heading": "## LLM routing", "decision": "would-drop", "facts.conditional": "0.01", "facts.covered": "0.99"})])
    for name in ["each-request", "slash-command-origin", "browser-tool-kind", "web-fetch-tool-kind", "orca-tool-kind", "claude-print-tool-kind", "none-deferred-no-record", "empty-request-no-record", "missing-key-no-record", "unlisted-tool-no-record"]:
        files = [doc(f"{HOME}/CLAUDE.md", "user", web)]
        steps = [action("prompt.context", blocks=[], instructionFiles=files)]
        setup = {"env": KEY, "isTimerStopped": True, "livePromptEvidence": True}
        resp = {"scope": 0.99}
        count = 0
        checks = []
        if name in ["each-request", "slash-command-origin", "none-deferred-no-record", "empty-request-no-record", "missing-key-no-record"]:
            if name == "none-deferred-no-record": resp["scope"] = 0.01
            if name == "missing-key-no-record":
                setup["env"] = {}
                steps = [action("prompt.context", blocks=[], instructionFiles=[doc(f"{HOME}/CLAUDE.md", "user", "## Orca work\n\nUse the project worktree when operating inside an Orca session.\n")])]
            steps += [submit("" if name == "empty-request-no-record" else "/device fetch" if name == "slash-command-origin" else "Fetch the example page", **({"command": {"name": "device", "args": "fetch"}} if name == "slash-command-origin" else {}))]
            if name == "each-request": steps += [submit("Fetch another example page")]
            count = 2 if name == "each-request" else 1 if name == "slash-command-origin" else 0
            checks += [records(count, point="instr-defer")]
            if count: checks += [records(count, point="instr-defer", decision="would-attach", **{"facts.origin": "sdk", "joinKey": "turn-control"})]
        else:
            tool, fields, signature = {"browser-tool-kind": ("Bash", {"command": "ego-browser snapshot"}, "browser"),
                                      "web-fetch-tool-kind": ("WebFetch", {"url": "https://example.invalid", "prompt": "test"}, "web"),
                                      "orca-tool-kind": ("Bash", {"command": "orca status"}, "orca"),
                                      "claude-print-tool-kind": ("Bash", {"command": "claude -p fixture"}, "llm"),
                                      "unlisted-tool-no-record": ("Read", {"file_path": "/proj/a.txt"}, None)}[name]
            steps += [action("tool.call", tool=tool, tool_use_id="tool-control", **fields)]
            checks += [records(0 if signature is None else 1, point="instr-tool")]
            if signature is not None: checks += [records(1, point="instr-tool", sent=None, **{"facts.signature": signature})]
            checks += [records(0, point="instr-defer")]
        total = 1 if name == "missing-key-no-record" else 4 if name == "each-request" else 3 if name in ["slash-command-origin", "browser-tool-kind", "web-fetch-tool-kind", "orca-tool-kind", "claude-print-tool-kind"] else 2
        checks += [records(total)]
        add("instruction-filter-deferred." + name, options={"instructionFilter": "shadow"}, setup=setup, response=resp, steps=steps, assertions=checks,
            zero=["No deferred chunk, blank prompt, missing key, or unlisted tool kind has no corresponding deferred-use/tool-use record."])

    for name in ["empty-before-event", "missing-key-immediate", "visible-after-record"]:
        options = {"stopGate": "shadow"} if name != "visible-after-record" else {"toolGate": "active", "providerTrust": "external"}
        steps = [{"event": "session.start", "input": START}]
        if name == "visible-after-record": steps += [action("tool.call", tool="Read", file_path="/proj/.env")]
        checks = [no_jev()]
        checks += [rule("statuses", equals=[]), records()] if name == "empty-before-event" else [rule("statuses", contains="jev: no key"), records()] if name == "missing-key-immediate" else [rule("statuses", contains="jev · tool active 1 hits"), records(1)]
        add("status-line." + name, options=options, setup={"env": KEY if name == "empty-before-event" else {}}, steps=steps, assertions=checks,
            compliance="Live: terminal screen capture required; ui.status or stream output alone is insufficient.")

    index = load(HERE / "device-case-index.json")
    ids = [c["id"] for s in index["surfaces"] for c in s["cases"]]
    skills = [i for i in ids if i.startswith("skills.")]
    for identifier in skills:
        cases[identifier] = {"id": identifier, "deterministic_runner": "skill-inventory", "live_status": "binding_pending", "minimum_deterministic": 1, "minimum_live": 3,
                             "stimulus": "Load the declared plugin set in a fresh CLI process; request the named skill using Skill. Vanilla loads no product plugin.",
                             "expected_action": "Inventory and invoked skill text must match source; vanilla must expose neither project-state nor consolidate.",
                             "compliance": "Live skill invocation is a model-compliance observation and is distinct from availability and delivered skill content."}
    if set(cases) != set(ids):
        raise ValueError({"missing": sorted(set(ids) - set(cases)), "extra": sorted(set(cases) - set(ids))})
    # JSON round-trip breaks intentionally reused recipe objects before mutable execution.
    return json.loads(json.dumps([cases[i] for i in ids]))


MUTATIONS = {
    "pointer-removed": ("fold-ordinary.eligible-old-large", "hooks/register.ts", "return compacted", "return { messages: e.messages }"),
    "continuation-dropped": ("stop-active.announce-retry-once", "hooks/register.ts", "? { ...below, block: STOP_MESSAGE } : below", "? below : below"),
    "unique-instruction-dropped": ("instruction-filter-deterministic.unique-preserved", "hooks/register.ts",
        "return passed === undefined ? next(e) : next({ ...e, instructionFiles: passed as unknown as typeof files })",
        "return next({ ...e, instructionFiles: files.map(file => ({ ...file, content: file.content.replace('DEVICE-UNIQUE', '') })) })"),
    "record-deleted": ("stop-active.question-allowed", "hooks/storage.ts", "await $.fs.write(`${dir}/${record.id}.json`, JSON.stringify(record))", "void record"),
}


def prepare(root: Path, mutation: str | None = None):
    root.mkdir(parents=True, exist_ok=False, mode=0o700)
    core = root / "product"
    (core / ".claude-plugin").mkdir(parents=True)
    shutil.copyfile(REPO / ".claude-plugin/plugin.json", core / ".claude-plugin/plugin.json")
    shutil.copytree(REPO / "hooks", core / "hooks")
    shutil.copytree(REPO / "skills", core / "skills")
    tests = core / "tests"
    tests.mkdir()
    shutil.copyfile(REPO / "tests/kit.ts", tests / "kit.ts")
    shutil.copyfile(HERE / "device_contract.fixture.ts", tests / "device-contract.test.ts")
    cases = build_cases()
    selected = [c for c in cases if c["deterministic_runner"] != "skill-inventory" and (mutation is None or c["id"] == MUTATIONS[mutation][0])]
    (tests / "device-cases.ts").write_text("export const cases = " + json.dumps(selected, ensure_ascii=False) + "\n")
    if mutation is not None:
        _, source, before, after = MUTATIONS[mutation]
        target = core / source
        text = target.read_text()
        if text.count(before) != 1: raise ValueError("Mutation target is ambiguous or stale")
        target.write_text(text.replace(before, after))
    (core / "tsconfig.json").write_text(json.dumps({"extends": str(REPO / ".claude-plugin/types/tsconfig.json"),
        "compilerOptions": {"typeRoots": [str(REPO / ".claude-plugin/types")]}, "include": ["hooks", "tests"]}, indent=2) + "\n")
    identity = {str(p.relative_to(REPO)): file_digest(p) for p in [*(REPO / "hooks").glob("*.ts"), *(REPO / "skills").rglob("SKILL.md"), REPO / ".claude-plugin/plugin.json", REPO / "tests/kit.ts", HERE / "device_contract.fixture.ts", Path(__file__), HERE / "device-case-index.json"]}
    write_new(root / "contract.json", {"status": "candidate", "phase_1_complete": False, "surface_count": 19, "case_count": len(cases), "cases": cases, "source_sha256": identity,
        "mutation": mutation, "executed_case_ids": [c["id"] for c in selected]})
    return core


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--claude", type=Path, default=Path.home() / ".local/share/claude/versions/2.1.309")
    p.add_argument("--mutation", choices=sorted(MUTATIONS))
    args = p.parse_args()
    core = prepare(args.root, args.mutation)
    types = subprocess.run(["tsc", "--noEmit", "-p", str(core)], text=True, capture_output=True)
    (args.root / "types.log").write_text(types.stdout + types.stderr)
    result = subprocess.run([str(args.claude), "plugin", "test", str(core)], text=True, capture_output=True)
    (args.root / "plugin-tests.log").write_text(result.stdout + result.stderr)
    inventory = []
    for c in build_cases():
        if c["deterministic_runner"] != "skill-inventory": continue
        if "vanilla" in c["id"]:
            inventory.append({"case": c["id"], "available_source_verified": None, "live_invocation": "NOT RUN",
                              "reason": "A CPU file check cannot establish the CLI's vanilla skill inventory."})
            continue
        else:
            name = "project-state" if "project-state" in c["id"] else "consolidate"
            content = (REPO / f"skills/{name}/SKILL.md").read_text()
            good = f"name: {name}" in content and len(content) > 100
        inventory.append({"case": c["id"], "available_source_verified": good, "live_invocation": "NOT RUN"})
    actual = re.findall(r"^\(pass\) device ([^ ]+)", result.stdout + result.stderr, re.MULTILINE)
    failed = re.findall(r"^\(fail\) device ([^ ]+)", result.stdout + result.stderr, re.MULTILINE)
    expected = load(args.root / "contract.json")["executed_case_ids"]
    identity = load(args.root / "contract.json")["source_sha256"]
    changed = [p for p, digest in identity.items() if file_digest(REPO / p) != digest]
    mutation_rejected = bool(args.mutation and result.returncode == 1 and failed == expected and not actual and "AssertionError" not in result.stderr and '"failed":' in result.stdout + result.stderr)
    hook_success = result.returncode == 0 and set(actual) == set(expected) and len(actual) == len(expected) and not changed
    receipt = {"plugin_exit_code": result.returncode, "types_exit_code": types.returncode,
               "hook_cases_expected": len(expected), "hook_cases_passed": len(actual), "all_hook_cases_verified": hook_success,
               "source_changed": changed,
               "mutation": args.mutation, "mutation_rejected": mutation_rejected,
               "inventory": inventory, "candidate_only": True, "phase_1_complete": False}
    write_new(args.root / "preparation.json", receipt)
    print(json.dumps(receipt, indent=2))
    return 0 if (mutation_rejected if args.mutation else hook_success) and types.returncode == 0 and not changed else 2


if __name__ == "__main__":
    raise SystemExit(main())
