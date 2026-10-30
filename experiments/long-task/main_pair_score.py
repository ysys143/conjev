"""Score one closed main pair with the pilot-accepted corrected paths."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from grading import check_subscription, file_digest, load, write_new
from main_pair import REPAIR, REPO, verify_sources
from contamination import Scope, captured_calls
import pilot_score
from pilot_run import action_rows
from observation import validate_observations

sys.path.insert(0, str(REPAIR))
from verification_v2 import score
from scratch_audit import audit_with_creation


def full_packet(packet, instructions):
    if not packet['task'].startswith('Score one proposition'):
        return packet
    return {**packet, 'evidence': [*packet['evidence'], {'id': 'original-scripted-instructions', 'text': '\n\n'.join(instructions)}]}


def accept_pair(spec, rows):
    return (len(rows) == 2 and [r['arm'] for r in rows] == spec['order'][0]
            and all(r['stage_scoring_complete'] and r['stop_stage_coverage'] == r['stop_stages_expected']
                    and r['stop_graded'] == r['stop_expected'] and r['restatement_graded'] == r['restatement_expected'] == 7
                    and r['closure']['exit_code'] == 0 and r['closure']['evidence_complete']
                    and r['contamination'] != 'contaminated' and all(r['artifact_checks'].values()) for r in rows))


def artifact_checks(root, spec, stops):
    result = load(root / 'run-result.json')
    captures = [load(p) for p in (root / 'evidence/requests').glob('*.json')]
    starts = {p.stem for p in (root / 'evidence/requests/started').glob('*.json')}
    messages = [r for r in captures if r.get('path', '').split('?', 1)[0] == '/v1/messages']
    bodies = [json.loads(r['request_body']) for r in messages]
    census = validate_observations(root / 'observer')
    candidates = {identifier for stage in range(1, 13)
                  for identifier in load(root / 'observer/stages' / f'{stage:02}.json')['candidate_ids']}
    return {'all_twelve_stage_receipts': {int(p.stem) for p in (root / 'stages').glob('*.json')} == set(range(1, 13)),
            'task_identity': result['task_identity'] == spec['task_identity'],
            'captures_reconciled': bool(captures) and starts == {r['id'] for r in captures},
            'complete_original_messages': bool(messages) and all(r.get('complete') is True and r.get('message_stop') is True and not r.get('body_redacted') for r in messages),
            'uploads_recorded': all(r.get('request_bytes', 0) == r.get('body_bytes_sent') > 0 for r in messages),
            'wire_settings': bool(bodies) and all(b.get('model') == spec['executor_model'] and b.get('output_config', {}).get('effort') == 'max' and b.get('thinking', {}).get('type') == 'adaptive' for b in bodies),
            'stop_census': {r['candidate'] for r in stops} == candidates and len(candidates) <= census['candidates'],
            'exposure': len(result['exposure']) == 3 and all(e['met'] for e in result['exposure'])}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--config', type=Path, required=True)
    p.add_argument('--claude', type=Path, default=Path.home() / '.local/share/claude/versions/2.1.309')
    a = p.parse_args()
    spec = load(a.root / 'main-freeze.json')
    verify_sources(spec['source_sha256'])
    execution = load(a.root / 'execution-summary.json')
    if not execution['executions_complete'] or execution['main_runs'] != 2:
        raise ValueError('Both executors must finish before grading')
    version = check_subscription(a.claude, a.config)
    rows = []
    original_score, original_packet = pilot_score.score_stage, pilot_score.run_packet
    try:
        for arm in spec['order'][0]:
            root = a.root / arm
            private = load(root / 'private-definition.json')
            events = [json.loads(s) for s in (root / 'fs-events.jsonl').read_text().splitlines()]
            scores = []
            for stage, contract in enumerate(private['contracts'], 1):
                receipt = load(root / 'observer/stages' / f'{stage:02}.json')
                scores.append(score(root / 'observer/snapshots' / receipt['snapshot'], contract,
                                    workspace=root / 'task', watcher_events=events,
                                    tool_calls=action_rows(receipt['events']), stage=stage))
            write_new(root / 'stage-scores-v2.json', {'stages': scores, 'verification_revision': 2})
            pilot_score.score_stage = lambda snapshot, contract, **kw: score(snapshot, contract, workspace=root / 'task', **kw)
            pilot_score.run_packet = lambda packet, **kw: original_packet(full_packet(packet, private['prompts']), **kw)
            stops = pilot_score.classify_candidates(root, binary=a.claude, config=a.config, model=spec['judge_model'], version=version)
            restatements = pilot_score.restatement(root, binary=a.claude, config=a.config, model=spec['judge_model'], version=version)
            summary = pilot_score.summarize(root, stops, restatements)
            session = load(root / 'evidence/launch.json')['session_id']
            project = a.config / 'projects' / re.sub(r'[^a-zA-Z0-9_-]', '-', str((root / 'task').resolve()))
            scope = Scope(root / 'task', project / (session + '.jsonl'), tuple((REPO / 'skills').glob('*/SKILL.md')))
            calls, results = captured_calls(root / 'evidence', workspace=root / 'task', reconciliation=[])
            audit = audit_with_creation(calls, results, scope, [Path('/private/tmp')], [a.root, REPO, a.config])
            write_new(root / 'contamination-v2.json', audit)
            summary.update({'completed_stages': sum(s['all_pass'] is True for s in scores),
                            'stage_scoring_complete': all(s['complete'] for s in scores),
                            'goal_failures': sum(s['goal_keeping_failures'] for s in scores) if all(s['goal_keeping_failures'] is not None for s in scores) else None,
                            'restatement_passed': sum(r['graded'] and r['judgment']['verdict'] == 'pass' for r in restatements),
                            'contamination': audit['classification'], 'verification_revision': 2,
                            'artifact_checks': artifact_checks(root, spec, stops)})
            rows.append(summary)
    finally:
        pilot_score.score_stage, pilot_score.run_packet = original_score, original_packet
    verify_sources(spec['source_sha256'])
    accepted = accept_pair(spec, rows)
    write_new(a.root / 'main-scores.json', {'study_phase': 'main', 'question': spec['question'], 'runs': rows,
              'main_runs_executed': 2, 'valid_pairs': int(accepted), 'scoring_complete': accepted,
              'freeze_sha256': file_digest(a.root / 'main-freeze.json')})
    print(json.dumps({'scoring_complete': accepted, 'valid_pairs': int(accepted)}), flush=True)
    if not accepted:
        raise SystemExit(2)


if __name__ == '__main__':
    main()
