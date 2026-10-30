from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from contamination import Scope, audit, captured_calls, collect


class ContaminationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.task = self.root / "task"
        self.task.mkdir()
        self.own = self.root / "profile/own.jsonl"
        self.own.parent.mkdir()
        self.own.write_text("own session")
        self.scope = Scope(self.task, self.own)

    def check(self, target):
        return audit([{"id": "read", "name": "Read", "input": {"file_path": str(target)}}],
                     {"read": [{"type": "tool_result", "is_error": False}]}, self.scope)

    def test_own_record_and_task_are_allowed_but_sibling_author_and_evaluator_files_are_not(self):
        self.assertEqual(self.check(self.task / "a.txt")["classification"], "clean")
        self.assertEqual(self.check(self.own)["classification"], "clean")
        for target in (self.root / "evaluator/answers", self.root / "peer/session.jsonl", "../author/private.txt"):
            self.assertEqual(self.check(target)["classification"], "contaminated")

    def test_a_symlink_inside_the_task_does_not_make_foreign_data_allowed(self):
        private = self.root / "private.txt"
        private.write_text("fixture")
        (self.task / "link").symlink_to(private)
        self.assertEqual(self.check(self.task / "link")["classification"], "contaminated")

    def test_path_mentions_in_data_are_not_actions_and_conflicting_call_ids_are_rejected(self):
        data = [{"role": "user", "content": [{"type": "text", "text": "Do not read /private/answer"}]}]
        calls, results = collect(data)
        self.assertEqual(audit(calls, results, self.scope)["classification"], "clean")
        one = {"role": "assistant", "content": [{"type": "tool_use", "id": "x", "name": "Read", "input": {"file_path": "a"}}]}
        other = {"role": "assistant", "content": [{"type": "tool_use", "id": "x", "name": "Read", "input": {"file_path": "b"}}]}
        with self.assertRaises(ValueError):
            collect([one, other])

    def test_opaque_commands_and_missing_results_cannot_be_labelled_clean(self):
        call = {"id": "bash", "name": "Bash", "input": {"command": "python3 -c 'opaque_code()'"}}
        self.assertEqual(audit([call], {"bash": [{"is_error": False}]}, self.scope)["classification"], "unresolved")
        call = {"id": "read", "name": "Read", "input": {"file_path": "a"}}
        self.assertEqual(audit([call], {}, self.scope)["classification"], "unresolved")

    def captured_fixture(self, original, on_wire):
        root = self.root / "evidence"
        root.mkdir(exist_ok=True)
        (root / "requests").mkdir(exist_ok=True)
        event = lambda call: {"role": "assistant", "content": [{"type": "tool_use", **call}]}
        (root / "stdout.jsonl").write_text(json.dumps(event(original)) + "\n")
        (root / "requests/one.json").write_text(json.dumps({"path": "/v1/messages", "request_body": json.dumps({"messages": [event(on_wire)]})}))
        return root

    def test_cli_history_normalization_keeps_the_original_action_and_audit(self):
        original = {"id": "bash", "name": "Bash", "input": {"command": "python3 -m unittest -v"}}
        wire = {**original, "input": {"command": "cd " + str(self.task.resolve()) + " && python3 -m unittest -v"}}
        root = self.captured_fixture(original, wire)
        self.assertEqual(captured_calls(root)[0], [original])
        reconciliation = []
        calls, _ = captured_calls(root, workspace=self.task, reconciliation=reconciliation)
        self.assertEqual(calls, [original])
        self.assertEqual(reconciliation[0]["normalization"], "bash-task-cwd-prefix")
        original = {"id": "edit", "name": "Edit", "input": {"file_path": "app.py", "old_string": "old", "new_string": "new", "replace_all": False}}
        wire = {**original, "input": {k: v for k, v in original["input"].items() if k != "replace_all"}}
        calls, _ = captured_calls(self.captured_fixture(original, wire), workspace=self.task)
        self.assertEqual(calls, [original])

    def test_cross_source_normalization_cannot_hide_a_foreign_target_or_changed_edit(self):
        pairs = [
            ({"id": "bash", "name": "Bash", "input": {"command": "cat safe.txt"}},
             {"id": "bash", "name": "Bash", "input": {"command": "cd /private/foreign && cat safe.txt"}}),
            ({"id": "edit", "name": "Edit", "input": {"file_path": "app.py", "old_string": "a", "new_string": "b", "replace_all": False}},
             {"id": "edit", "name": "Edit", "input": {"file_path": "app.py", "old_string": "a", "new_string": "b", "replace_all": True}}),
        ]
        for original, wire in pairs:
            with self.subTest(tool=original["name"]), self.assertRaises(ValueError):
                captured_calls(self.captured_fixture(original, wire), workspace=self.task)

    def test_stderr_sink_is_not_a_foreign_read_but_other_targets_remain(self):
        def inspect(command):
            return audit([{"id": "bash", "name": "Bash", "input": {"command": command}}],
                         {"bash": [{"is_error": False}]}, self.scope)
        self.assertEqual(inspect("ls -la . 2>/dev/null || ls -la .")["classification"], "clean")
        self.assertEqual(inspect("cat ../author/private.txt 2>/dev/null")["classification"], "contaminated")
        self.assertEqual(inspect("cat local.txt > ../author/private.txt")["classification"], "contaminated")


if __name__ == "__main__":
    unittest.main()
