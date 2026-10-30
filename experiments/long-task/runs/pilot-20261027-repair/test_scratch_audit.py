import tempfile
import unittest
from pathlib import Path

from scratch_audit import audit_with_creation
from contamination import Scope


class CreatedScratchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.task = self.root / 'task'; self.task.mkdir()
        self.scratch = self.root / 'scratch'; self.scratch.mkdir()
        self.protected = self.root / 'evaluator'; self.protected.mkdir()
        self.scope = Scope(self.task, self.root / 'own-session.jsonl')

    def audited(self, *, name='Write', directory=None, created=True, matches=True, failed=False):
        directory = directory or self.scratch
        path = directory / 'trace.py'; path.write_text('own code\n' if matches else 'different\n')
        call = {'id':'a','name':name,'input':{'file_path':str(path),'content':'own code\n'}}
        text = ('File created successfully at: ' if created else 'The file has been updated: ') + str(path)
        result = audit_with_creation([call], {'a':[{'content':text,'is_error':failed}]}, self.scope, [self.scratch, self.protected], [self.protected])
        return result

    def test_proven_new_scratch_is_an_output_not_foreign_input(self):
        result = self.audited()
        self.assertEqual(result['classification'], 'unresolved')
        self.assertEqual(len(result['created_scratch_outputs']), 1)

    def test_updating_a_preexisting_external_file_stays_contaminated(self):
        self.assertEqual(self.audited(created=False)['classification'], 'contaminated')

    def test_reading_foreign_data_stays_contaminated(self):
        self.assertEqual(self.audited(name='Read')['classification'], 'contaminated')

    def test_new_evaluator_file_is_not_exempt(self):
        self.assertEqual(self.audited(directory=self.protected)['classification'], 'contaminated')

    def test_mismatched_content_is_not_exempt(self):
        self.assertEqual(self.audited(matches=False)['classification'], 'contaminated')

    def test_outside_temporary_output_scope_is_not_exempt(self):
        directory = self.root / 'author'; directory.mkdir()
        self.assertEqual(self.audited(directory=directory)['classification'], 'contaminated')

    def test_a_failed_write_does_not_create_an_ownership_claim(self):
        result = self.audited(failed=True)
        self.assertEqual(result['created_scratch_outputs'], [])


if __name__ == '__main__':
    unittest.main()
