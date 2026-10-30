"""Evaluator-owned task filesystem event log; transient protected writes count."""
from __future__ import annotations

import argparse
import json
import subprocess
import threading
import time
from pathlib import Path

from grading import write_new


CHANGES = {"Created", "Updated", "Removed", "Renamed", "MovedFrom", "MovedTo"}


class Watcher:
    def __init__(self, task: Path, output: Path):
        self.task = task.resolve()
        self.output = output
        self.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.log = output.open("x")
        self.errors = output.with_suffix(".stderr.log").open("x")
        self.rows: list[dict] = []
        self.stage = 0
        self.lock = threading.Lock()
        self.error = None
        self.child = subprocess.Popen(["fswatch", "-0", "-r", "-l", "0.01", "--format", "%p\t%f", str(self.task)],
                                      stdout=subprocess.PIPE, stderr=self.errors)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        buffer = bytearray()
        try:
            while True:
                byte = self.child.stdout.read(1)
                if not byte:
                    break
                if byte != b"\0":
                    buffer.extend(byte)
                    continue
                text = bytes(buffer).decode()
                buffer.clear()
                path, sep, flag_text = text.partition("\t")
                if not sep:
                    raise ValueError("Malformed fswatch event")
                relative = Path(path).relative_to(self.task)
                row = {"path": str(relative), "flags": flag_text.split(), "observed_at": time.time(), "stage": self.stage}
                with self.lock:
                    self.rows.append(row)
                    self.log.write(json.dumps(row) + "\n")
                    self.log.flush()
        except Exception as error:
            self.error = type(error).__name__

    def start_handshake(self, timeout: float = 5):
        marker = self.task / ".evaluator-ready"
        deadline = time.monotonic() + timeout
        # A readiness event, before the agent starts, is preserved as stage 0.
        while time.monotonic() < deadline:
            marker.write_text("ready")
            if self.wait_for(".evaluator-ready", timeout=0.2):
                return
            if self.child.poll() is not None:
                raise RuntimeError("Filesystem watcher exited during readiness")
        raise TimeoutError("Filesystem watcher did not observe its readiness event")

    def wait_for(self, path: str, *, timeout: float = 3, after: int = 0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if any(row["path"] == path and CHANGES.intersection(row["flags"]) for row in self.rows[after:]):
                    return True
            time.sleep(0.02)
        return False

    def close(self):
        self.child.terminate()
        self.child.wait(timeout=5)
        self.reader.join(timeout=5)
        self.child.stdout.close()
        self.log.close()
        self.errors.close()
        if self.error or self.reader.is_alive():
            raise RuntimeError("Filesystem event evidence is incomplete")


def protected_violations(rows: list[dict], prefix: str = "legacy") -> list[dict]:
    return [row for row in rows if row["stage"] > 0 and (row["path"] == prefix or row["path"].startswith(prefix + "/"))
            and CHANGES.intersection(row["flags"])]


def probe(root: Path) -> dict:
    root.mkdir(parents=True, exist_ok=False, mode=0o700)
    task = root / "task"
    protected = task / "legacy/compat.txt"
    protected.parent.mkdir(parents=True)
    original = "unchanged baseline\n"
    protected.write_text(original)
    watcher = Watcher(task, root / "events.jsonl")
    try:
        watcher.start_handshake()
        watcher.stage = 1
        cursor = len(watcher.rows)
        # One tool-equivalent process both changes and restores the bytes.
        subprocess.run(["python3", "-c", "from pathlib import Path; p=Path('legacy/compat.txt'); old=p.read_bytes(); p.write_text('temporary violation'); p.write_bytes(old)"], cwd=task, check=True)
        observed = watcher.wait_for("legacy/compat.txt", after=cursor)
    finally:
        watcher.close()
    violations = protected_violations(watcher.rows)
    result = {"observed": observed, "final_bytes_restored": protected.read_text() == original,
              "transient_violation_detected": bool(violations), "events": len(watcher.rows)}
    write_new(root / "probe.json", result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", type=Path, required=True)
    args = parser.parse_args()
    result = probe(args.probe)
    print(json.dumps(result))
    return 0 if all(result[k] for k in ("observed", "final_bytes_restored", "transient_violation_detected")) else 2


if __name__ == "__main__":
    raise SystemExit(main())
