"""Admit the repaired pilot only after both fresh prerequisite phases pass."""
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path('/Users/jaesolshin/Documents/GitHub/context-harness')
HERE = REPO / 'experiments/long-task'
sys.path.insert(0, str(HERE))
from grading import file_digest, load, write_new
from native_run import launch

receipt_root = HERE / 'runs/pilot-20261027-repair'
bundle_path = HERE / 'phase0-evidence-20261027-2.json'
bundle = load(bundle_path)
jobs = {role: REPO / row['job'] for role, row in bundle['runs'].items()}
while not all(path.exists() for path in jobs.values()):
    failed = {role: load(path)['exit_code'] for role, path in jobs.items()
              if path.exists() and load(path)['exit_code'] != 0}
    if failed:
        raise RuntimeError('Fresh phase-0 job failed: ' + repr(failed))
    time.sleep(5)
if any(load(path)['exit_code'] != 0 for path in jobs.values()):
    raise RuntimeError('Fresh phase-0 execution failed')

if not load(Path('/private/tmp/ch-research-transport-stress-20261027-2/probe.json'))['passed']:
    raise RuntimeError('HTTP/2 transport stress probe did not pass')

before_path = Path('/private/tmp/ch-research-transport-stress-20261027-2/evidence/stdout.jsonl')
before_events = [json.loads(line) for line in before_path.read_text().splitlines()]
index, event = next((i, e) for i, e in enumerate(before_events) if e.get('type') == 'rate_limit_event')
info = event['rate_limit_info']
candidates = []
for row in bundle['runs'].values():
    for path in Path(row['run']).rglob('requests/*.json'):
        record = load(path)
        headers = {k.lower(): v for k, v in record.get('response_headers', {}).items()}
        if record.get('status') == 200 and 'anthropic-ratelimit-unified-5h-utilization' in headers:
            candidates.append((record['ended_at'], path, headers))
observed_at, after_path, headers = max(candidates, key=lambda item: item[0])
budget = {'version': 1, 'phase': 0,
          'authorization': {'claude_transport': 'subscription', 'paid_claude_api_ceiling_usd': 0,
                            'jev_shared_ceiling_usd': 10, 'jev_phase_admission': 'Shared approved ceiling, all failed attempts retained'},
          'before': {'source': str(before_path), 'source_sha256': file_digest(before_path),
                     'event_index': index, 'windows': info['unifiedWindows'], 'status': info['status']},
          'after': {'source': str(after_path), 'source_sha256': file_digest(after_path), 'observed_at': observed_at,
                    'five_hour': {'utilization': float(headers['anthropic-ratelimit-unified-5h-utilization']),
                                  'resetsAt': int(headers['anthropic-ratelimit-unified-5h-reset'])},
                    'seven_day': {'utilization': float(headers['anthropic-ratelimit-unified-7d-utilization']),
                                  'resetsAt': int(headers['anthropic-ratelimit-unified-7d-reset'])},
                    'status': headers['anthropic-ratelimit-unified-status']},
          'limits': ['Shared account meters are not attributable study costs; no subtraction.',
                     'Claude runs use the subscription; no paid Claude API route.']}
write_new(REPO / bundle['budget_snapshots'], budget)
old_report = REPO / 'docs/research/phase-0-results.md'
shutil.copyfile(old_report, receipt_root / 'phase-0-report-before-curl.md')
command = [sys.executable, str(HERE / 'phase0_gate.py'), '--bundle', str(bundle_path),
           '--output', str(HERE / 'runs/phase0-20261027-2/acceptance.json'),
           '--report', str(old_report)]
result = subprocess.run(command, cwd=REPO, text=True, capture_output=True)
(receipt_root / 'phase0-curl-gate.log').write_text(result.stdout + result.stderr)
if result.returncode != 0:
    raise RuntimeError('Fresh aggregate phase-0 gate failed; see phase0-curl-gate.log')
print('Phase 0 accepted', flush=True)

phase1_job = HERE / 'runs/phase1-20261027-2/job.json'
while not phase1_job.exists():
    time.sleep(5)
if load(phase1_job)['exit_code'] != 0:
    raise RuntimeError('Fresh phase 1 failed; preserve its evidence and repair the failing case')
admission = Path('/private/tmp/ch-research-phase1-20261027-2/acceptance.json')
accepted = load(admission)
if not (accepted.get('phase_1_complete') and accepted.get('case_count') == 92
        and accepted.get('live_executions') == 276 and accepted.get('independent_stop_judgments') == 36):
    raise RuntimeError('Fresh complete phase-1 acceptance is missing')
arguments = ['--config', '/Users/jaesolshin/.claude-reserach', '--root', '/private/tmp/ch-research-pilot-20261027-1',
             '--ledger', str(HERE / 'runs/study-spend.sqlite3'), '--admission', str(admission)]
receipt = HERE / 'runs/pilot-20261027-1/job.json'
session = launch(HERE / 'pilot_run.py', arguments, cwd=REPO, receipt=receipt)
write_new(receipt_root / 'pilot-launched.json', {'session': session, 'receipt': str(receipt),
          'phase0_acceptance': str(HERE / 'runs/phase0-20261027-2/acceptance.json'),
          'phase1_acceptance': str(admission), 'arguments': arguments, 'launched_at': time.time()})
print(json.dumps({'pilot_session': session, 'receipt': str(receipt)}), flush=True)
