"""Exercise persistent input and explicit result boundaries with a fake CLI.

This does not substitute for the real-engine full-chain acceptance test.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from driver import PersistentSession, assistant_text


class DriverTests(unittest.TestCase):
    def test_direct_control_has_no_inherited_proxy_and_never_claims_original_captures(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            binary = root / "fixture-cli"
            binary.write_text('''#!/usr/bin/env python3
import json, os, sys
for line in sys.stdin:
    print(json.dumps({"type":"assistant","message":{"content":[{"type":"text","text":str("ANTHROPIC_BASE_URL" in os.environ)}]}}),flush=True)
    print(json.dumps({"type":"result","subtype":"success"}),flush=True)
''')
            binary.chmod(0o700)
            (root / "task").mkdir()
            session = PersistentSession(binary=binary, config=root, model="fixture-model", workspace=root / "task",
                                        evidence=root / "evidence", plugin=None, settings={}, recording=False)
            events = session.stage("one", settle_seconds=1.05, timeout=5)
            self.assertEqual(assistant_text(events), "False")
            self.assertTrue(session.close(drain_seconds=0)["runner_observed_end"])
            self.assertFalse(session.captures_complete())

    def test_two_stages_use_one_process_and_empty_captures_are_incomplete(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            binary = root / "fixture-cli"
            binary.write_text('''#!/usr/bin/env python3
import json, os, sys
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({"type":"assistant","pid":os.getpid(),"message":{"content":[{"type":"text","text":request["message"]["content"][0]["text"]}]}}),flush=True)
    print(json.dumps({"type":"result","subtype":"success"}),flush=True)
''')
            binary.chmod(0o700)
            (root / "task").mkdir()
            session = PersistentSession(binary=binary, config=root, model="fixture-model", workspace=root / "task",
                                        evidence=root / "evidence", plugin=None, settings={})
            first = session.stage("one", settle_seconds=1.05, timeout=5)
            second = session.stage("two", settle_seconds=1.05, timeout=5)
            settings = json.loads((root / "evidence/settings.json").read_text())
            self.assertFalse(settings["syncClaudeAiSkills"])
            self.assertFalse(settings["syncClaudeAiPlugins"])
            self.assertTrue(settings["disableBundledSkills"])
            self.assertFalse(settings["autoMemoryEnabled"])
            result = session.close(drain_seconds=0)
            self.assertEqual(assistant_text(first), "one")
            self.assertEqual(assistant_text(second), "two")
            pids = {e["pid"] for e in first + second if e["type"] == "assistant"}
            self.assertEqual(len(pids), 1)
            self.assertTrue(result["runner_observed_end"])
            self.assertFalse(result["evidence_complete"])

    def test_early_exit_cannot_be_called_a_completed_stage(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            binary = root / "fixture-cli"
            binary.write_text('#!/usr/bin/env python3\nimport sys\nsys.stdin.readline()\nprint("partial",flush=True)\n')
            binary.chmod(0o700)
            (root / "task").mkdir()
            session = PersistentSession(binary=binary, config=root, model="fixture-model", workspace=root / "task",
                                        evidence=root / "evidence", plugin=None, settings={})
            try:
                with self.assertRaises(RuntimeError):
                    session.stage("one", settle_seconds=1.05, timeout=5)
            finally:
                session.abort()


if __name__ == "__main__":
    unittest.main()
