"""Freeze the planned study, then execute only its first randomized pair.

Uses the accepted pilot executor unchanged. Pilot-specific filenames are kept
only as compatibility inputs for the existing grading tools; study_phase is main.
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from grading import check_subscription, digest, file_digest, load, write_new
from pilot_run import CEILINGS, REPO, HERE, run_arm, source_identity
from spend import SpendLedger, EXPECTED_MODEL
from task_generator import FAMILIES, make_case

REPAIR = HERE / 'runs/pilot-20261027-repair'


def schedule():
    rng = random.Random(20261027)
    rows = []
    for question, arms in [('Q1', ['V', 'H']), ('Q3', ['S0', 'S1'])]:
        for family in sorted(FAMILIES):
            for seed in [11, 23, 47]:
                order = arms.copy()
                rng.shuffle(order)
                rows.append({'question': question, 'family': family, 'seed': seed, 'arms': order,
                             'task_identity': make_case(family, seed).identity})
    rng.shuffle(rows)
    return rows


def validate_prerequisites(admission_path, pilot_path):
    admission = load(admission_path)
    pilot = load(pilot_path)
    if not (admission.get('phase_1_complete') is True and admission.get('case_count') == 92
            and admission.get('live_executions') == 276 and admission.get('deterministic_hook_cases') == 89
            and admission.get('product_mutants_rejected') == 4 and admission.get('q3_negative_checks_passed') is True):
        raise ValueError('Phase 1 incomplete')
    manifest_path = admission_path.parent / 'manifest.json'
    manifest = load(manifest_path)
    if file_digest(manifest_path) != admission['manifest_sha256']:
        raise ValueError('Phase 1 manifest changed')
    if any(file_digest(Path(p)) != h for p, h in manifest['source_sha256'].items()):
        raise ValueError('Phase 1 execution source changed')
    if manifest.get('curl_binary_sha256') != file_digest(Path('/usr/bin/curl')):
        raise ValueError('Transport binary changed')
    if not (pilot.get('pilot_complete') is True and pilot.get('valid_pairs') == {'Q1': 1, 'Q3': 1}
            and all(pilot['checks'].values())):
        raise ValueError('Both pilot comparisons must be complete')
    return admission


def verify_sources(sources):
    if any(file_digest(Path(p)) != h for p, h in sources.items()):
        raise ValueError('Frozen source changed; preserve partial evidence and stop')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config', type=Path, required=True)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--ledger', type=Path, required=True)
    p.add_argument('--admission', type=Path, required=True)
    p.add_argument('--pilot', type=Path, required=True)
    p.add_argument('--preflight', type=Path, required=True)
    p.add_argument('--claude', type=Path, default=Path.home() / '.local/share/claude/versions/2.1.309')
    args = p.parse_args()
    admission_path = args.admission
    args.admission = validate_prerequisites(admission_path, args.pilot)
    preflight = load(args.preflight / 'smoke.json')
    events = load(args.preflight / 'turn.json')['events']
    meters = [e['rate_limit_info'] for e in events if e.get('type') == 'rate_limit_event']
    if not (preflight['settings_match'] and preflight['inventory_isolated']
            and preflight['closure']['exit_code'] == 0 and preflight['closure']['evidence_complete']
            and meters and all(m.get('status') == 'allowed' for m in meters)):
        raise ValueError('Fresh subscription/wire/capacity evidence incomplete')
    version = check_subscription(args.claude, args.config)
    args.root.mkdir(parents=True, exist_ok=False, mode=0o700)
    sources = source_identity()
    for path in [Path(__file__), args.claude, REPAIR / 'verification_v2.py', REPAIR / 'scratch_audit.py',
                 HERE / 'main_pair_score.py', HERE / 'grading.py', HERE / 'pilot_judge.py']:
        sources[str(path)] = file_digest(path)
    allocation = schedule()
    first = allocation[0]
    spec = {'version': 1, 'study_phase': 'main', 'authorized_pairs': 1, 'authorized_runs': 2,
            'authorization': 'Owner requested one main comparison pair on 2026-10-27.',
            'allocation_rng_seed': 20261027, 'allocation': allocation, 'selected_pair_index': 0,
            'pilot_seed_excluded': 71, 'main_seeds': [11, 23, 47], 'order': [first['arms']],
            'family': first['family'], 'seed': first['seed'], 'question': first['question'],
            'task_identity': first['task_identity'],
            'ceilings': CEILINGS, 'executor_model': preflight['requested_model'], 'executor_effort': 'max',
            'judge_model': 'claude-opus-5-5', 'judge_effort': 'low', 'cli_version': version,
            'jev_model': EXPECTED_MODEL, 'source_sha256': sources,
            'prerequisites': {str(path): file_digest(path) for path in [admission_path, args.pilot, args.preflight / 'smoke.json', args.preflight / 'turn.json']},
            'subscription_meters_before': meters, 'spend_before': SpendLedger(args.ledger).summary(),
            'budget': {'authorized_pair_run_seconds_max': 14400, 'per_run': CEILINGS,
                       'jev_cumulative_usd': 10, 'claude_transport': 'subscription only',
                       'remaining_17_pairs_authorized': False,
                       'full_study_capacity': 'Not established; re-admission required before any additional pair'},
            'replacement_policy': 'No automatic replacements. Preserve every attempt, interruption and ceiling outcome; missing comparisons stay missing.',
            'verification_revision': 2, 'restatement_evidence': 'All twelve original instructions included for every proposition.',
            'environment_audit_revision': 2}
    write_new(args.root / 'main-freeze.json', spec)
    write_new(args.root / 'pilot-spec.json', {**spec, 'compatibility_filename_only': True})
    rows = []
    case = make_case(first['family'], first['seed'])
    for arm in first['arms']:
        verify_sources(sources)
        target = args.root / arm
        target.mkdir()
        rows.append(run_arm(args, case, arm, target))
        verify_sources(sources)
    write_new(args.root / 'execution-summary.json', {'study_phase': 'main', 'runs': rows,
              'executions_complete': len(rows) == 2, 'semantic_grading_complete': False, 'main_runs': 2})
    print(json.dumps({'main_runs': 2, 'question': first['question'], 'execution_complete': True}), flush=True)


if __name__ == '__main__':
    main()
