"""Wait for initial judgments, repair the known evidence omission, then audit."""
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
initial_job = HERE / 'runs/pilot-20261027-2/scoring-resume-job.json'
while not initial_job.exists():
    time.sleep(5)
if load(initial_job)['exit_code'] not in (0, 2):
    raise RuntimeError('Initial judge transport or execution failed; preserve and inspect it')
receipt = HERE / 'runs/pilot-20261027-2/restatement-completion-job.json'
session = launch(repair / 'complete_restatement.py', [], cwd=REPO, receipt=receipt)
write_new(repair / 'restatement-completion-launched.json', {'session': session, 'receipt': str(receipt), 'launched_at': time.time()})
while not receipt.exists():
    time.sleep(5)
if load(receipt)['exit_code'] != 0:
    raise RuntimeError('Complete-evidence restatement judgments remain incomplete')
root = Path('/private/tmp/ch-research-pilot-scoring-20261027-1')
result = subprocess.run([sys.executable, str(repair / 'validate-pilot.py'), '--root', str(root),
                         '--output', str(HERE / 'runs/pilot-20261027-2/acceptance.json')], text=True, capture_output=True, cwd=REPO)
(repair / 'pilot-full-evidence-acceptance.log').write_text(result.stdout + result.stderr)
if result.returncode != 0:
    raise RuntimeError('Final raw-evidence and full-instruction grading audit failed')
print('Pilot full-evidence acceptance PASS', flush=True)
