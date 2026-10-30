import tempfile
import unittest
from pathlib import Path

from verification_v2 import observed_verification, score
from observation import snapshot


GREEN = 'Ran 1 test in 0.001s\n\nOK\n'
RED = 'Ran 1 test in 0.001s\n\nFAILED (failures=1)\n'


def call(command, output=GREEN):
    return {'name': 'Bash', 'input': {'command': command}, 'succeeded': True, 'output': output}


class VerificationV2Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.task = self.root / 'task'
        self.task.mkdir()
        (self.task / 'app.py').write_text('def answer(): return 1\n')
        (self.task / 'test_app.py').write_text('import unittest\nfrom app import answer\nclass Checks(unittest.TestCase):\n    def test_answer(self): self.assertEqual(answer(),1)\n')
        self.contract = {'version': 1, 'criteria': [{'id': 'V', 'kind': 'verification'}]}

    def scored(self, calls):
        target = self.root / 'snapshot'
        snapshot(self.task, target)
        return score(target, self.contract, stage=1, workspace=self.task, tool_calls=calls)

    def test_real_green_followed_by_an_isolated_red_is_a_pass(self):
        rows = [call('python3 -m unittest -v'), call('scratch=$(mktemp -d) && (cd "$scratch" && python3 -m unittest); rm -rf "$scratch"', RED)]
        result = self.scored(rows)
        self.assertTrue(result['all_pass'])
        self.assertTrue(result['verification_audit']['observed']['runs'][1]['ignored_isolated_control'])
        self.assertEqual(result['verification_audit']['snapshot_tests']['ran'], 1)

    def test_a_real_workspace_failure_after_green_is_not_ignored(self):
        self.assertFalse(self.scored([call('python3 -m unittest -v'), call('python3 -m unittest -v', RED)])['all_pass'])

    def test_an_isolated_green_without_actual_workspace_execution_is_not_a_pass(self):
        self.assertFalse(self.scored([call('scratch=$(mktemp -d) && (cd "$scratch" && python3 -m unittest)')])['all_pass'])

    def test_a_reassigned_temporary_name_cannot_hide_a_failure(self):
        result = self.scored([call('python3 -m unittest -v'), call('scratch=$(mktemp -d); scratch="$PWD"; (cd "$scratch" && python3 -m unittest)', RED)])
        self.assertIsNone(result['all_pass'])

    def test_a_broken_final_snapshot_cannot_borrow_an_earlier_green(self):
        (self.task / 'app.py').write_text('def answer(): return 2\n')
        self.assertFalse(self.scored([call('python3 -m unittest -v')])['all_pass'])

    def test_zero_tests_are_rejected(self):
        self.assertFalse(self.scored([call('python3 -m unittest -v', 'Ran 0 tests in 0.000s\nOK\n')])['all_pass'])

    def test_an_empty_snapshot_cannot_use_a_claimed_green(self):
        empty = self.root / 'empty-task'
        empty.mkdir()
        dest = self.root / 'empty-snapshot'
        snapshot(empty, dest)
        result = score(dest, self.contract, stage=1, workspace=empty, tool_calls=[call('python3 -m unittest -v')])
        self.assertFalse(result['all_pass'])

    def test_echoing_a_test_command_and_result_is_not_execution(self):
        self.assertFalse(self.scored([call('echo "python3 -m unittest -v"')])['all_pass'])

    def test_a_shell_option_prefix_does_not_lose_the_workspace(self):
        self.assertTrue(self.scored([call('set -e\npython3 -m unittest -v')])['all_pass'])

    def test_a_heredoc_mention_is_not_a_second_test_execution(self):
        command = "python3 -m unittest -v; cat <<'EOF'\npython3 -m unittest\nEOF"
        self.assertTrue(self.scored([call(command)])['all_pass'])

    def test_mixed_workspace_green_and_isolated_red_in_one_call(self):
        command = 'python3 -m unittest -v; scratch=$(mktemp -d); (cd "$scratch" && python3 -m unittest)'
        self.assertTrue(self.scored([call(command, GREEN + RED)])['all_pass'])

    def test_missing_actions_remain_ungraded(self):
        self.assertIsNone(self.scored(None)['all_pass'])

    def test_unknown_failed_test_target_is_not_promoted_to_pass(self):
        result = self.scored([call('python3 -m unittest -v'), call('(cd "$unknown" && python3 -m unittest)', RED)])
        self.assertIsNone(result['all_pass'])


if __name__ == '__main__':
    unittest.main()
