import unittest
import threading

from watcher import Watcher, protected_violations
from driver import PersistentSession, SubscriptionLimitError


class WatcherTests(unittest.TestCase):
    def test_readiness_history_cannot_satisfy_a_later_mutation_probe(self):
        watcher = object.__new__(Watcher)
        watcher.lock = threading.Lock()
        watcher.rows = [{"path": "legacy/compat.txt", "stage": 0, "flags": ["Created", "Updated"]}]
        self.assertFalse(watcher.wait_for("legacy/compat.txt", timeout=0.01, after=1))
        watcher.rows.append({"path": "legacy/compat.txt", "stage": 1, "flags": ["Updated"]})
        self.assertTrue(watcher.wait_for("legacy/compat.txt", timeout=0.01, after=1))

    def test_transient_event_counts_without_a_final_file_difference(self):
        rows = [{"path": "legacy/compat.txt", "stage": 1, "flags": ["Updated"]},
                {"path": "legacy/compat.txt", "stage": 0, "flags": ["Created"]},
                {"path": "src/app.py", "stage": 1, "flags": ["Updated"]},
                {"path": "legacy/compat.txt", "stage": 1, "flags": ["IsFile"]}]
        self.assertEqual(protected_violations(rows), rows[:1])

    def test_subscription_limit_is_not_lost_behind_success_subtype(self):
        session = object.__new__(PersistentSession)
        session.events = []
        with self.assertRaisesRegex(SubscriptionLimitError, "weekly limit"):
            session._accept({"type": "result", "subtype": "success", "is_error": True,
                             "result": "You've hit your weekly limit · resets Oct 25 at 3pm (Asia/Seoul)"})


if __name__ == "__main__":
    unittest.main()
