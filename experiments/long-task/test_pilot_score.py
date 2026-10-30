import json
import tempfile
import unittest
from pathlib import Path

from pilot_score import summarize


class PilotHandbackTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        result = {"arm": "S1", "stage_count": 12, "completed_stages": 12, "goal_failures": 0,
                  "final_task": {"all_pass": True}, "usage": {}, "wall_seconds": 0,
                  "exposure": [{"met": True}], "contamination": "clean", "closure": {}}
        (self.root / "run-result.json").write_text(json.dumps(result))
        (self.root / "stage-scores.json").write_text(json.dumps({"stages": [{"complete": True}] * 12}))

    def candidate(self, stage, classification="completed", *, blocked=False, continuation_of=None):
        return {"candidate": "end-" + str(stage), "stage": stage, "classification": classification,
                "graded": True, "blocked": blocked, "continuation_of": continuation_of,
                "oracle": {"criteria": [{"id": "due", "verdict": "pass"}], "all_pass": True}}

    def test_intercepted_announcement_is_an_opportunity_not_a_stage_handback(self):
        initial = self.candidate(1, "premature_announcement", blocked=True)
        initial["candidate"] = "intercepted"
        initial["oracle"] = {"criteria": [{"id": "due", "verdict": "fail"}], "all_pass": False}
        final = self.candidate(1, continuation_of="intercepted")
        rows = [initial, final] + [self.candidate(s) for s in range(2, 13)]
        result = summarize(self.root, rows, [])
        self.assertEqual(result["premature_handback_stages"], 0)
        self.assertEqual(result["premature_announcement_stages"], 0)
        self.assertEqual(result["premature_candidates"], 1)
        self.assertTrue(result["corrections"][0]["objective_progress"])

    def test_a_final_early_return_still_counts(self):
        rows = [self.candidate(1, "other_premature_handback")] + [self.candidate(s) for s in range(2, 13)]
        result = summarize(self.root, rows, [])
        self.assertEqual(result["premature_handback_stages"], 1)
        self.assertEqual(result["other_premature_handback_stages"], 1)

    def test_a_missing_stage_end_cannot_be_reported_as_zero_early_returns(self):
        result = summarize(self.root, [self.candidate(s) for s in range(1, 12)], [])
        self.assertIsNone(result["premature_handback_stages"])
        self.assertEqual(result["stop_stage_coverage"], 11)
