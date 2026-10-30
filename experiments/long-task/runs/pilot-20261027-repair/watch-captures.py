"""Stop an already invalid pilot capture promptly; never filter task outcomes."""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

REPO = Path('/Users/jaesolshin/Documents/GitHub/context-harness')
HERE = REPO / 'experiments/long-task'
sys.path.insert(0, str(HERE))
from grading import file_digest, load, write_new

root = Path('/private/tmp/ch-research-pilot-20261027-1')
job = HERE / 'runs/pilot-20261027-1/job.json'
seen = set()
while not job.exists():
    for path in root.glob('*/evidence/requests/*.json'):
        if path in seen:
            continue
        try:
            record = load(path)
        except (OSError, ValueError):
            continue
        if 'ended_at' not in record:
            continue
        seen.add(path)
        if record.get('path', '').split('?', 1)[0] != '/v1/messages' or record.get('complete') is True:
            continue
        metadata = {k: record.get(k) for k in ['id', 'error', 'error_phase', 'status', 'curl_exit_code', 'response_bytes', 'usage']}
        metadata.update({'source': str(path), 'sha256': file_digest(path), 'observed_at': time.time(),
                         'reason': 'Already incomplete infrastructure capture; no task outcome was inspected or selected.'})
        write_new(HERE / 'runs/pilot-20261027-1/capture-monitor-stop.json', metadata)
        rows = subprocess.check_output(['ps', '-axo', 'pid=,command='], text=True).splitlines()
        for line in rows:
            parts = line.strip().split(None, 1)
            if len(parts) == 2 and '/experiments/long-task/pilot_run.py ' in parts[1] and '--root ' + str(root) + ' ' in parts[1]:
                os.kill(int(parts[0]), signal.SIGINT)
        print(json.dumps(metadata), flush=True)
        raise SystemExit(2)
    time.sleep(5)
print(json.dumps({'checked_original_captures': len(seen), 'execution_exit': load(job)['exit_code']}), flush=True)
