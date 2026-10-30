"""One Claude process per staged trial. Live full-chain acceptance is mandatory."""
from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import threading
import time
import uuid
from pathlib import Path

from capture import Recorder
from grading import file_digest, subscription_env, write_new
from observation import ObservationServer

DEFAULT_MODEL = "claude-haiku-5-5"
DEFAULT_EFFORT = "max"


def research_settings(settings: dict) -> dict:
    """Session-only isolation; never alter the owner's profile or synced files."""
    selected = json.loads(json.dumps(settings))
    overrides = {**selected.get("skillOverrides", {}),
                 "design": "off", "doctor": "off", "plugin-authoring": "off"}
    return {**selected, "skillOverrides": overrides, "autoMemoryEnabled": False,
            "syncClaudeAiSkills": False, "syncClaudeAiPlugins": False,
            "disableBundledSkills": True}


class SubscriptionLimitError(RuntimeError):
    pass


class PersistentSession:
    def __init__(self, *, binary: Path, config: Path, model: str, workspace: Path,
                 evidence: Path, plugin: Path | None, settings: dict, effort: str = DEFAULT_EFFORT,
                 observer: ObservationServer | None = None, recording: bool = True,
                 upstream: tuple[str, int, bool] | None = None):
        evidence.mkdir(parents=True, exist_ok=False, mode=0o700)
        self.evidence, self.workspace = evidence, workspace
        self.session_id = str(uuid.uuid4())
        self.observer = observer
        if observer is not None:
            observer.session_id = self.session_id
        self.events: list[dict] = []
        self.incoming: queue.Queue = queue.Queue()
        self.last_event = time.monotonic()
        self.reader_error: str | None = None
        self.proxy = (Recorder(evidence / "requests", **({"upstream": upstream} if upstream is not None else {}))
                      if recording else None)
        if self.proxy is not None:
            threading.Thread(target=self.proxy.serve_forever, daemon=True).start()
        self.proxy_thread_closed = self.proxy is None
        selected = evidence / "plugin-state"
        effective_settings = research_settings(settings)
        for value in effective_settings.get("pluginConfigs", {}).values():
            if isinstance(value, dict) and isinstance(value.get("options"), dict):
                value["options"]["trustedProxies"] = f"127.0.0.1:{self.proxy.server_port}" if self.proxy else ""
        settings_path = evidence / "settings.json"
        write_new(settings_path, effective_settings)
        env = subscription_env(config)
        if self.proxy is not None:
            env["ANTHROPIC_BASE_URL"] = self.proxy.url
        elif upstream is not None:
            host, port, secure = upstream
            if host != "127.0.0.1":
                raise ValueError("A diagnostic endpoint must be on loopback")
            env["ANTHROPIC_BASE_URL"] = f"{'https' if secure else 'http'}://{host}:{port}"
        env["CONTEXT_HARNESS_STATE_HOME"] = str(selected)
        env.pop("CONTEXT_HARNESS_EVAL_URL", None)
        if observer is not None:
            env["CONTEXT_HARNESS_EVAL_URL"] = observer.url
        # Keep the task's session record available. No resume/continue is used.
        cmd = [str(binary), "-p", "--model", model, "--effort", effort,
               "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
               "--include-hook-events", "--session-id", self.session_id,
               "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
               "--settings", str(settings_path), "--setting-sources", "user,project,local",
               "--permission-mode", "acceptEdits", "--allowedTools", "Read,Write,Edit,Glob,Grep,Bash",
               "--no-chrome"]
        plugins = ([Path(__file__).resolve().parent / "observer"] if observer is not None else []) + ([plugin] if plugin is not None else [])
        for directory in plugins:
            cmd += ["--plugin-dir", str(directory)]
        self.output = (evidence / "stdout.jsonl").open("w")
        self.errors = (evidence / "stderr.log").open("w")
        write_new(evidence / "launch.json", {"argv": cmd, "session_id": self.session_id,
                                            "binary_sha256": file_digest(binary), "model_requested": model,
                                            "effort_requested": effort,
                                            "transport": "recorded-loopback" if recording else "direct-unrecorded"})
        try:
            self.process = subprocess.Popen(cmd, cwd=workspace, env=env, stdin=subprocess.PIPE,
                                            stdout=subprocess.PIPE, stderr=self.errors, text=True,
                                            bufsize=1, start_new_session=True)
        except BaseException:
            self._close_resources()
            raise
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            for line in self.process.stdout:
                self.output.write(line)
                self.output.flush()
                self.last_event = time.monotonic()
                try:
                    value = json.loads(line)
                    if not isinstance(value, dict):
                        raise ValueError("non-object event")
                    self.incoming.put(value)
                except ValueError:
                    self.reader_error = "invalid-stream-json"
                    self.incoming.put({"type": "driver_error", "error": self.reader_error})
        finally:
            self.incoming.put({"type": "driver_eof"})

    def _accept(self, event: dict):
        self.events.append(event)
        if event.get("type") == "driver_error":
            raise RuntimeError("Invalid Claude event stream; evidence is incomplete")
        if event.get("type") == "driver_eof":
            raise RuntimeError("Claude exited before the staged run was closed")
        if event.get("type") == "result" and (event.get("is_error") or event.get("subtype") != "success"):
            if "weekly limit" in str(event.get("result", "")).lower():
                raise SubscriptionLimitError(str(event["result"]))
            raise RuntimeError(f"Claude turn did not succeed: {event.get('subtype')}")

    def stage(self, text: str, *, timeout: float = 600, settle_seconds: float = 2.5,
              stage_id: int | None = None) -> list[dict]:
        if self.process.poll() is not None:
            raise RuntimeError("The persistent Claude process is no longer alive")
        if settle_seconds <= 1:
            raise ValueError("Settle time must exceed the plugin's one-second timers")
        if self.observer is not None and stage_id is not None:
            self.observer.begin_stage(stage_id)
        start = len(self.events)
        request = {"type": "user", "session_id": self.session_id,
                   "message": {"role": "user", "content": [{"type": "text", "text": text}]}}
        self.process.stdin.write(json.dumps(request) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + timeout
        saw_result = False
        while time.monotonic() < deadline:
            try:
                event = self.incoming.get(timeout=0.1)
            except queue.Empty:
                quiet_since = max(self.last_event, self.proxy.last_activity if self.proxy else self.last_event)
                if saw_result and (self.proxy is None or self.proxy.idle()) and time.monotonic() - quiet_since >= settle_seconds:
                    result = self.events[start:]
                    if self.observer is not None and stage_id is not None:
                        self.observer.finish_stage(result)
                    return result
                if self.process.poll() is not None:
                    raise RuntimeError("Claude exited while waiting for a stage")
                continue
            self._accept(event)
            if event.get("type") == "result":
                saw_result = True
        raise TimeoutError("Stage ceiling reached; keep partial evidence")

    def drain(self, seconds: float = 60):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                self._accept(self.incoming.get(timeout=min(0.1, max(0.001, deadline - time.monotonic()))))
            except queue.Empty:
                if self.process.poll() is not None:
                    raise RuntimeError("Claude exited before the background drain finished")

    def close(self, *, drain_seconds: float = 60) -> dict:
        observed_end = False
        failure = None
        try:
            self.drain(drain_seconds)
            self.process.stdin.close()
            self.process.wait(timeout=30)
            self.reader.join(timeout=5)
            observed_end = self.process.returncode == 0 and not self.reader.is_alive()
            if not observed_end:
                failure = "nonzero-or-unclosed-process"
        except Exception as exc:
            failure = type(exc).__name__
            self.abort()
        finally:
            self._close_resources()
        return {"runner_observed_end": observed_end, "exit_code": self.process.returncode,
                "error": failure, "evidence_complete": self.captures_complete() and self.reader_error is None}

    def captures_complete(self) -> bool:
        # Direct mode is only a phase-0 control. It can never supply a scored
        # run's required original request captures.
        return self.proxy is not None and self.proxy.records_complete()

    def abort(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait()
        self.reader.join(timeout=5)
        self._close_resources()

    def _close_resources(self):
        if not self.proxy_thread_closed:
            self.proxy.shutdown()
            self.proxy.server_close()
            self.proxy_thread_closed = True
        process = getattr(self, 'process', None)
        if process is not None:
            for pipe in (process.stdin, process.stdout):
                if pipe is not None and not pipe.closed:
                    pipe.close()
        self.output.close()
        self.errors.close()


def assistant_text(events: list[dict]) -> str:
    return "\n".join(block["text"] for event in events if event.get("type") == "assistant"
                     for block in (event.get("message") or {}).get("content", [])
                     if isinstance(block, dict) and block.get("type") == "text")
