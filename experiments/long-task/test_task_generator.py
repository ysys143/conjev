from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from task_generator import CHANNELS, FAMILIES, make_case


class GeneratorTests(unittest.TestCase):
    def test_three_families_have_twelve_stages_and_decisions_only_at_assigned_stages(self):
        self.assertEqual(len(FAMILIES), 3)
        for family in FAMILIES:
            case = make_case(family, 11)
            self.assertEqual(len(case.prompts), 12)
            self.assertEqual(len(case.contracts), 12)
            for requirement in ("C1:", "C2:", "C3:"):
                self.assertEqual(sum(p.count(requirement) for p in case.prompts), 1)
                self.assertIn(requirement, case.prompts[0])
            self.assertIn("D1:", case.prompts[3])
            self.assertIn("D2:", case.prompts[5])
            self.assertEqual(sum(p.count("D1:") for p in case.prompts), 1)
            self.assertEqual(sum(p.count("D2:") for p in case.prompts), 1)
            self.assertEqual([e["boundary"] for e in case.exposure], [3, 6, 9])
            self.assertEqual(case.identity, make_case(family, 11).identity)
            self.assertNotEqual(case.identity, make_case(family, 23).identity)

    def test_arm_inputs_are_identical_except_the_declared_harness_seed_files(self):
        case = make_case("ledger", 11)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for arm in ("V", "H", "S0", "S1"):
                case.materialize(root / arm, arm)
            for name in case.files:
                contents = [(root / arm / name).read_bytes() for arm in ("V", "H", "S0", "S1")]
                self.assertEqual(len(set(contents)), 1)
            self.assertFalse((root / "V/INTENT.md").exists())
            self.assertEqual((root / "H/INTENT.md").read_text(), case.prompts[0] + "\n")
            self.assertEqual({p.relative_to(root / "S0").as_posix(): p.read_bytes() for p in (root / "S0").rglob("*") if p.is_file()},
                             {p.relative_to(root / "S1").as_posix(): p.read_bytes() for p in (root / "S1").rglob("*") if p.is_file()})
            self.assertEqual(sorted(p.relative_to(root / "V").as_posix() for p in (root / "V").rglob("*") if p.is_file()), sorted(case.files))
            self.assertFalse(any("oracle" in p.name or "rubric" in p.name or "reference-solution" in p.name for p in (root / "V").rglob("*")))

    def test_actual_emitter_outputs_supply_two_large_results_at_all_three_boundaries(self):
        for family in FAMILIES:
            case = make_case(family, 11)
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary) / "task"
                case.materialize(root, "V")
                outputs = {c: subprocess.check_output(["python3", "emit.py", c], cwd=root, text=True) for c in CHANNELS}
                for exposure in case.exposure:
                    pair = exposure["channels"]
                    self.assertTrue(all(len(outputs[c]) >= 1000 for c in pair))
                    self.assertGreaterEqual(sum(len(outputs[c]) for c in pair), 4000)
                    for c, marker in zip(pair, exposure["markers"]):
                        self.assertIn("marker=" + marker + " ", outputs[c])
                    self.assertTrue(all(stage > exposure["boundary"] for stage in exposure["needed_after_boundary"]))
                    self.assertFalse(exposure["live_exposure_verified"])


if __name__ == "__main__":
    unittest.main()
