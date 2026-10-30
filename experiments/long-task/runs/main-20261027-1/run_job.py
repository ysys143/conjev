import json, subprocess, sys, time
from pathlib import Path
repo=Path('/Users/jaesolshin/Documents/GitHub/context-harness')
here=repo/'experiments/long-task'
root=Path('/private/tmp/ch-research-main-20261027-1')
config=Path('/Users/jaesolshin/.claude-reserach')
steps=[
 ['main_pair.py','--config',str(config),'--root',str(root),'--ledger',str(here/'runs/study-spend.sqlite3'),'--admission','/private/tmp/ch-research-phase1-20261027-5/acceptance.json','--pilot',str(here/'runs/pilot-20261027-2/acceptance-final.json'),'--preflight','/private/tmp/ch-research-main-preflight-20261027-1'],
 ['main_pair_score.py','--config',str(config),'--root',str(root)],
 ['smoke.py','--config',str(config),'--root','/private/tmp/ch-research-main-after-20261027-1']]
for index,args in enumerate(steps):
 result=subprocess.run([sys.executable,str(here/args[0]),*args[1:]],cwd=repo)
 Path(__file__).with_name(f'step-{index}.json').write_text(json.dumps({'step':args[0],'exit_code':result.returncode,'ended_at':time.time()})+'\n')
 if result.returncode: raise SystemExit(result.returncode)
