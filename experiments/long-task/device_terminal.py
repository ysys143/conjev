"""Read the real tmux terminal screen; never answer trust or permission dialogs."""
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import time
import uuid
from pathlib import Path

from grading import check_subscription, subscription_env, write_new
from driver import research_settings


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,required=True);p.add_argument('--config',type=Path,required=True)
    p.add_argument('--plugin',type=Path,required=True);p.add_argument('--mode',choices=['empty','missing-key','floor'],required=True)
    p.add_argument('--workspace',type=Path)
    p.add_argument('--assert-screen',action='store_true')
    p.add_argument('--claude',type=Path,default=Path.home()/'.local/share/claude/versions/2.1.309')
    a=p.parse_args();check_subscription(a.claude,a.config)
    a.root.mkdir(parents=True,exist_ok=False,mode=0o700)
    task=a.workspace or a.root/'task'
    task.mkdir(parents=True,exist_ok=True)
    options={'stopGate':'shadow' if a.mode!='floor' else 'off','toolGate':'active' if a.mode=='floor' else 'off','providerTrust':'external','foldAtPercent':0}
    settings=a.root/'settings.json'
    fixture=Path(__file__).resolve().parent/'device_fixture'
    stimulus=a.root/'stimulus.json'
    control=a.root/'control';control.mkdir()
    (control/'.env').write_text('Evaluator-owned, nonsecret floor control.\n')
    stimulus.write_text(json.dumps({'operation':'tools','tools':[{'tool':'Read','file_path':str(control/'.env')}]}))
    settings.write_text(json.dumps(research_settings({'enabledPlugins':{},'env':{'CH_DEVICE_SPEC_FILE':str(stimulus),'CH_DEVICE_LOG_DIR':str(a.root/'fixture-log')},'pluginConfigs':{'context-harness@inline':{'options':options}}})))
    cmd=[str(a.claude),'--model','haiku','--effort','max','--setting-sources','','--settings',str(settings),'--plugin-dir',str(fixture),'--plugin-dir',str(a.plugin),'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-chrome']
    launcher=a.root/'launch.py'
    launcher.write_text('import os,sys\nsys.path.insert(0,'+repr(str(Path(__file__).resolve().parent))+')\nfrom pathlib import Path\nfrom grading import subscription_env\ne=subscription_env(Path('+repr(str(a.config))+'))\ne["CONTEXT_HARNESS_STATE_HOME"]='+repr(str(a.root/'state'))+'\nos.execve('+repr(str(a.claude))+','+repr(cmd)+',e)\n')
    name='ch-screen-'+uuid.uuid4().hex[:12]
    subprocess.run(['tmux','-N','new-session','-d','-s',name,'-x','120','-y','40','-c',str(task),shlex.join(['/opt/homebrew/bin/python3',str(launcher)])],check=True)
    write_new(a.root/'session.json',{'tmux_session':name,'argv':cmd,'mode':a.mode})
    time.sleep(3)
    r=subprocess.run(['tmux','-N','capture-pane','-p','-t',name],text=True,capture_output=True)
    (a.root/'screen.txt').write_text(r.stdout+r.stderr)
    needs_human=any(t in r.stdout.lower() for t in ['trust this','trust the files','trust this folder','trust project','accept the risk','security notice'])
    write_new(a.root/'screen-status.json',{'needs_human':needs_human,'session':name,'screen_capture_exit':r.returncode,'terminal_screen':True})
    if a.assert_screen and not needs_human:
        if a.mode=='floor':
            subprocess.run(['tmux','-N','send-keys','-t',name,'/device','Enter'],check=True)
            time.sleep(2)
        text=subprocess.check_output(['tmux','-N','capture-pane','-p','-t',name],text=True)
        (a.root/'verified-screen.txt').write_text(text)
        expected='jev: no key' if a.mode=='missing-key' else 'tool active 1 hits' if a.mode=='floor' else None
        checks={'real_terminal_present':bool(text.strip()),'no_dialog':not needs_human,'expected_display':expected in text if expected else 'jev:' not in text and 'tool active' not in text}
        records=[json.loads(f.read_text()) for f in (a.root/'state').rglob('*.json') if '/records/' in str(f)]
        checks['record_count']=len(records)==int(a.mode=='floor')
        write_new(a.root/'case.json',{'mode':a.mode,'checks':checks,'passed':all(checks.values()),'terminal_screen':True})
        subprocess.run(['tmux','-N','kill-session','-t',name],check=True)
        if not all(checks.values()):raise ValueError('Terminal status assertion failed')
    elif a.assert_screen:
        raise RuntimeError('Human trust approval is required; the driver did not answer it')
    print(json.dumps({'needs_human':needs_human,'session':name,'screen':str(a.root/'screen.txt')}))


if __name__=='__main__':main()
