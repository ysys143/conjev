from __future__ import annotations

import copy
import unittest

from usage_map import account


class UsageMapTests(unittest.TestCase):
    def row(self, identity, point, **extra):
        return {"id": identity, "point": point, "sessionId": "fixture-session", "ts": "2026-10-26T00:00:00.000Z", "joinKey": "prompt-1", **extra}

    def test_fragment_copies_and_single_usage_batch_rows_count_one_call(self):
        usage = {"input_tokens": 100, "output_tokens": 5}
        for point in ["instructions", "fold", "instr-defer"]:
            with self.subTest(point=point):
                rows = [self.row("a", point, usage=usage, jev=0.5), self.row("b", point, jev=0.7)]
                if point == "instructions":
                    rows[1]["usage"] = usage
                result = account(rows, expected_calls=1)
                self.assertEqual(result["calls"], 1)
                self.assertEqual(result["by_point"][point]["input_tokens"], 100)

    def test_scope_and_cover_sent_records_are_calls_but_chunk_readings_are_not(self):
        usage = {"input_tokens": 100, "output_tokens": 5}
        rows = [self.row("s", "instr-filter", usage=usage, decision="sent", facts={"batch": "scope-1"}),
                self.row("c", "instr-filter", usage=usage, decision="sent", facts={"batch": "cover-1"}),
                self.row("chunk", "instr-filter", jev=0.8, decision="would-defer"), self.row("tool", "instr-tool")]
        result = account(rows, expected_calls=2)
        self.assertEqual(result["by_point"]["instr-filter"]["input_tokens"], 200)
        self.assertEqual(result["by_point"]["instr-tool"]["calls"], 0)

    def test_missing_usage_is_unknown_and_deleted_calls_fail_the_independent_census(self):
        rows = [self.row("a", "stop", error="timeout")]
        result = account(rows, expected_calls=1)
        self.assertEqual(result["unknown_usage_calls"], 1)
        self.assertGreater(result["by_point"]["stop"]["unknown_reserved_usd"], 0)
        with self.assertRaisesRegex(ValueError, "census mismatch"):
            account([], expected_calls=1)
        with self.assertRaises(ValueError):
            account(rows + rows, expected_calls=1)

    def test_floor_skips_and_local_caps_do_not_make_paid_calls(self):
        rows = [self.row("floor", "tool", facts={"kind": "restricted"}),
                self.row("question", "stop", skipped="question"), self.row("cap", "stop", error="cap"),
                self.row("key", "instructions", error="no-key"), self.row("keyword", "instructions", sent={"request": "fixture"})]
        self.assertEqual(account(rows, expected_calls=0)["calls"], 0)
        malformed = copy.deepcopy(rows)
        malformed[0]["usage"] = {"input_tokens": 1, "output_tokens": 0}
        with self.assertRaises(ValueError):
            account(malformed, expected_calls=0)

    def test_conflicting_fragment_usage_and_unknown_device_are_rejected(self):
        rows = [self.row("a", "instructions", usage={"input_tokens": 100, "output_tokens": 5}),
                self.row("b", "instructions", usage={"input_tokens": 101, "output_tokens": 5})]
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            account(rows, expected_calls=1)
        with self.assertRaisesRegex(ValueError, "Unknown"):
            account([self.row("future", "unknown-point")], expected_calls=0)


if __name__ == "__main__":
    unittest.main()
