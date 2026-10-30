"""Read-only environment audit, with optional new evaluator-owned JSON receipt."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path

from grading import SubscriptionAccessError, check_subscription, file_digest, write_new


def audit(binary: Path, config: Path, root: Path) -> dict:
    checks = []
    def check(name, ok, evidence):
        checks.append({"check": name, "status": "PASS" if ok else "BLOCKED", "evidence": evidence})
    check("branch", subprocess.check_output(["git", "branch", "--show-current"], cwd=root, text=True).strip() == "experiment/fold-recovery", "git branch --show-current")
    check("pinned_binary", binary.is_file(), str(binary))
    for tool in ("python3", "node", "tmux", "fswatch"):
        resolved = shutil.which(tool)
        check(tool, resolved is not None, resolved)
    try:
        version = check_subscription(binary, config)
        check("subscription_credential_access", True, {"version": version, "source": "claude.ai", "provider": "firstParty"})
    except SubscriptionAccessError as exc:
        check("subscription_credential_access", False, {"error_class": type(exc).__name__,
              "message": "This execution context cannot verify subscription credential access; not a verdict on whether the user logged in",
              **exc.evidence})
    except Exception as exc:
        check("subscription_credential_access", False, {"error_class": type(exc).__name__, "message": "Credential check did not complete; no model calls made"})
    # Presence is not acceptance. These need actual execution in phase 0, after auth.
    live = ["resolved_executor_model", "proxy_transport_live", "subscription_retry_live", "proxy_equivalence",
            "first_party_trust", "persistent_driver_full_chain", "instruction_inventory_before_and_after_compaction",
            "auto_memory_absent", "prohibited_action_watcher", "teardown_and_contamination_detection",
            "jev_usage_mapping_and_spend_reservation"]
    checks += [{"check": name, "status": "NOT RUN", "evidence": None} for name in live]
    return {"phase": 0, "complete": False, "model_calls": 0, "jev_spend_usd": 0,
            "plugin_source": {str(p.relative_to(root)): file_digest(p) for p in sorted((root / "hooks").glob("*.ts"))},
            "checks": checks}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--claude", type=Path, default=Path.home() / ".local/share/claude/versions/2.1.309")
    parser.add_argument("--config", type=Path, default=Path.home() / ".claude-research")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    result = audit(args.claude, args.config, root)
    if args.output:
        write_new(args.output, result)
    print(json.dumps({k: v for k, v in result.items() if k != "plugin_source"}, ensure_ascii=False, indent=2))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
