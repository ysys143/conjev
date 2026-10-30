from __future__ import annotations

import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace

from device_contract import build_cases
from device_live import checks_for


class DeviceLiveTests(unittest.TestCase):
    def test_missing_key_does_not_expect_a_deferred_service_call(self):
        from device_live import PROBE
        case = next(c for c in build_cases() if c['id'] == 'instruction-filter-deferred.missing-key-no-record')
        files = [{'content': 'Controlled instructions'}]
        logs = [{'kind': 'command-complete', 'value': {}},
                {'kind': 'instruction-input', 'value': {'files': files}},
                {'kind': 'instruction-delivered', 'value': files},
                {'kind': 'prompt-input', 'value': {'effective': {'text': PROBE, 'origin': {'kind': 'sdk'}}}}]
        records = [{'point': 'instr-filter', 'decision': 'would-defer', 'joinKey': 'chunk-a', 'facts': {'jev': 'no-key'}}]
        self.assertTrue(all(checks_for(case, logs, records, [], [], SimpleNamespace(), []).values()))

    def test_no_deferred_chunk_does_not_allow_the_chunk_record_to_disappear(self):
        from device_live import PROBE
        case = next(c for c in build_cases() if c['id'] == 'instruction-filter-deferred.none-deferred-no-record')
        files = [{'content': 'Controlled instructions'}]
        logs = [{'kind': 'command-complete', 'value': {}},
                {'kind': 'instruction-input', 'value': {'files': files}},
                {'kind': 'instruction-delivered', 'value': files},
                {'kind': 'prompt-input', 'value': {'effective': {'text': PROBE, 'origin': {'kind': 'sdk'}}}}]
        records = [{'point': 'instr-filter', 'decision': 'would-keep'}]
        self.assertTrue(all(checks_for(case, logs, records, [], [], SimpleNamespace(), []).values()))
        self.assertFalse(all(checks_for(case, logs, [], [], [], SimpleNamespace(), []).values()))

    def test_idle_prompt_origins_and_every_deferred_record_are_reconciled(self):
        from device_live import PROBE
        case = next(c for c in build_cases() if c['id'] == 'instruction-filter-deferred.each-request')
        files = [{'content': 'Controlled instructions'}]
        logs = [{'kind': 'command-complete', 'value': {}},
                {'kind': 'instruction-input', 'value': {'files': files}},
                {'kind': 'instruction-delivered', 'value': files}]
        records = [{'point': 'instr-filter', 'decision': 'would-defer', 'joinKey': 'chunk-a'}]
        for text in [PROBE, 'First actual request', 'Second actual request']:
            logs.append({'kind': 'prompt-input', 'value': {'effective': {'text': text, 'origin': {'kind': 'sdk'}}}})
            records.append({'point': 'instr-defer', 'sent': {'request': text}, 'decision': 'skip', 'jev': 0,
                            'facts': {'origin': 'sdk', 'chunk': 'chunk-a'}})
        self.assertTrue(all(checks_for(case, logs, records, [], [], SimpleNamespace(), []).values()))
        self.assertFalse(all(checks_for(case, logs, records[:-1], [], [], SimpleNamespace(), []).values()))
        records[-1]['facts']['origin'] = 'composer'
        self.assertFalse(all(checks_for(case, logs, records, [], [], SimpleNamespace(), []).values()))

    def test_scope_cover_and_deferred_calls_are_accounted_separately(self):
        case = next(c for c in build_cases() if c['id'] == 'instruction-filter-jev.scope-and-cover-readings')
        files = [{'content': 'Controlled instructions'}]
        logs = [{'kind': 'command-complete', 'value': {}},
                {'kind': 'instruction-input', 'value': {'files': files}},
                {'kind': 'instruction-delivered', 'value': files}]
        for key in ['s2', 'c2', 'd0']:
            logs.append({'kind': 'jev-response', 'value': {'request': {'questions': {key: {}}, 'state': {'request': 'Controlled request'}}, 'response': {'usage': {'input_tokens': 1, 'output_tokens': 1}}}})
        facts = {'conditional': '-', 'covered': '-', 'reason': 'controlled', 'heading': '## Language'}
        records = [{'point': 'instr-filter', 'decision': 'would-keep', 'facts': facts} for _ in range(4)]
        records += [{'point': 'instr-filter', 'decision': 'sent'} for _ in range(2)]
        records.append({'point': 'instr-defer', 'sent': {'request': 'Controlled request'}})
        self.assertTrue(all(checks_for(case, logs, records, [], [], SimpleNamespace(), []).values()))
        self.assertFalse(all(checks_for(case, logs, records[:-1], [], [], SimpleNamespace(), []).values()))
        self.assertFalse(all(checks_for(case, logs + [logs[-1]], records, [], [], SimpleNamespace(), []).values()))

    def test_every_live_checker_rejects_empty_evidence_without_crashing(self):
        external = {'instruction-filter-deterministic', 'skills', 'status-line'}
        with tempfile.TemporaryDirectory() as td:
            observer = SimpleNamespace(store=Path(td))
            for case in build_cases():
                if case['id'].split('.')[0] in external: continue
                with self.subTest(case=case['id']):
                    self.assertFalse(all(checks_for(case, [], [], [], [], observer, []).values()))

    def test_promptless_fold_requires_a_completed_compaction(self):
        case = next(c for c in build_cases() if c['id'] == 'fold-shadow.no-person-prompt-no-call')
        logs = [{'kind': 'command-complete', 'value': {}}]
        self.assertFalse(all(checks_for(case, logs, [], [], [], SimpleNamespace(), []).values()))
        logs.append({'kind': 'compact-result', 'value': {'messages': [{'role': 'user', 'text': 'Controlled summary'}]}})
        self.assertTrue(all(checks_for(case, logs, [], [], [{'name': 'compact-after'}], SimpleNamespace(), []).values()))

    def test_no_note_requires_a_completed_compaction(self):
        case = next(c for c in build_cases() if c['id'] == 'post-compact-note.neither-no-note')
        messages = case['steps'][0]['input']['messages']
        logs = [{'kind': 'command-complete', 'value': {}},
                {'kind': 'compact-input', 'value': {'messages': messages}},
                {'kind': 'summary-input', 'value': {'messages': messages}}]
        self.assertFalse(all(checks_for(case, logs, [], [], [], SimpleNamespace(), []).values()))
        logs.append({'kind': 'compact-result', 'value': {'messages': [{'role': 'user', 'text': 'Controlled summary'}]}})
        self.assertTrue(all(checks_for(case, logs, [], [], [{'name': 'compact-after'}], SimpleNamespace(), []).values()))


if __name__ == '__main__':
    unittest.main()
