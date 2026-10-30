"""Grade all closed executions with the corrected, versioned verification scope."""
import json
import subprocess
import sys
import time
from pathlib import Path

REPO = Path('/Users/jaesolshin/Documents/GitHub/context-harness')
HERE = REPO / 'experiments/long-task'
sys.path.insert(0, str(HERE))
from grading import load, write_new
from native_run import launch

repair = HERE / 'runs/pilot-20261027-repair'
execution = HERE / 'runs/pilot-20261027-2/job.json'
while not execution.exists():
    time.sleep(5)
if load(execution)['exit_code'] != 0:
    raise RuntimeError('Executor data are incomplete; no grading admission')
grade_root = Path('/private/tmp/ch-research-pilot-scoring-20261027-1')
receipt = HERE / 'runs/pilot-20261027-2/scoring-v2-job.json'
arguments = ['--execution-root', '/private/tmp/ch-research-pilot-20261027-2', '--root', str(grade_root),
             '--config', '/Users/jaesolshin/.claude-reserach']
session = launch(repair / 'grade_v2.py', arguments, cwd=REPO, receipt=receipt)
write_new(repair / 'scoring-v2-launched.json', {'session': session, 'receipt': str(receipt),
          'grading_root': str(grade_root), 'arguments': arguments, 'launched_at': time.time()})
print('All four executions closed; versioned independent grading launched: ' + session, flush=True)
while not receipt.exists():
    time.sleep(5)
if load(receipt)['exit_code'] != 0:
    raise RuntimeError('Independent grading failed; keep all original judgment attempts')
result = subprocess.run([sys.executable, str(repair / 'validate-pilot.py'), '--root', str(grade_root),
                         '--output', str(HERE / 'runs/pilot-20261027-2/acceptance.json')],
                        cwd=REPO, text=True, capture_output=True)
(repair / 'pilot-v2-acceptance.log').write_text(result.stdout + result.stderr)
if result.returncode != 0:
    raise RuntimeError('Versioned scoring or raw-evidence acceptance failed')
print('Pilot raw-evidence and scoring-v2 acceptance PASS', flush=True)
