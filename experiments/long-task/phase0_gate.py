"""Assemble phase-0 acceptance from closed, source-bound execution receipts."""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
from collections import Counter
from contextlib import closing
from pathlib import Path

from acceptance import audit as lifecycle_audit
from driver import DEFAULT_EFFORT, DEFAULT_MODEL
from grading import file_digest, load, write_new
from inventory_audit import intact
from spend import SpendLedger
from usage_map import account, source_map

ROLES = {"transport", "environment", "lifecycle", "contamination", "stop_off", "stop_active"}
BUILTINS = {"cc-plugin-agents-md", "cc-plugin-telemetry", "cc-plugin-plugin-authoring"}
CONTAMINATION_CHECKS = {"own_task_and_session_allowed", "valid_own_coordinate_retrieved", "all_three_foreign_canaries_detected",
    "foreign_values_actually_read", "both_runs_closed", "both_runs_have_complete_captures", "no_cli_reader_or_proxy_left",
    "fresh_session_identity", "old_coordinate_absent_in_fresh_run", "previous_archive_unchanged", "source_unchanged"}


def stop_cases_complete(off: dict, active: dict, records: list[dict]) -> bool:
    expected = {(name, repetition) for name in ("announce", "report", "question") for repetition in (1, 2, 3)}
    for probe in (off, active):
        rows = probe.get("cases", [])
        if len(rows) != 9 or {(r.get("case"), r.get("repetition")) for r in rows} != expected:
            return False
        if not all(r.get("stimulus_matched") and r.get("expected_branch") for r in rows):
            return False
    stop = [r for r in records if r.get("point") == "stop"]
    paid = [r for r in stop if "jev" in r]
    skipped = Counter(r.get("skipped") for r in stop if r.get("skipped"))
    return (off.get("census", {}).get("candidates") == 9 and off.get("census", {}).get("blocked") == 0
            and off.get("stop_records") == 0 and active.get("census", {}).get("candidates") == 12
            and active.get("census", {}).get("blocked") == 3 and len(stop) == 12
            and len(paid) == 6 and not any(r.get("error") for r in stop)
            and sum(r["jev"] >= 0.7 for r in paid) == 3 and sum(r["jev"] < 0.7 for r in paid) == 3
            and skipped == {"question": 3, "stop-hook-active": 3} and active.get("observer_before_jev") is True)


def records_at(run: Path) -> list[dict]:
    state = run / "evidence/plugin-state"
    return [load(p) for p in state.rglob("*.json") if "records" in p.relative_to(state).parts]


def inspect_bundle(bundle: dict, repo: Path) -> dict:
    if bundle.get("version") != 1 or set(bundle.get("runs", {})) != ROLES:
        raise ValueError("Every phase-0 role is required; partial bundles cannot pass")
    roots, probes, native = {}, {}, {}
    identities, launches, initial = [], [], []
    for role, selected in bundle["runs"].items():
        root = Path(selected["run"])
        roots[role] = root
        probes[role] = load(root / "probe.json")
        native[role] = load(repo / selected["job"])
        identities.append(load(root / "source-before.json"))
        for path in root.rglob("launch.json"):
            launches.append(load(path))
            stdout = path.parent / "stdout.jsonl"
            for line in stdout.read_text().splitlines():
                event = json.loads(line)
                if event.get("type") == "system" and event.get("subtype") == "init":
                    initial.append((role, event))
    binaries = {str(Path(launch["argv"][0])) for launch in launches}
    actual_binaries = {p: file_digest(Path(p)) for p in binaries}
    probes_pass = all(p.get("passed", p.get("diagnostic_complete", False)) is True for p in probes.values())
    sources_current = all(file_digest(Path(path)) == expected for identity in identities for path, expected in identity.items())
    expected_plugins = {role: ({"context-harness"} if role == "contamination" else set() if role == "transport" else {"context-harness", "long-task-observer"}) for role in ROLES}
    plugin_inventory = True
    for role, event in initial:
        custom = {p["name"] for p in event.get("plugins", []) if p.get("path") != "builtin"}
        builtins = {p["name"] for p in event.get("plugins", []) if p.get("path") == "builtin"}
        plugin_inventory = plugin_inventory and custom == expected_plugins[role] and builtins == BUILTINS
    bodies = []
    for root in roots.values():
        for path in root.rglob("requests/*.json"):
            record = load(path)
            if record.get("method") == "POST" and record.get("path", "").split("?", 1)[0] == "/v1/messages":
                bodies.append(json.loads(record["request_body"]))
    env = probes["environment"]
    inventory_events = [load(p) for p in sorted((roots["environment"] / "observer/events").glob("*.json"))]
    compact = [e for e in inventory_events if e.get("name") == "compact-after"]
    inventories = [e for e in inventory_events if e.get("name") == "instruction-inventory"]
    source_file = roots["environment"] / "task/CLAUDE.md"
    expected = {str(source_file): source_file.read_text()}
    before = [e for e in inventories if compact and e["sequence"] < compact[0]["sequence"]]
    after = [e for e in inventories if compact and e["sequence"] > compact[-1]["sequence"]]
    ledger_path = repo / bundle["ledger"]
    ledger = SpendLedger(ledger_path)
    accounting = {}
    with closing(sqlite3.connect(ledger_path)) as db:
        for role in ("lifecycle", "stop_off", "stop_active"):
            count = db.execute("SELECT count(*) FROM calls WHERE run=?", (roots[role].name,)).fetchone()[0]
            accounting[role] = account(records_at(roots[role]), expected_calls=count)
    transport = probes["transport"].get("cases", {})
    compiled = lifecycle_audit(roots["lifecycle"])
    repo_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    budget = load(repo / bundle["budget_snapshots"])
    before_meter = budget["before"]
    after_meter = budget["after"]
    before_events = [json.loads(s) for s in Path(before_meter["source"]).read_text().splitlines()]
    before_actual = before_events[before_meter["event_index"]]
    after_actual = load(Path(after_meter["source"]))
    after_headers = {k.lower(): v for k, v in after_actual["response_headers"].items()}
    meters_valid = (file_digest(Path(before_meter["source"])) == before_meter["source_sha256"] and
                    file_digest(Path(after_meter["source"])) == after_meter["source_sha256"] and
                    before_actual.get("type") == "rate_limit_event" and before_actual["rate_limit_info"].get("unifiedWindows") == before_meter["windows"] and
                    before_actual["rate_limit_info"].get("status") == before_meter["status"] and
                    float(after_headers["anthropic-ratelimit-unified-5h-utilization"]) == after_meter["five_hour"]["utilization"] and
                    float(after_headers["anthropic-ratelimit-unified-7d-utilization"]) == after_meter["seven_day"]["utilization"] and
                    int(after_headers["anthropic-ratelimit-unified-5h-reset"]) == after_meter["five_hour"]["resetsAt"] and
                    int(after_headers["anthropic-ratelimit-unified-7d-reset"]) == after_meter["seven_day"]["resetsAt"] and
                    after_headers["anthropic-ratelimit-unified-status"] == after_meter["status"] and
                    budget.get("authorization", {}).get("claude_transport") == "subscription" and
                    budget.get("authorization", {}).get("paid_claude_api_ceiling_usd") == 0 and budget["authorization"].get("jev_shared_ceiling_usd") == 10)
    checks = {
        "contract_and_checkout_current": file_digest(repo / "docs/research/next-evaluation.md") == bundle["plan_sha256"] and repo_head == bundle["head"],
        "all_six_native_jobs_terminal_success": all(j.get("exit_code") == 0 and j.get("ended_at", 0) >= j.get("started_at", 1) and j.get("cwd") == str(repo) for j in native.values()),
        "all_component_receipts_pass": probes_pass,
        "all_recorded_inputs_match_current_sources": sources_current and all(
            p.get("source_changed") == [] if role != "contamination" else p.get("checks", {}).get("source_unchanged") is True
            for role, p in probes.items()),
        "pinned_cli_binary_matches": bool(launches) and all(l["binary_sha256"] == actual_binaries[l["argv"][0]] for l in launches),
        "subscription_launches_have_no_api_key_source": bool(initial) and all(e.get("apiKeySource") == "none" for _, e in initial),
        "actual_requests_use_haiku_max_adaptive": bool(bodies) and all(b.get("model") == DEFAULT_MODEL and b.get("output_config", {}).get("effort") == DEFAULT_EFFORT and b.get("thinking", {}).get("type") == "adaptive" for b in bodies),
        "only_declared_plugins_and_skills": plugin_inventory and env.get("checks", {}).get("only_harness_skills") is True and env.get("checks", {}).get("no_external_mcp_or_output_style") is True,
        "proxy_no_proxy_equivalence": transport.get("equivalence", {}).get("passed") is True,
        "forced_error_retry_with_and_without_proxy": transport.get("retry", {}).get("passed") is True and len(transport["retry"].get("cases", [])) == 2,
        "live_long_sse_stream": transport.get("long-stream", {}).get("passed") is True,
        "cancelled_stream_preserved_as_incomplete": transport.get("cancel", {}).get("passed") is True and transport["cancel"].get("scorable_run") is False,
        "persistent_driver_full_chain": compiled["full_chain_complete"],
        "instructions_preserved_before_and_after_compaction": intact(before, expected) and intact(after, expected) and env.get("checks", {}).get("instruction_delivered_before_after") is True,
        "automatic_memory_absent_and_unwritten": env.get("checks", {}).get("no_memory_instruction_or_nonempty_block") is True and env.get("checks", {}).get("no_memory_writes") is True and env.get("checks", {}).get("fresh_profile_path_verified") is True,
        "first_party_trusted_proxy_classification": env.get("checks", {}).get("provider_classified_first_party_trusted_proxy") is True,
        "read_edit_and_test_permissions": env.get("checks", {}).get("read_edit_and_test_permissions") is True,
        "transient_prohibited_action_watcher": env.get("checks", {}).get("watcher_transient_probe") is True,
        "teardown_and_controlled_contamination": probes["contamination"].get("passed") is True and
            set(probes["contamination"].get("checks", {})) == CONTAMINATION_CHECKS and all(probes["contamination"]["checks"].values()),
        "stop_observer_ordering_and_basic_controls": stop_cases_complete(probes["stop_off"], probes["stop_active"], records_at(roots["stop_active"])),
        "source_bound_jev_usage_map_and_call_census": load(repo / "experiments/long-task/jev-usage-map.json") == source_map(repo) and all(a["unknown_usage_calls"] == 0 for a in accounting.values()),
        "global_jev_spend_within_approved_ceiling": ledger.summary()["committed_upper_usd"] <= 10,
        "phase_budget_and_before_after_account_meters": meters_valid,
    }
    return {"phase": 0, "phase_0_complete": all(checks.values()), "checks": checks, "jev": ledger.summary(),
            "accounting": accounting, "runs": bundle["runs"], "budget": budget,
            "limits": ["This does not pass phase 1, the pilots, the 36 main runs or semantic judging.",
                       "Contamination detection covers explicit captured tool targets; opaque commands remain unresolved. It is not an OS syscall trace.",
                       "Stop stimuli are controlled announcements/reports/questions, not Q3 natural-stop completion outcomes."]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    result = inspect_bundle(load(args.bundle), repo)
    write_new(args.output, result)
    lines = ["# Phase 0 acceptance, 2026-10-26", "", "PASS" if result["phase_0_complete"] else "INCOMPLETE", "",
             "| Requirement | Result |", "| --- | --- |"]
    lines += [f"| {name} | {'PASS' if passed else 'FAIL'} |" for name, passed in result["checks"].items()]
    lines += ["", f"{sum(result['checks'].values())}/{len(result['checks'])} gates passed. Pilots: 0/4. Main runs: 0/36.",
              f"Jev known spend: USD {result['jev']['known_spend_usd']}; unknown calls: {result['jev']['unknown_calls']}; ceiling: USD 10.", ""]
    lines += ["- " + item for item in result["limits"]]
    lines += ["", "Original receipts and source fingerprints: `" + str(args.bundle) + "`.", ""]
    args.report.parent.mkdir(parents=True, exist_ok=True)
    with args.report.open("x") as out:
        out.write("\n".join(lines))
    print(json.dumps({"phase_0_complete": result["phase_0_complete"], "passed": sum(result["checks"].values()), "expected": len(result["checks"]), "jev": result["jev"]}, indent=2))
    return 0 if result["phase_0_complete"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
