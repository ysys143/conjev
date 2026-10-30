"""Admit fresh pilot pairs after fresh transport and source-bound device checks."""
import json
import sys
import time
from pathlib import Path

REPO = Path('/Users/jaesolshin/Documents/GitHub/context-harness')
HERE = REPO / 'experiments/long-task'
sys.path.insert(0, str(HERE))
from grading import file_digest, load, write_new
from native_run import launch

phase0 = HERE / 'runs/phase0-20261027-2/acceptance-reported.json'
accepted0 = load(phase0)
if not accepted0['phase_0_complete'] or len(accepted0['checks']) != 23 or not all(accepted0['checks'].values()):
    raise RuntimeError('Current phase-0 acceptance is incomplete')
bundle = load(HERE / 'phase0-evidence-20261027-2.json')
if file_digest(REPO / 'docs/research/next-evaluation.md') != bundle['plan_sha256']:
    raise RuntimeError('Execution specification changed after phase-0 acceptance')
job = HERE / 'runs/phase1-20261027-3/job.json'
while not job.exists():
    time.sleep(5)
if load(job)['exit_code'] != 0:
    raise RuntimeError('Phase-1 device revalidation failed')
admission = Path('/private/tmp/ch-research-phase1-20261027-3/acceptance.json')
accepted = load(admission)
if not (accepted['phase_1_complete'] and accepted['case_count'] == 92 and accepted['live_executions'] == 276
        and accepted['independent_stop_judgments'] == 36 and accepted['q3_negative_checks_passed']):
    raise RuntimeError('Device coverage or independent judgment is incomplete')
replayed = sum(row.get('replayed_with_current_checker') is True for row in accepted['cases'])
write_new(HERE / 'runs/pilot-20261027-repair/device-acceptance-census.json',
          {'original_live_cases_revalidated': replayed, 'fresh_live_cases': len(accepted['cases']) - replayed,
           'total': len(accepted['cases']), 'source': str(admission), 'sha256': file_digest(admission)})
arguments = ['--config', '/Users/jaesolshin/.claude-reserach', '--root', '/private/tmp/ch-research-pilot-20261027-1',
             '--ledger', str(HERE / 'runs/study-spend.sqlite3'), '--admission', str(admission)]
receipt = HERE / 'runs/pilot-20261027-1/job.json'
session = launch(HERE / 'pilot_run.py', arguments, cwd=REPO, receipt=receipt)
write_new(HERE / 'runs/pilot-20261027-repair/pilot-launched.json',
          {'session': session, 'receipt': str(receipt), 'phase0_acceptance': str(phase0),
           'phase1_acceptance': str(admission), 'arguments': arguments, 'launched_at': time.time()})
print(json.dumps({'pilot_session': session, 'receipt': str(receipt)}), flush=True)
