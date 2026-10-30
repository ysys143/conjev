from __future__ import annotations

import concurrent.futures
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import spend


REQUEST = {"model": "jev-latest", "state": "fixture", "questions": {"stop": {"type": "choice"}}}


class SpendTests(unittest.TestCase):
    def test_run_call_count_ignores_foreign_calls_and_includes_own_unknown_and_settled_calls(self):
        with tempfile.TemporaryDirectory() as td:
            ledger = spend.SpendLedger(Path(td) / "study.sqlite3")
            other = spend.SpendLedger(ledger.path)
            other.reserve("owned-other", REQUEST)
            self.assertEqual(ledger.call_count("owned"), 0)
            identity = ledger.reserve("owned", REQUEST)
            self.assertEqual(ledger.call_count("owned"), 1)
            ledger.settle(identity, {"model": spend.EXPECTED_MODEL, "usage": {"input_tokens": 1, "output_tokens": 0}})
            other.reserve("owned", REQUEST)
            self.assertEqual(ledger.call_count("owned"), 2)
            self.assertEqual(ledger.summary()["calls"], 3)

    def test_reservation_and_summary_close_each_database_connection(self):
        with tempfile.TemporaryDirectory() as td:
            connections = []
            connect = sqlite3.connect
            def tracked(*args, **kwargs):
                db = connect(*args, **kwargs)
                connections.append(db)
                return db
            try:
                with patch.object(spend.sqlite3, "connect", side_effect=tracked):
                    ledger = spend.SpendLedger(Path(td) / "study.sqlite3")
                    ledger.reserve("run", REQUEST)
                    ledger.summary()
                self.assertEqual(len(connections), 3)
                for db in connections:
                    with self.assertRaises(sqlite3.ProgrammingError):
                        db.execute("SELECT 1")
            finally:
                for db in connections:
                    db.close()

    def test_unknown_calls_keep_reservations_and_reopening_cannot_reset_spend(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "study.sqlite3"
            ledger = spend.SpendLedger(path)
            ledger.reserve("run-1", REQUEST)
            self.assertEqual(spend.SpendLedger(path).summary()["unknown_calls"], 1)
            self.assertEqual(ledger.summary()["committed_upper_usd"], spend.RESERVATION / 1e9)

    def test_concurrent_calls_cannot_cross_the_shared_ceiling(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "study.sqlite3"
            ledger = spend.SpendLedger(path)
            with patch.object(spend, "STUDY_LIMIT", 2 * spend.RESERVATION):
                def attempt(n):
                    try:
                        return ledger.reserve(f"run-{n}", REQUEST)
                    except ValueError:
                        return None
                with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                    outcomes = list(pool.map(attempt, range(8)))
            self.assertEqual(sum(x is not None for x in outcomes), 2)
            self.assertEqual(ledger.summary()["unknown_calls"], 2)

    def test_settlement_is_once_per_call_and_rejects_drift_invalid_usage_and_conflicts(self):
        with tempfile.TemporaryDirectory() as td:
            ledger = spend.SpendLedger(Path(td) / "study.sqlite3")
            identity = ledger.reserve("run", REQUEST)
            valid = {"model": spend.EXPECTED_MODEL, "usage": {"input_tokens": 300, "output_tokens": 10}}
            for invalid in [{}, valid | {"model": "drift"}, valid | {"usage": {"input_tokens": -1, "output_tokens": 10}}]:
                with self.assertRaises(ValueError):
                    ledger.settle(identity, invalid)
                self.assertEqual(ledger.summary()["unknown_calls"], 1)
            ledger.settle(identity, valid)
            ledger.settle(identity, valid)
            self.assertEqual(ledger.summary()["known_spend_usd"], 300 * 42 / 1e9)
            self.assertEqual(ledger.summary()["unknown_calls"], 0)
            with self.assertRaises(ValueError):
                ledger.settle(identity, valid | {"usage": {"input_tokens": 1, "output_tokens": 10}})
            with self.assertRaises(ValueError):
                ledger.reserve("run", REQUEST, long_context=True)
            with self.assertRaises(ValueError):
                ledger.reserve("run", REQUEST | {"model": "unfrozen"})


if __name__ == "__main__":
    unittest.main()
