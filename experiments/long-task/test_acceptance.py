from __future__ import annotations

import copy
import unittest

from acceptance import request_evidence, stops_reconciled


class AcceptanceTests(unittest.TestCase):
    def test_conditional_skip_requires_the_actual_conditional_ending_and_no_judgment(self):
        candidates = [{"event": {"prompt_id": "conditional", "last_assistant_message": "If you want that, I can add the completion note."}}]
        records = [{"joinKey": "conditional", "mode": "shadow", "skipped": "conditional", "sent": None}]
        self.assertTrue(stops_reconciled(candidates, records))
        self.assertFalse(stops_reconciled(candidates, [records[0] | {"jev": 0.01}]))
        self.assertFalse(stops_reconciled(candidates, []))
        for ending in ["Done.", "If you want that, I can add it. The requested work is complete.", "Done.\n\n```\nIf you want, I can add it.\n```"]:
            self.assertFalse(stops_reconciled([{"event": {"prompt_id": "conditional", "last_assistant_message": ending}}], records))

    def test_actual_pointer_and_user_notes_are_required_not_tool_schema_examples(self):
        body = {"tools": [{"description": "Read a pointer such as [folded Read example]."}],
                "messages": [{"role": "assistant", "content": [{"type": "text", "text": "[context-harness] This conversation was just compacted (a quotation)."}]}]}
        self.assertEqual(request_evidence(body), {"folded_pointers_delivered": False, "consolidation_note_delivered": False,
                                                 "post_compaction_note_delivered": False})
        body["messages"] += [{"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "x", "content": [{"type": "text", "text": "[folded Read · fixture · 100 lines]"}]},
            {"type": "text", "text": "[context-harness] Before this conversation is folded, consolidate."},
            {"type": "text", "text": "[context-harness] This conversation was just compacted; 1 result was folded."},
        ]}]
        self.assertTrue(all(request_evidence(body).values()))
        corrupted = copy.deepcopy(body)
        corrupted["messages"][-1]["content"] = corrupted["messages"][-1]["content"][1:]
        self.assertFalse(request_evidence(corrupted)["folded_pointers_delivered"])

    def test_a_question_is_a_legitimate_skip_but_a_missing_or_failed_stop_is_not(self):
        candidates = [{"event": {"prompt_id": "report", "last_assistant_message": "Done."}},
                      {"event": {"prompt_id": "question", "last_assistant_message": "Should I apply that correction?"}}]
        records = [{"joinKey": "report", "mode": "shadow", "jev": 0.01},
                   {"joinKey": "question", "mode": "shadow", "skipped": "question"}]
        self.assertTrue(stops_reconciled(candidates, records))
        self.assertFalse(stops_reconciled(candidates, records[:1]))
        self.assertFalse(stops_reconciled(candidates, [records[0] | {"error": "timeout"}, records[1]]))
        self.assertFalse(stops_reconciled(candidates, [records[0] | {"skipped": "question"}, records[1]]))


if __name__ == "__main__":
    unittest.main()
