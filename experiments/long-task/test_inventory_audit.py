from __future__ import annotations

import unittest

from inventory_audit import intact


class InventoryAuditTests(unittest.TestCase):
    def test_a_lost_unique_line_is_rejected_even_when_the_marker_remains(self):
        expected = {"/task/CLAUDE.md": "inventory marker\nA unique instruction that must survive.\n"}
        event = {"files": [{"path": "/task/CLAUDE.md", "kind": "project", "content": expected["/task/CLAUDE.md"]}]}
        self.assertTrue(intact([event], expected))
        event["files"][0]["content"] = "inventory marker\n"
        self.assertFalse(intact([event], expected))

    def test_missing_or_added_instruction_sources_are_not_accepted(self):
        expected = {"/task/CLAUDE.md": "expected"}
        event = {"files": [{"path": "/task/CLAUDE.md", "kind": "project", "content": "expected"}]}
        self.assertFalse(intact([], expected))
        event["files"].append({"path": "/profile/memory/MEMORY.md", "kind": "memory", "content": "foreign"})
        self.assertFalse(intact([event], expected))


if __name__ == "__main__":
    unittest.main()
