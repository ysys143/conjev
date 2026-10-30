import copy
import unittest

from main_pair import schedule
from main_pair_score import accept_pair, full_packet


class MainPairTests(unittest.TestCase):
    def test_complete_allocation_and_pilot_exclusion(self):
        rows = schedule()
        self.assertEqual(len(rows), 18)
        self.assertEqual(len({(r['question'], r['family'], r['seed']) for r in rows}), 18)
        self.assertEqual({r['seed'] for r in rows}, {11, 23, 47})
        self.assertEqual(rows, schedule())
        for row in rows:
            self.assertEqual(set(row['arms']), {'V', 'H'} if row['question'] == 'Q1' else {'S0', 'S1'})

    def test_missing_evidence_is_rejected(self):
        spec = {'order': [['H', 'V']]}
        base = {'stage_scoring_complete': True, 'stop_stage_coverage': 12, 'stop_stages_expected': 12,
                'stop_graded': 12, 'stop_expected': 12, 'restatement_graded': 7, 'restatement_expected': 7,
                'closure': {'exit_code': 0, 'evidence_complete': True}, 'contamination': 'unresolved', 'artifact_checks': {'captures_reconciled': True}}
        rows = [{**copy.deepcopy(base), 'arm': arm} for arm in ['H', 'V']]
        self.assertTrue(accept_pair(spec, rows))
        for key, bad in [('stage_scoring_complete', False), ('stop_stage_coverage', 11),
                         ('stop_graded', 11), ('restatement_graded', 6), ('contamination', 'contaminated')]:
            mutant = copy.deepcopy(rows)
            mutant[0][key] = bad
            self.assertFalse(accept_pair(spec, mutant), key)
        self.assertFalse(accept_pair(spec, rows[:1]))
        mutant = copy.deepcopy(rows)
        mutant[0]['closure']['evidence_complete'] = False
        self.assertFalse(accept_pair(spec, mutant))

    def test_full_instructions_only_for_restatement(self):
        packet = {'task': 'Score one proposition in the final goal restatement', 'evidence': []}
        self.assertEqual(full_packet(packet, ['one', 'two'])['evidence'][0]['text'], 'one\n\ntwo')
        stop = {'task': 'Classify the actual stop candidate', 'evidence': []}
        self.assertEqual(full_packet(stop, ['future instruction']), stop)


if __name__ == '__main__':
    unittest.main()
