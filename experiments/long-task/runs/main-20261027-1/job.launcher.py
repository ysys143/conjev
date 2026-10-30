import json, os, subprocess, time
from pathlib import Path
job={'argv': ['/opt/homebrew/bin/python3', '/Users/jaesolshin/Documents/GitHub/context-harness/experiments/long-task/runs/main-20261027-1/run_job.py'], 'cwd': '/Users/jaesolshin/Documents/GitHub/context-harness', 'receipt': '/Users/jaesolshin/Documents/GitHub/context-harness/experiments/long-task/runs/main-20261027-1/job.json', 'session': 'ch-eval-cc784ece819241', 'tmux_server_pid': 94567}
started=time.time()
env=dict(os.environ)
env.pop('CLAUDECODE',None)
with Path(job['receipt']+'.stdout.log').open('w') as out, Path(job['receipt']+'.stderr.log').open('w') as err:
    child=subprocess.run(job['argv'],cwd=job['cwd'],env=env,stdout=out,stderr=err)
Path(job['receipt']).write_text(json.dumps({'exit_code':child.returncode,'session':job['session'],'tmux_server_pid':job['tmux_server_pid'],'started_at':started,'ended_at':time.time(),'cwd':job['cwd']},indent=2)+'\n')
