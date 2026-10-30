from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from observation import ObservationServer, snapshot, validate_observations, verify_snapshot
from spend import SpendLedger


SUCCESS = [{"type": "result", "subtype": "success", "is_error": False}]


class ObservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.task = self.root / "task"
        self.task.mkdir()
        (self.task / "answer.txt").write_text("unfinished")
        self.server = ObservationServer(self.task, self.root / "observer", SpendLedger(self.root / "spend.sqlite3"), "fixture")
        self.addCleanup(self.server.server_close)
        self.server.session_id = "fixture-session"
        self.server.begin_stage(1)

    def candidate(self):
        return self.server.candidate({"event": {"session_id": "fixture-session", "stop_hook_active": False,
                                                "prompt_id": "fixture-turn", "last_assistant_message": "I will finish it."},
                                      "messages": [{"role": "user", "content": [{"type": "text", "text": "Finish the answer"}]}]})["candidate_id"]

    def completed(self):
        first = self.candidate()
        self.server.decision({"candidate_id": first, "result": {"block": "continue"}, "pre_observer_ms": 1, "underlying_ms": 2})
        (self.task / "answer.txt").write_text("finished")
        second = self.candidate()
        self.server.decision({"candidate_id": second, "result": {}})
        self.server.finish_stage(SUCCESS)
        return first, second

    def test_pre_decision_snapshot_and_continuation_are_independent_copies(self):
        first, second = self.completed()
        self.assertEqual((self.server.store / "snapshots" / first / "files/answer.txt").read_text(), "unfinished")
        self.assertEqual((self.server.store / "snapshots" / second / "files/answer.txt").read_text(), "finished")
        following = json.loads((self.server.store / "candidates" / f"{second}.json").read_text())
        self.assertEqual(following["continuation_of"], first)
        self.assertEqual(validate_observations(self.server.store), {"stages": 1, "candidates": 2, "blocked": 1, "complete": True})

    def test_dropped_continuation_never_becomes_a_completed_stage(self):
        first = self.candidate()
        self.server.decision({"candidate_id": first, "result": {"block": "continue"}})
        with self.assertRaisesRegex(ValueError, "dropped"):
            self.server.finish_stage(SUCCESS)
        with self.assertRaisesRegex(ValueError, "Dropped"):
            validate_observations(self.server.store)
        with self.assertRaises(ValueError):
            self.server.begin_stage(2)

    def test_missing_pre_snapshot_deleted_candidate_and_corrupt_copy_are_rejected(self):
        first, second = self.completed()
        manifest = self.server.store / "snapshots" / first / "snapshot.json"
        original = manifest.read_bytes()
        manifest.unlink()
        with self.assertRaises(OSError):
            validate_observations(self.server.store)
        manifest.write_bytes(original)
        copy = self.server.store / "snapshots" / first / "files/answer.txt"
        copy.write_text("changed")
        with self.assertRaisesRegex(ValueError, "artifact changed"):
            validate_observations(self.server.store)
        copy.write_text("unfinished")
        (self.server.store / "candidates" / f"{second}.json").unlink()
        with self.assertRaisesRegex(ValueError, "Missing or extra"):
            validate_observations(self.server.store)

    def test_no_cross_session_or_unmatched_or_unfinished_stop_can_close(self):
        with self.assertRaises(ValueError):
            self.server.candidate({"event": {"session_id": "other"}, "messages": []})
        identity = self.candidate()
        with self.assertRaises(ValueError):
            self.server.decision({"candidate_id": "unknown", "result": {}})
        with self.assertRaises(ValueError):
            self.server.finish_stage(SUCCESS)
        self.server.decision({"candidate_id": identity, "result": {}})
        with self.assertRaises(ValueError):
            self.server.finish_stage([])

    def test_snapshot_does_not_follow_links_to_personal_files(self):
        outside = self.root / "outside.txt"
        outside.write_text("private fixture")
        (self.task / "link").symlink_to(outside)
        dest = self.root / "snapshot"
        manifest = snapshot(self.task, dest)
        self.assertEqual(manifest["files"]["link"]["kind"], "symlink")
        self.assertFalse((dest / "files/link").exists())
        verify_snapshot(dest)


if __name__ == "__main__":
    unittest.main()
