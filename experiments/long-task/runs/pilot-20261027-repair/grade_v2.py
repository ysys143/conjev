"""Versioned rescoring of immutable execution data; no executor feedback."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

HERE = Path('/Users/jaesolshin/Documents/GitHub/context-harness/experiments/long-task')
sys.path.insert(0, str(HERE))
from grading import check_subscription, file_digest, load, write_new
from pilot_run import action_rows
import pilot_score
from verification_v2 import score


def rescore_arm(original):
    closed = load(original / 'closure.json')
    if not closed['runner_observed_end'] or not closed['evidence_complete'] or closed['exit_code'] != 0:
        raise ValueError('An incomplete executor cannot be rescored as complete')
    private = load(original / 'private-definition.json')
    events = [json.loads(line) for line in (original / 'fs-events.jsonl').read_text().splitlines()]
    before = load(original / 'stage-scores.json')['stages']
    after, changes = [], []
    for i, contract in enumerate(private['contracts'], 1):
        receipt = load(original / 'observer/stages' / f'{i:02}.json')
        row = score(original / 'observer/snapshots' / receipt['snapshot'], contract, workspace=original / 'task',
                    watcher_events=events, tool_calls=action_rows(receipt['events']), stage=i)
        prior = before[i - 1]
        old_nonverification = {r['id']: r['verdict'] for r in prior['criteria'] if r['role'] != 'verification'}
        new_nonverification = {r['id']: r['verdict'] for r in row['criteria'] if r['role'] != 'verification'}
        if old_nonverification != new_nonverification:
            raise ValueError('A criterion outside the verification correction changed; inspect before using these scores')
        if prior['all_pass'] != row['all_pass']:
            changes.append({'stage': i, 'all_pass_v1': prior['all_pass'], 'all_pass_v2': row['all_pass'],
                            'verification_audit': row['verification_audit']})
        after.append(row)
    return after, changes


def prepare_arm(execution, target):
    if target.exists():
        receipt = load(target / 'rescore-provenance.json')
        if receipt['verification_source_sha256'] != file_digest(Path(__file__).with_name('verification_v2.py')):
            raise ValueError('Scoring source changed after this view was prepared')
        for name, expected in receipt['original_inputs'].items():
            if file_digest(Path(name)) != expected:
                raise ValueError('Original execution artifact changed')
        return
    scores, changes = rescore_arm(execution)
    target.mkdir(parents=True, exist_ok=False)
    for name in ['task', 'observer', 'stages', 'evidence']:
        shutil.copytree(execution / name, target / name, copy_function=os.link, symlinks=True)
    for name in ['private-definition.json', 'fs-events.jsonl', 'closure.json', 'restatement.json', 'contamination.json']:
        os.link(execution / name, target / name)
    result = load(execution / 'run-result.json')
    result.update({'scores_complete': all(r['complete'] for r in scores),
                   'completed_stages': sum(r['all_pass'] is True for r in scores) if all(r['complete'] for r in scores) else None,
                   'known_completed_stages': sum(r['all_pass'] is True for r in scores),
                   'verification_revision': 2, 'original_execution_root': str(execution)})
    write_new(target / 'stage-scores.json', {'stages': scores, 'verification_revision': 2})
    write_new(target / 'run-result.json', result)
    names = ['run-result.json', 'stage-scores.json', 'private-definition.json', 'closure.json', 'fs-events.jsonl', 'restatement.json']
    write_new(target / 'rescore-provenance.json', {'verification_revision': 2, 'changes': changes,
              'verification_source_sha256': file_digest(Path(__file__).with_name('verification_v2.py')),
              'driver_source_sha256': file_digest(Path(__file__)),
              'original_inputs': {str(execution / name): file_digest(execution / name) for name in names},
              'policy': 'Same assigned criterion. A later isolated RED control is not a failure of the task workspace; final-snapshot unittest must independently pass nonempty tests. No raw v1 score or executor input is rewritten.'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execution-root', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--config', type=Path)
    parser.add_argument('--prepare-arm', choices=['V', 'H', 'S1', 'S0'])
    parser.add_argument('--claude', type=Path, default=Path.home() / '.local/share/claude/versions/2.1.309')
    args = parser.parse_args()
    source = load(args.execution_root / 'pilot-spec.json')
    if any(file_digest(Path(p)) != expected for p, expected in source['source_sha256'].items()):
        raise ValueError('Frozen execution source changed')
    args.root.mkdir(parents=True, exist_ok=True)
    if not (args.root / 'pilot-spec.json').exists():
        write_new(args.root / 'pilot-spec.json', {**source, 'verification_revision': 2,
                  'original_execution_root': str(args.execution_root),
                  'original_spec_sha256': file_digest(args.execution_root / 'pilot-spec.json')})
    if args.prepare_arm:
        prepare_arm(args.execution_root / args.prepare_arm, args.root / args.prepare_arm)
        print(json.dumps({'prepared': args.prepare_arm, 'grading_complete': False}))
        return
    if args.config is None:
        raise ValueError('Subscription profile required for independent grading')
    version = check_subscription(args.claude, args.config)
    grading_sources = {str(path): file_digest(path) for path in [Path(__file__), Path(__file__).with_name('verification_v2.py'),
                       HERE / 'pilot_score.py', HERE / 'pilot_judge.py', HERE / 'stage_scoring.py']}
    write_new(args.root / 'grading-source-before.json', grading_sources)
    summaries = []
    original_score = pilot_score.score_stage
    original_neutral = pilot_score.neutral
    try:
        for pair in source['order']:
            for arm in pair:
                original = args.execution_root / arm
                target = args.root / arm
                prepare_arm(original, target)
                pilot_score.score_stage = lambda snap, contract, **kwargs: score(snap, contract, workspace=original / 'task', **kwargs)
                pilot_score.neutral = lambda value, task: original_neutral(value, original / 'task')
                judgments = pilot_score.classify_candidates(target, binary=args.claude, config=args.config,
                                                            model=source['judge_model'], version=version)
                restatements = pilot_score.restatement(target, binary=args.claude, config=args.config,
                                                      model=source['judge_model'], version=version)
                summaries.append(pilot_score.summarize(target, judgments, restatements))
    finally:
        pilot_score.score_stage = original_score
        pilot_score.neutral = original_neutral
    complete = len(summaries) == 4 and all(r['stage_scoring_complete'] and r['stop_stage_coverage'] == r['stop_stages_expected']
                    and r['stop_graded'] == r['stop_expected'] and r['restatement_graded'] == r['restatement_expected'] for r in summaries)
    if any(file_digest(Path(path)) != expected for path, expected in grading_sources.items()):
        raise ValueError('Grading source changed during independent judgments')
    write_new(args.root / 'pilot-scores.json', {'runs': summaries, 'scoring_complete': complete, 'verification_revision': 2, 'main_runs': 0})
    print(json.dumps({'scoring_complete': complete, 'runs': len(summaries), 'verification_revision': 2, 'main_runs': 0}))
    if not complete:
        raise SystemExit(2)


if __name__ == '__main__':
    main()
