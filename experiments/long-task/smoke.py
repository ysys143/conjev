"""Phase-0 plain-turn probe. This alone cannot pass phase 0."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from driver import DEFAULT_EFFORT, DEFAULT_MODEL, PersistentSession, assistant_text
from grading import check_subscription, write_new


def request_settings(root: Path) -> list[dict]:
    settings = []
    for path in sorted((root / "evidence/requests").glob("*.json")):
        capture = json.loads(path.read_text())
        if capture.get("method") != "POST" or capture.get("path", "").split("?", 1)[0] != "/v1/messages":
            continue
        body = json.loads(capture["request_body"])
        settings.append({"model": body.get("model"), "effort": body.get("output_config", {}).get("effort"),
                         "thinking": body.get("thinking", {}).get("type"), "status": capture.get("status")})
    return settings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Full executor model ID")
    parser.add_argument("--effort", default=DEFAULT_EFFORT, choices=["low", "medium", "high", "xhigh", "max"])
    parser.add_argument("--claude", type=Path, default=Path.home() / ".local/share/claude/versions/2.1.309")
    args = parser.parse_args()
    version = check_subscription(args.claude, args.config)
    args.root.mkdir(parents=True, exist_ok=False, mode=0o700)
    workspace = args.root / "task"
    workspace.mkdir()
    session = PersistentSession(binary=args.claude, config=args.config, model=args.model, effort=args.effort, workspace=workspace,
                                evidence=args.root / "evidence", plugin=None,
                                settings={"autoMemoryEnabled": False, "alwaysThinkingEnabled": True, "enabledPlugins": {}})
    try:
        events = session.stage("Reply with exactly OK. Do not use tools.", timeout=90)
        write_new(args.root / "turn.json", {"events": events, "answer": assistant_text(events)})
        closure = session.close(drain_seconds=2.5)
        models = sorted({event.get("model") for event in session.events if event.get("type") == "system" and event.get("subtype") == "init" and isinstance(event.get("model"), str)})
        wire = request_settings(args.root)
        initial = next((e for e in session.events if e.get("type") == "system" and e.get("subtype") == "init"), {})
        inventory = {"skills": initial.get("skills"), "plugins": initial.get("plugins"),
                     "mcp_servers": initial.get("mcp_servers"), "output_style": initial.get("output_style")}
        isolated = (inventory["skills"] == [] and inventory["mcp_servers"] == []
                    and inventory["output_style"] == "default" and isinstance(inventory["plugins"], list)
                    and all(p.get("path") == "builtin" for p in inventory["plugins"]))
        matched = bool(wire) and all(r["model"] == args.model and r["effort"] == args.effort
                    and (args.effort not in ("xhigh", "max") or r["thinking"] != "disabled") for r in wire)
        write_new(args.root / "smoke.json", {"version": version, "models": models, "closure": closure,
                  "requested_model": args.model, "requested_effort": args.effort, "request_settings": wire,
                  "settings_match": matched, "inventory": inventory, "inventory_isolated": isolated,
                  "phase_0_complete": False})
        print(json.dumps({"models": models, "closure": closure, "request_settings": wire,
                          "settings_match": matched, "inventory_isolated": isolated}))
        return 0 if closure["runner_observed_end"] and closure["evidence_complete"] and matched and isolated else 2
    except Exception as exc:
        session.abort()
        write_new(args.root / "error.json", {"error_class": type(exc).__name__, "message": str(exc),
                  "requested_model": args.model, "requested_effort": args.effort,
                  "request_settings": request_settings(args.root)})
        raise


if __name__ == "__main__":
    raise SystemExit(main())
