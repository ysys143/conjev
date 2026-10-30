"""Fresh, tool-free Opus/low subscription judgments with wire identity checks."""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import threading
import time
from pathlib import Path

from capture import Recorder
from grading import check_subscription, digest, file_digest, load, parse_verdict, prompt_for, result_object, subscription_env, write_new


def run_packet(packet, *, root: Path, binary: Path, config: Path, model: str, version: str, timeout=300):
    root.mkdir(parents=True, exist_ok=False, mode=0o700)
    workspace = root / "workspace"
    workspace.mkdir()
    write_new(root / "packet.json", packet)
    write_new(root / "identity.json", {"requested_model": model, "effort": "low", "binary_sha256": file_digest(binary), "version": version, "packet_sha256": digest(packet)})
    proxy = Recorder(root / "requests")
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    env = subscription_env(config)
    env["ANTHROPIC_BASE_URL"] = proxy.url
    cmd = [str(binary), "-p", "--model", model, "--effort", "low", "--output-format", "json", "--no-session-persistence",
           "--safe-mode", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "", "--setting-sources", ""]
    write_new(root / "launch.json", {"argv": cmd})
    started = time.monotonic()
    process = None
    try:
        with (root / "stdout.json").open("x") as out, (root / "stderr.log").open("x") as err:
            process = subprocess.Popen(cmd, cwd=workspace, env=env, stdin=subprocess.PIPE, stdout=out, stderr=err, text=True, start_new_session=True)
            try:
                process.communicate(prompt_for(packet), timeout=timeout)
            except BaseException:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
                raise
        if process.returncode != 0: raise RuntimeError(f"Judge CLI exited {process.returncode}")
        proxy.shutdown()
        proxy.server_close()
        transport = result_object((root / "stdout.json").read_text())
        requests = [load(p) for p in (root / "requests").glob("*.json")]
        messages = [r for r in requests if r.get("path", "").split("?", 1)[0] == "/v1/messages"]
        bodies = [json.loads(r["request_body"]) for r in messages]
        models = {b.get("model") for b in bodies}
        if not messages or not proxy.records_complete() or not all(r.get("status") == 200 for r in messages): raise ValueError("Incomplete judge transport")
        if len(models) != 1 or not all(b.get("output_config", {}).get("effort") == "low" and not b.get("tools") for b in bodies): raise ValueError("Judge settings differ on the wire")
        resolved = next(iter(models))
        if not isinstance(resolved, str) or not resolved.startswith("claude-opus-"): raise ValueError("Selected Opus alias did not resolve to an Opus model")
        if set(transport.get("modelUsage", {})) != {resolved}: raise ValueError("Judge result model differs from actual requests")
        parsed = parse_verdict(transport["result"], packet)
        result = {"judgment": parsed, "graded": parsed["verdict"] != "unscorable", "resolved_model": resolved, "effort": "low",
                  "wall_seconds": time.monotonic() - started, "usage": transport.get("usage"), "transport": "subscription", "packet_sha256": digest(packet)}
        write_new(root / "accepted.json", result)
        return result
    except BaseException as exc:
        write_new(root / "error.json", {"error": type(exc).__name__, "message": str(exc)})
        raise
    finally:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        proxy.shutdown()
        proxy.server_close()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--claude", type=Path, default=Path.home() / ".local/share/claude/versions/2.1.309")
    args = p.parse_args()
    version = check_subscription(args.claude, args.config)
    packet = {"version": 1, "blind_run_id": "judge-transport-control", "task": "Preserve C1: keep the existing API compatible.",
              "criterion": {"id": "C1", "title": "Explicit constraint restatement", "definition": "Pass only if the supplied answer explicitly states that the existing API must stay compatible."},
              "evidence": [{"id": "answer", "text": "C1: Keep the existing API backward compatible."}]}
    result = run_packet(packet, root=args.root, binary=args.claude, config=args.config, model="opus", version=version)
    if result["judgment"]["verdict"] != "pass": raise ValueError("Judge control failed")
    print(json.dumps({"resolved_model": result["resolved_model"], "effort": "low", "control_passed": True}))


if __name__ == "__main__":
    main()
