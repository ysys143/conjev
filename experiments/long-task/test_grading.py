"""Negative probes for false completion, false grading, and stale reuse. No LLM calls."""
from __future__ import annotations

import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import grading as g


class GradingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "answer.md").write_text("Keep the original API. No new dependencies.\n")
        self.receipt = {
            "version": 1, "run_id": "H-family-1", "status": "complete",
            "runner_observed_end": True, "evidence_complete": True,
            "identity": {"executor": "frozen-model", "plugin": "sha1", "seed": 1},
            "artifacts": {"answer.md": g.file_digest(self.root / "answer.md")},
        }
        self.save_receipt()
        self.rubric = {"task": "Preserve compatibility without adding dependencies.", "criteria": [{
            "id": "C1", "title": "Compatibility restatement", "definition": "The original API constraint is restated without contradiction.",
            "classes": ["present", "absent", "contradicted"], "evidence": [{"id": "answer", "path": "answer.md"}],
            "class_verdicts": {"present": "pass", "absent": "fail", "contradicted": "fail"},
        }]}
        self.packet = g.make_packets(self.root, self.rubric)[0]
        self.valid = {"criterion_id": "C1", "verdict": "pass", "reasoning": "The answer explicitly preserves the API.",
                      "classification": "present", "evidence": [{"id": "answer", "quote": "Keep the original API."}]}

    def save_receipt(self):
        (self.root / "completion.json").write_text(json.dumps(self.receipt))

    def test_existing_output_without_observed_completion_is_rejected(self):
        self.receipt["runner_observed_end"] = False
        self.save_receipt()
        with self.assertRaisesRegex(ValueError, "did not observe"):
            g.make_packets(self.root, self.rubric)

    def test_missing_or_partial_completion_cannot_become_score(self):
        for status in ("running", "failed", None):
            with self.subTest(status=status):
                self.receipt["status"] = status
                self.save_receipt()
                with self.assertRaises(ValueError):
                    g.make_packets(self.root, self.rubric)
        self.receipt["status"] = "complete"
        self.receipt["evidence_complete"] = False
        self.save_receipt()
        with self.assertRaisesRegex(ValueError, "Incomplete evidence"):
            g.make_packets(self.root, self.rubric)

    def test_altered_and_deleted_evidence_are_rejected_before_judging(self):
        (self.root / "answer.md").write_text("Changed after the run")
        with self.assertRaisesRegex(ValueError, "fingerprint changed"):
            g.make_packets(self.root, self.rubric)
        (self.root / "answer.md").unlink()
        with self.assertRaisesRegex(ValueError, "Missing evidence"):
            g.make_packets(self.root, self.rubric)

    def test_even_unused_artifact_corruption_is_detected(self):
        self.receipt["artifacts"]["missing.log"] = "not-a-hash"
        self.save_receipt()
        with self.assertRaisesRegex(ValueError, "Missing evidence"):
            g.make_packets(self.root, self.rubric)

    def test_path_escape_symlink_and_unfingerprinted_evidence_are_rejected(self):
        for name in ("../answer.md", str(self.root / "answer.md"), "unrecorded.md"):
            with self.subTest(name=name):
                rubric = copy.deepcopy(self.rubric)
                rubric["criteria"][0]["evidence"][0]["path"] = name
                with self.assertRaises(ValueError):
                    g.make_packets(self.root, rubric)
        (self.root / "link.md").symlink_to(self.root / "answer.md")
        self.receipt["artifacts"]["link.md"] = self.receipt["artifacts"]["answer.md"]
        self.save_receipt()
        with self.assertRaisesRegex(ValueError, "symlink"):
            g.make_packets(self.root, self.rubric)

    def test_requested_range_is_exact_and_cannot_silently_truncate(self):
        self.rubric["criteria"][0]["evidence"][0].update(first_line=1, last_line=2)
        with self.assertRaisesRegex(ValueError, "line range"):
            g.make_packets(self.root, self.rubric)
        self.rubric["criteria"][0]["evidence"][0]["last_line"] = 1
        packet = g.make_packets(self.root, self.rubric)[0]
        self.assertEqual(packet["evidence"][0]["text"], (self.root / "answer.md").read_text())

    def test_arm_label_and_private_paths_are_not_in_packet(self):
        serialized = json.dumps(self.packet)
        self.assertNotIn("H-family-1", serialized)
        self.assertNotIn(str(self.root), serialized)
        self.assertNotIn("answer.md", serialized)

    def test_valid_evidence_bound_classification_is_accepted(self):
        self.assertEqual(g.parse_verdict(json.dumps(self.valid), self.packet), self.valid)

    def test_corrupt_judgments_do_not_pass(self):
        mutations = [
            {"criterion_id": "C2"}, {"verdict": "PASS"}, {"reasoning": ""},
            {"evidence": []}, {"evidence": [{"id": "invented", "quote": "Keep"}]},
            {"evidence": [{"id": "answer", "quote": "Keep a new API."}]},
            {"classification": "maybe"},
            {"classification": "contradicted"},
        ]
        for change in mutations:
            with self.subTest(change=change), self.assertRaises(ValueError):
                g.parse_verdict(json.dumps(self.valid | change), self.packet)

    def test_cli_error_and_partial_result_cannot_become_judge_success(self):
        for value in ({}, {"subtype": "success", "is_error": True, "result": "pass"},
                      {"subtype": "error_max_turns", "result": "pass"},
                      {"subtype": "success", "result": ""}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                g.result_text(json.dumps(value))
        self.assertEqual(g.result_text(json.dumps([{"type": "result", "subtype": "success", "result": "ok"}])), "ok")

    def test_missing_and_failed_judges_are_not_zero_or_all_pass(self):
        row = {"criterion_id": "C1", "graded": True, "judgment": self.valid}
        result = g.aggregate(["C1", "C2"], [row])
        self.assertIsNone(result["partial"])
        self.assertIsNone(result["all_pass"])
        self.assertEqual(result["available_partial"], 1)
        self.assertEqual(result["missing"], ["C2"])
        self.assertEqual(result["ungraded"], 1)
        result = g.aggregate(["C1"], [{"criterion_id": "C1", "graded": False, "error": "timeout"}])
        self.assertIsNone(result["available_partial"])
        self.assertEqual(result["graded"], 0)

    def test_partial_and_all_pass_require_every_expected_criterion(self):
        rows = [{"criterion_id": "C1", "graded": True, "judgment": self.valid},
                {"criterion_id": "C2", "graded": True, "judgment": self.valid | {"criterion_id": "C2", "verdict": "fail"}}]
        result = g.aggregate(["C1", "C2"], rows)
        self.assertEqual(result["partial"], 0.5)
        self.assertFalse(result["all_pass"])
        self.assertTrue(result["complete"])
        for bad in (rows + [rows[0]], rows + [{"criterion_id": "extra"}]):
            with self.assertRaises(ValueError):
                g.aggregate(["C1", "C2"], bad)

    def test_unscorable_is_not_a_task_failure(self):
        packet = copy.deepcopy(self.packet)
        packet["criterion"]["classes"].append("ambiguous")
        packet["criterion"]["class_verdicts"]["ambiguous"] = "unscorable"
        parsed = g.parse_verdict(json.dumps(self.valid | {"verdict": "unscorable", "classification": "ambiguous"}), packet)
        result = g.aggregate(["C1"], [{"criterion_id": "C1", "graded": False, "judgment": parsed}])
        self.assertFalse(result["complete"])
        self.assertIsNone(result["partial"])

    def test_identity_binds_run_model_prompt_rubric_and_evidence(self):
        judge = {"model": "fixed", "cli_version": "v1"}
        key = g.judge_key(self.packet, judge)
        self.assertNotEqual(key, g.judge_key(self.packet, judge | {"model": "other"}))
        self.assertNotEqual(key, g.judge_key(self.packet, judge | {"cli_version": "v2"}))
        with patch.object(g, "JUDGE_INSTRUCTIONS", "Changed definition"):
            self.assertNotEqual(key, g.judge_key(self.packet, judge))
        self.receipt["identity"]["plugin"] = "sha2"
        self.save_receipt()
        self.assertNotEqual(key, g.judge_key(g.make_packets(self.root, self.rubric)[0], judge))
        self.rubric["criteria"][0]["definition"] += " With a new requirement."
        self.assertNotEqual(key, g.judge_key(g.make_packets(self.root, self.rubric)[0], judge))

    def test_subscription_route_strips_paid_api_and_provider_overrides(self):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-only", "OPENAI_API_KEY": "test-only",
                                    "ANTHROPIC_BASE_URL": "https://wrong.invalid", "CLAUDE_CODE_USE_VERTEX": "1",
                                    "CLAUDE_CODE_OAUTH_TOKEN": "test-only", "HTTPS_PROXY": "http://wrong.invalid",
                                    "HOME": "/actual-home"}, clear=True):
            env = g.subscription_env(Path("/research"))
        self.assertEqual(env, {"HOME": "/actual-home", "CLAUDE_CONFIG_DIR": "/research"})

    def test_failed_lookup_preserves_completed_login_metadata(self):
        (self.root / ".claude.json").write_text(json.dumps({"oauthAccount": {"fixture": True}, "hasCompletedOnboarding": True}))
        status = {"loggedIn": False, "authMethod": "none", "apiProvider": "firstParty"}
        with patch.object(g.subprocess, "run", return_value=Mock(returncode=1, stdout=json.dumps(status))):
            with self.assertRaises(g.SubscriptionAccessError) as caught:
                g.check_subscription(self.root / "fake-claude", self.root)
        self.assertTrue(caught.exception.evidence["account_metadata_present"])
        self.assertTrue(caught.exception.evidence["onboarding_complete"])
        self.assertIn("do not infer", str(caught.exception))

    def test_account_metadata_alone_never_authorizes_a_model_call(self):
        (self.root / ".claude.json").write_text(json.dumps({"oauthAccount": {"fixture": True}, "hasCompletedOnboarding": True}))
        status = {"loggedIn": True, "authMethod": "api_key", "apiProvider": "firstParty"}
        with patch.object(g.subprocess, "run", return_value=Mock(returncode=0, stdout=json.dumps(status))), \
             patch.object(g.subprocess, "check_output") as version:
            with self.assertRaises(g.SubscriptionAccessError):
                g.check_subscription(self.root / "fake-claude", self.root)
            version.assert_not_called()

    def test_nonzero_cli_exit_never_creates_accepted_result(self):
        binary = self.root / "fake-claude"
        binary.write_text("fixture")
        def spawn(*args, **kwargs):
            kwargs["stdout"].write(json.dumps({"subtype": "success", "result": json.dumps(self.valid)}))
            return Mock(returncode=1)
        with patch.object(g.subprocess, "Popen", side_effect=spawn):
            result = g.judge_one(self.packet, binary=binary, config=self.root, model="fixed",
                                 audit=self.root / "audit", version="fixture")
        self.assertFalse(result["graded"])
        self.assertEqual(len(list((self.root / "audit").rglob("accepted.json"))), 0)
        self.assertEqual(len(list((self.root / "audit").rglob("error.json"))), 1)

    def test_success_payload_under_a_different_or_unknown_model_remains_ungraded(self):
        binary = self.root / "fake-claude"
        binary.write_text("fixture")
        for models in (None, {"different": {}}, {"fixed": {}, "fallback": {}}):
            with self.subTest(models=models):
                def spawn(*args, **kwargs):
                    kwargs["stdout"].write(json.dumps({"subtype": "success", "result": json.dumps(self.valid), "modelUsage": models}))
                    return Mock(returncode=0)
                with patch.object(g.subprocess, "Popen", side_effect=spawn):
                    result = g.judge_one(self.packet, binary=binary, config=self.root, model="fixed",
                                         audit=self.root / "audit", version="fixture")
                self.assertFalse(result["graded"])
                self.assertEqual(len(list((self.root / "audit").rglob("accepted.json"))), 0)


if __name__ == "__main__":
    unittest.main()
