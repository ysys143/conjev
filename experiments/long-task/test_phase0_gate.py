from __future__ import annotations

import unittest

from phase0_gate import inspect_bundle, stop_cases_complete


class PhaseZeroGateTests(unittest.TestCase):
    def fixtures(self):
        cases = [{"case": name, "repetition": repetition, "stimulus_matched": True, "expected_branch": True}
                 for name in ["announce", "report", "question"] for repetition in [1, 2, 3]]
        off = {"cases": cases, "census": {"candidates": 9, "blocked": 0}, "stop_records": 0}
        active = {"cases": cases, "census": {"candidates": 12, "blocked": 3}, "observer_before_jev": True}
        records = ([{"point": "stop", "jev": 0.99}] * 3 + [{"point": "stop", "jev": 0.01}] * 3
                   + [{"point": "stop", "skipped": "question"}] * 3 + [{"point": "stop", "skipped": "stop-hook-active"}] * 3)
        return off, active, records

    def test_every_case_needs_three_distinct_repetitions_and_successful_eligible_judgments(self):
        off, active, records = self.fixtures()
        self.assertTrue(stop_cases_complete(off, active, records))
        active["cases"] = active["cases"][:-1]
        self.assertFalse(stop_cases_complete(off, active, records))
        off, active, records = self.fixtures()
        records[3] = {"point": "stop", "error": "timeout"}
        self.assertFalse(stop_cases_complete(off, active, records))

    def test_a_partial_bundle_cannot_pass_by_omitting_unfinished_gates(self):
        with self.assertRaisesRegex(ValueError, "Every phase-0 role"):
            inspect_bundle({"version": 1, "runs": {}}, None)


if __name__ == "__main__":
    unittest.main()
