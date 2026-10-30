"""Follow the admitted pilot through closed execution, grading and raw-evidence audit."""
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

receipt_root = HERE / 'runs/pilot-20261027-repair'
launched = receipt_root / 'pilot-launched.json'
while not launched.exists():
    time.sleep(5)
execution = Path(load(launched)['receipt'])
while not execution.exists():
    time.sleep(5)
if load(execution)['exit_code'] != 0:
    raise RuntimeError('Pilot execution failed; preserve artifacts and repair the failing path')
root = Path('/private/tmp/ch-research-pilot-20261027-1')
scoring = HERE / 'runs/pilot-20261027-1/scoring-job.json'
session = launch(HERE / 'pilot_score.py', ['--root', str(root), '--config', '/Users/jaesolshin/.claude-reserach'],
                 cwd=REPO, receipt=scoring)
write_new(receipt_root / 'scoring-launched.json', {'session': session, 'receipt': str(scoring), 'launched_at': time.time()})
print('Closed pilot execution; launched independent grading: ' + session, flush=True)
while not scoring.exists():
    time.sleep(5)
if load(scoring)['exit_code'] != 0:
    raise RuntimeError('Pilot grading failed; preserve every original judgment attempt')
command = [sys.executable, str(receipt_root / 'validate-pilot.py'), '--root', str(root),
           '--output', str(HERE / 'runs/pilot-20261027-1/acceptance.json')]
result = subprocess.run(command, cwd=REPO, text=True, capture_output=True)
(receipt_root / 'pilot-acceptance.log').write_text(result.stdout + result.stderr)
if result.returncode != 0:
    raise RuntimeError('The final pilot completion audit failed; see pilot-acceptance.log')
print('Pilot raw-evidence acceptance PASS', flush=True)
