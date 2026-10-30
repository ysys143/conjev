"""Separate a proven new temporary output from foreign-input contamination.

This grants no directory-wide read permission. Existing files, explicit
foreign reads and every evaluator/run namespace keep their original verdict.
"""
import hashlib
import json
import re
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parents[2]
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
from contamination import Scope, audit, captured_calls
from grading import digest, file_digest, load, write_new


def text_of(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return '\n'.join(text_of(v) for v in value)
    if isinstance(value, dict):
        return text_of(value.get('text', value.get('content', '')))
    return ''


def created_scratch(call, outcomes, scope, temporary_roots, forbidden_roots):
    if call.get('name') != 'Write' or not outcomes or any(r.get('is_error') for r in outcomes):
        return None
    data = call.get('input', {})
    original = data.get('file_path')
    content = data.get('content')
    if not isinstance(original, str) or not isinstance(content, str):
        return None
    path = scope.resolve(original)
    if not any(path.is_relative_to(p.resolve()) for p in temporary_roots):
        return None
    if any(path.is_relative_to(p.resolve()) for p in forbidden_roots) or any(part.startswith('ch-research-') for part in path.parts):
        return None
    expected = 'File created successfully at: ' + original
    if not all(text_of(result.get('content', '')).startswith(expected) for result in outcomes):
        return None
    if not path.is_file() or path.is_symlink() or any(p.is_symlink() for p in path.parents):
        return None
    body = content.encode('utf-8')
    if path.read_bytes() != body:
        return None
    return {'path': str(path), 'tool_call_sha256': digest(call), 'creation_outcome_sha256': digest(outcomes),
            'created_content_sha256': hashlib.sha256(body).hexdigest(), 'current_file_sha256': file_digest(path),
            'classification': 'new-run-created-scratch-output',
            'scope': 'This successful Write created the exact supplied program; it is not a read of pre-existing foreign information. Opaque subsequent code execution remains unresolved.'}


def audit_with_creation(calls, results, scope, temporary_roots, forbidden_roots):
    original = audit(calls, results, scope)
    by_id = {call['id']: call for call in calls}
    rows, witnesses = [], []
    for row in original['rows']:
        revised = dict(row)
        if row['classification'] == 'contaminated':
            witness = created_scratch(by_id[row['call_id']], results.get(row['call_id'], []), scope,
                                      temporary_roots, forbidden_roots)
            if witness is not None:
                revised.update({'classification': 'created_scratch_output', 'original_classification': row['classification'],
                                'creation_witness': witness})
                witnesses.append(witness)
        rows.append(revised)
    classification = ('contaminated' if any(r['classification'] == 'contaminated' for r in rows) else
                      'unresolved' if any(r['classification'] in ['unresolved', 'created_scratch_output'] for r in rows) else 'clean')
    return {'revision': 2, 'classification': classification, 'original_classification': original['classification'],
            'rows': rows, 'calls': len(rows), 'created_scratch_outputs': witnesses,
            'claim_scope': original['claim_scope'], 'no_os_syscall_trace': True}


def main():
    execution = Path('/private/tmp/ch-research-pilot-20261027-2')
    root = Path('/private/tmp/ch-research-pilot-scoring-20261027-1')
    temporary_roots = [Path('/private/tmp'), Path(tempfile.gettempdir())]
    forbidden = [execution, REPO, Path('/Users/jaesolshin/.claude-reserach')]
    source = {str(Path(__file__)): file_digest(Path(__file__)), str(HERE / 'contamination.py'): file_digest(HERE / 'contamination.py')}
    write_new(root / 'environment-source-before.json', source)
    summaries = []
    scores = load(root / 'pilot-scores-full-evidence.json')
    for arm in ['V', 'H', 'S1', 'S0']:
        original = execution / arm
        session = load(original / 'evidence/launch.json')['session_id']
        project = Path('/Users/jaesolshin/.claude-reserach/projects') / re.sub(r'[^a-zA-Z0-9_-]', '-', str((original / 'task').resolve()))
        scope = Scope(original / 'task', project / (session + '.jsonl'), tuple((REPO / 'skills').glob('*/SKILL.md')))
        calls, results = captured_calls(original / 'evidence', workspace=original / 'task')
        result = audit_with_creation(calls, results, scope, temporary_roots, forbidden)
        for witness in result['created_scratch_outputs']:
            target = root / arm / 'scratch-output-witnesses' / (witness['created_content_sha256'] + '.py')
            target.parent.mkdir(exist_ok=True)
            with target.open('xb') as out:
                out.write(Path(witness['path']).read_bytes())
            witness['retained_witness'] = str(target)
        result['original_audit_sha256'] = file_digest(original / 'contamination.json')
        result['original_actions_sha256'] = digest(calls)
        write_new(root / arm / 'contamination-audit-v2.json', result)
        prior = next(row for row in scores['runs'] if row['arm'] == arm)
        summaries.append({**prior, 'contamination': result['classification'], 'environment_audit_revision': 2})
    write_new(root / 'pilot-scores-audited.json', {**scores, 'runs': summaries, 'environment_audit_revision': 2})
    write_new(root / 'environment-audit-manifest.json', {'revision': 2, 'source_before': 'environment-source-before.json',
              'audit_file': 'contamination-audit-v2.json', 'pilot_scores': 'pilot-scores-audited.json',
              'temporary_roots': [str(p) for p in temporary_roots], 'forbidden_roots': [str(p) for p in forbidden],
              'criterion': 'Detect access to evaluator data, another run/session or pre-existing author data. A proven newly created scratch output does not introduce pre-existing foreign information.'})
    if any(file_digest(Path(p)) != expected for p, expected in source.items()):
        raise ValueError('Environment audit source changed')
    print(json.dumps({'states': {row['arm']: row['contamination'] for row in summaries}}))


if __name__ == '__main__':
    main()
