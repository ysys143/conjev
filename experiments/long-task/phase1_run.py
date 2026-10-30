"""Execute the complete frozen 92-case device contract before formal pilots."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor,wait,FIRST_COMPLETED
from pathlib import Path
from types import SimpleNamespace

from device_contract import build_cases
from device_live import HERE, REPO, archive_rows, checks_for, read_logs, record_rows, run_case
from grading import check_subscription, digest, file_digest, load, write_new
from pilot_judge import run_packet

EXTERNAL={'instruction-filter-deterministic':'device_filter_probe.py','skills':'device_skill_probe.py','status-line':'device_terminal.py'}
DEVICE_WORKERS=6


def freeze(root,binary):
    sources=[*(REPO/'hooks').glob('*.ts'),*(REPO/'skills').rglob('SKILL.md'),REPO/'.claude-plugin/plugin.json',
             *HERE.glob('*.py'), HERE/'device_contract.fixture.ts',
             *(HERE/group/path for group in ['device_fixture','device_sink','observer'] for path in ['hooks/register.ts','.claude-plugin/plugin.json']),
             *(HERE/'device_fixture/commands').glob('*.md'),
             REPO/'tests/kit.ts']
    fingerprints={str(p):file_digest(p) for p in sources}
    for path in sources:
        target=root/'source'/path.relative_to(REPO)
        target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target)
    cases=build_cases()
    for c in cases:
        c['live_binding']=EXTERNAL.get(c['id'].split('.')[0],'device_live.py:run_case/checks_for')
        c['live_repetitions']=3
        c['live_record_policy']='Exact declared record census per native event; real service probabilities are checked against the originating response rather than fixture constants.'
    manifest={'version':1,'cases':cases,'case_count':len(cases),'source_sha256':fingerprints,'cli_binary_sha256':file_digest(binary),'curl_binary_sha256':file_digest(Path('/usr/bin/curl')),'frozen_before_execution':True,'phase_1_complete':False,'independent_device_workers':DEVICE_WORKERS}
    write_new(root/'manifest.json',manifest)
    return manifest


def replay(root, definition):
    receipt=load(root/'case.json')
    producer=load(root.parent/'manifest.json')
    for path,value in producer['source_sha256'].items():
        if path.startswith(str(REPO/'hooks')+'/') and file_digest(Path(path))!=value:return None
    if not receipt.get('closure',{}).get('runner_observed_end') or not receipt['closure'].get('evidence_complete'):return None
    if receipt.get('frozen_definition_sha256')!=digest(definition):return None
    if any(file_digest(root/path)!=expected for path,expected in receipt.get('artifacts',{}).items()):return None
    case=load(root/'mapped-definition.json')
    actual_options=load(root/'evidence/settings.json')['pluginConfigs']['context-harness@inline']['options']
    if any(actual_options.get(k)!=v for k,v in case['options'].items()):return None
    observer=SimpleNamespace(store=root/'observer')
    events=[load(p) for p in (observer.store/'events').glob('*.json')]
    requests=[load(p) for p in (root/'evidence/requests').glob('*.json')]
    wire=[json.loads(r['request_body']) for r in requests if r.get('path','').split('?',1)[0]=='/v1/messages']
    checks=checks_for(case,read_logs(root/'log'),record_rows(root/'evidence/plugin-state'),archive_rows(root/'evidence/plugin-state'),events,observer,wire)
    if not all(checks.values()):return None
    return {**receipt,'original_checker_passed':receipt.get('passed'),'passed':True,'replayed_checks':checks,'replayed_with_current_checker':True,'source_run':str(root)}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,required=True);p.add_argument('--config',type=Path,required=True);p.add_argument('--ledger',type=Path,required=True)
    p.add_argument('--screen-workspace',type=Path,required=True)
    p.add_argument('--resume',type=Path,action='append',default=[])
    p.add_argument('--claude',type=Path,default=Path.home()/'.local/share/claude/versions/2.1.309')
    a=p.parse_args();version=check_subscription(a.claude,a.config)
    a.root.mkdir(parents=True,exist_ok=False,mode=0o700)
    manifest=freeze(a.root,a.claude)
    command=[sys.executable,str(HERE/'device_contract.py'),'--root',str(a.root/'deterministic'),'--claude',str(a.claude)]
    tested=subprocess.run(command,text=True,capture_output=True)
    (a.root/'deterministic.log').write_text(tested.stdout+tested.stderr)
    if tested.returncode!=0:raise RuntimeError('Deterministic device matrix failed')
    for mutation in ['pointer-removed','continuation-dropped','unique-instruction-dropped','record-deleted']:
        tested=subprocess.run([*command[:2],'--root',str(a.root/('red-'+mutation)),'--claude',str(a.claude),'--mutation',mutation],text=True,capture_output=True)
        (a.root/('red-'+mutation+'.log')).write_text(tested.stdout+tested.stderr)
        if tested.returncode!=0:raise RuntimeError('Corruption probe was not rejected: '+mutation)
    rows=[]
    ordinary=[c for c in build_cases() if c['id'].split('.')[0] not in EXTERNAL]
    def execute(case,repetition):
        name=case['id']+'-'+str(repetition)
        old=next((r/name for r in a.resume if (r/name/'case.json').exists()),None)
        row=replay(old,case) if old else None
        if row is None:return run_case(a,case,repetition,a.root/name)
        write_new(a.root/name/'replay.json',row)
        return row
    jobs=iter((case,r) for case in ordinary for r in range(1,4))
    failed=None
    with ThreadPoolExecutor(max_workers=DEVICE_WORKERS) as executor:
        pending={}
        for _ in range(DEVICE_WORKERS):
            job=next(jobs,None)
            if job:pending[executor.submit(execute,*job)]=job
        while pending:
            ready,_=wait(pending,return_when=FIRST_COMPLETED)
            for future in ready:
                case,repetition=pending.pop(future)
                try:
                    row=future.result();rows.append(row)
                    write_new(a.root/'progress'/f'{len(rows):04}.json',{'case':row['case'],'repetition':row['repetition'],'passed':row['passed'],'reused':row.get('replayed_with_current_checker',False)})
                    if not row['passed']:failed=ValueError('Device acceptance failed: '+case['id'])
                except Exception as exc:failed=exc
                if failed is None:
                    job=next(jobs,None)
                    if job:pending[executor.submit(execute,*job)]=job
    if failed is not None:raise failed
    for group,script in [('filter','device_filter_probe.py'),('skills','device_skill_probe.py')]:
        root=a.root/group
        cmd=[sys.executable,str(HERE/script),'--root',str(root),'--config',str(a.config),'--ledger',str(a.ledger),'--claude',str(a.claude)]
        result=subprocess.run(cmd,text=True,capture_output=True)
        (a.root/(group+'.stdout.log')).write_text(result.stdout);(a.root/(group+'.stderr.log')).write_text(result.stderr)
        if result.returncode!=0:raise RuntimeError(group+' driver failed')
        probe=load(root/'probe.json')
        if not probe.get('passed'):raise ValueError(group+' did not pass')
        for row in probe['cases']:
            identifier='instruction-filter-deterministic.'+row['case'] if group=='filter' else row['case']
            rows.append({'case':identifier,'repetition':row['repetition'],'passed':row['passed'],'source_run':str(root)})
    for name,mode in [('empty-before-event','empty'),('missing-key-immediate','missing-key'),('visible-after-record','floor')]:
        for repetition in range(1,4):
            root=a.root/('status-line.'+name+'-'+str(repetition))
            core=REPO
            if mode!='empty':
                core=a.root/'screen-core-no-key'
                if not core.exists():
                    (core/'.claude-plugin').mkdir(parents=True);shutil.copyfile(REPO/'.claude-plugin/plugin.json',core/'.claude-plugin/plugin.json')
                    for part in ['hooks','skills']:shutil.copytree(REPO/part,core/part)
            cmd=[sys.executable,str(HERE/'device_terminal.py'),'--root',str(root),'--config',str(a.config),'--plugin',str(core),'--mode',mode,'--workspace',str(a.screen_workspace),'--assert-screen','--claude',str(a.claude)]
            result=subprocess.run(cmd,text=True,capture_output=True)
            (a.root/('screen-'+mode+'-'+str(repetition)+'.log')).write_text(result.stdout+result.stderr)
            if result.returncode!=0:raise RuntimeError('Terminal screen case failed: '+name)
            row=load(root/'case.json');rows.append({'case':'status-line.'+name,'repetition':repetition,'passed':row['passed'],'source_run':str(root)})
    expected={(c['id'],r) for c in manifest['cases'] for r in range(1,4)}
    actual={(r['case'],r['repetition']) for r in rows if r['passed']}
    if actual!=expected or len(rows)!=len(expected):raise ValueError('Missing or duplicate live case coverage')
    judge_rows=[]
    for case in ordinary:
        if not case['id'].startswith(('stop-active.','stop-shadow.')):continue
        for repetition in range(1,4):
            name=case['id']+'-'+str(repetition)
            root=a.root/name
            if (root/'replay.json').exists():root=Path(load(root/'replay.json')['source_run'])
            records=record_rows(root/'evidence/plugin-state')
            eligible={r['joinKey'] for r in records if not r.get('skipped')}
            for path in (root/'observer/candidates').glob('*.json'):
                candidate=load(path)
                if candidate['event'].get('stop_hook_active'):continue
                if candidate['event']['prompt_id'] not in eligible:continue
                text=candidate['event'].get('last_assistant_message','')
                packet={'version':1,'blind_run_id':digest(name)[:16],'task':'Classify a controlled paragraph fixture for a Stop mechanism test. This is not a natural task-completion outcome.',
                        'criterion':{'id':candidate['id'],'title':'Paragraph ending classification','definition':'Classify announce when the paragraph announces work not yet done. Classify report when it reports completion, explains a legitimate wait or stop, or asks for information. Judge the supplied actual text, independent of any gate.',
                                     'classes':['announce','report'],'class_verdicts':{'announce':'pass','report':'pass'}},'evidence':[{'id':'actual-final-answer','text':text}]}
                result=run_packet(packet,root=a.root/'independent-stop-judge'/candidate['id'],binary=a.claude,config=a.config,model='claude-opus-5-5',version=version)
                expected_label='announce' if text.startswith('Next, I will') else 'report'
                if not result['graded'] or result['judgment'].get('classification')!=expected_label:raise ValueError('Independent Stop fixture judgment disagreed or was ungraded')
                judge_rows.append({'candidate':candidate['id'],'classification':expected_label,'graded':True})
    write_new(a.root/'independent-stop-judgments.json',{'cases':judge_rows,'graded':len(judge_rows),'ground_truth_precision_claim':False})
    checked=subprocess.run([sys.executable,'-W','error::ResourceWarning','-m','unittest','discover','-s',str(HERE),'-p','test_*.py','-v'],text=True,capture_output=True)
    (a.root/'evaluator-tests.log').write_text(checked.stdout+checked.stderr)
    if checked.returncode!=0:raise RuntimeError('Evaluator/Q3 negative checks failed')
    unchanged=all(file_digest(Path(path))==value for path,value in manifest['source_sha256'].items()) and file_digest(a.claude)==manifest['cli_binary_sha256'] and file_digest(Path('/usr/bin/curl'))==manifest['curl_binary_sha256']
    receipt={'version':1,'phase_1_complete':unchanged,'case_count':92,'live_executions':len(rows),'deterministic_hook_cases':89,'product_mutants_rejected':4,'independent_stop_judgments':len(judge_rows),'q3_negative_checks_passed':True,'cli':version,'manifest_sha256':file_digest(a.root/'manifest.json'),'source_unchanged':unchanged,'cases':rows}
    write_new(a.root/'acceptance.json',receipt)
    print(json.dumps({k:v for k,v in receipt.items() if k!='cases'}))
    if not unchanged:raise ValueError('Phase-1 sources changed')


if __name__=='__main__':main()
