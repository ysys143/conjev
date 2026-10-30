import copy
import unittest

from device_filter_probe import case_checks, instruction_envelopes


class InstructionEnvelopeTests(unittest.TestCase):
    def test_pinned_cli_user_reminder_is_part_of_wire_instructions(self):
        path = "/private/tmp/fixture/source.md"
        reminder = f"<system-reminder>\nContents of {path}:\nUNIQUE-CONTROL\n</system-reminder>"
        body = {"system": [{"type": "text", "text": "base prompt"}],
                "messages": [{"role": "user", "content": [{"type": "text", "text": reminder}]}]}
        self.assertEqual(instruction_envelopes(body, path), [reminder])
        self.assertEqual(instruction_envelopes(body, path + ".missing"), [])

    def test_retained_history_cannot_supply_current_instruction(self):
        body = {"messages": [
            {"role": "user", "content": [{"type": "text", "text": "Contents of /old.md: UNIQUE-CONTROL"}]},
            {"role": "user", "content": [{"type": "text", "text": "Contents of /current.md: LOST"}]},
        ]}
        self.assertEqual(instruction_envelopes(body, "/current.md"), ["Contents of /current.md: LOST"])
        self.assertNotIn("UNIQUE-CONTROL", "".join(instruction_envelopes(body, "/current.md")))

    def test_system_blocks_are_also_supported(self):
        body = {"system": [{"type": "text", "text": "Contents of /fixture.md: marker"}], "messages": []}
        self.assertEqual(instruction_envelopes(body, "/fixture.md"), ["Contents of /fixture.md: marker"])


class FilterEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.files = [{"path": "/fixture.md", "kind": "project", "content": "## Control\nUNIQUE-CONTROL"}]
        self.rows = [{"point": "instr-filter", "mode": "active", "decision": "would-keep", "sent": None, "facts": {"jev": "no-key"}}]

    def check(self, files=None, rows=None, systems=None):
        return case_checks("unique-preserved", [self.files], [self.files if files is None else files],
                           self.rows if rows is None else rows, ["UNIQUE-CONTROL"] if systems is None else systems,
                           self.files, "UNIQUE-CONTROL")

    def test_original_passes_and_record_loss_fails(self):
        self.assertTrue(all(self.check().values()))
        self.assertFalse(all(self.check(rows=[]).values()))
        self.assertFalse(all(self.check(rows=self.rows * 2).values()))

    def test_lost_text_and_lost_wire_envelope_fail(self):
        broken = copy.deepcopy(self.files)
        broken[0]["content"] = "## Control\nLOST"
        self.assertFalse(all(self.check(files=broken).values()))
        self.assertFalse(all(self.check(systems=[""]).values()))
        self.assertFalse(all(self.check(systems=[]).values()))


if __name__ == "__main__":
    unittest.main()
