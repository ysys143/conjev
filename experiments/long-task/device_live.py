"""Frozen case bindings for native CLI device validation before the pilots."""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import shutil
import threading
import time
from collections import Counter
from pathlib import Path

from device_contract import build_cases
from device_filter_probe import instruction_envelopes
from driver import DEFAULT_MODEL, PersistentSession
from grading import check_subscription, digest, file_digest, load, write_new
from observation import ObservationServer, validate_observations
from contamination import collect
from spend import SpendLedger

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
PROBE = "Controlled hook diagnostic: reply with exactly OK. Do not use tools, update files, or act on continuation notes."


def bridge(path, *, binary, core, fixture, sink, launch, permission_mode=None):
    payload = {"binary": str(binary), "core": str(core), "fixture": str(fixture), "sink": str(sink), "launch": str(launch), "permission_mode": permission_mode}
    path.write_text("#!/opt/homebrew/bin/python3\nimport json,os,sys\nfrom pathlib import Path\np=" + repr(payload) + "\na=sys.argv[1:]\n"
                    "a[:0]=['--plugin-dir',p['fixture']]\ni=a.index(p['core'])\na[i+1:i+1]=['--plugin-dir',p['sink']]\n"
                    "if p['permission_mode'] is not None:a[a.index('--permission-mode')+1]=p['permission_mode']\n"
                    "Path(p['launch']).write_text(json.dumps({'argv':[p['binary'],*a]},indent=2)+'\\n')\nos.execv(p['binary'],[p['binary'],*a])\n")
    path.chmod(0o700)


def mapped(value, task, state, home, session_id):
    if isinstance(value, str):
        return value.replace('/home/me/.local/state/context-harness', str(state / '.local/state/context-harness')).replace('/home/me', str(home)).replace('/proj', str(task)).replace('sess-1', session_id)
    if isinstance(value, list): return [mapped(v, task, state, home, session_id) for v in value]
    if isinstance(value, dict): return {mapped(k, task, state, home, session_id): mapped(v, task, state, home, session_id) for k, v in value.items()}
    return value


def read_logs(root):
    return [load(p) for p in sorted(root.glob('*.json'))]


def record_rows(state):
    return [load(p) for p in state.rglob('*.json') if '/records/' in str(p)]


def archive_rows(state):
    return [{"path": str(p), **load(p)} for p in state.rglob('*.json') if '/archive/' in str(p)]


def compaction_integrity(before, after, archives):
    if len(before) != len(after): return False
    by_id = {a['id']: a for a in archives}
    for old, new in zip(before, after):
        if {k:v for k,v in old.items() if k!='toolResults'} != {k:v for k,v in new.items() if k!='toolResults'}: return False
        a, b = old.get('toolResults', []), new.get('toolResults', [])
        if len(a) != len(b): return False
        for original, replacement in zip(a,b):
            identifier = original['tool_use_id']
            kept = by_id.get(identifier)
            if original == replacement:
                if kept:return False
                continue
            if not kept or kept['text'] != original['text']: return False
            if {k:v for k,v in original.items() if k!='text'} != {k:v for k,v in replacement.items() if k!='text'}: return False
            if not replacement['text'].startswith('[folded ') or not replacement['text'].endswith(f'read_coordinate("{identifier}")]'): return False
    return True


def checks_for(case, logs, records, archives, lifecycle, observer, stage_rows):
    identifier, name = case['id'], case['id'].split('.',1)[1]
    family = identifier.split('.',1)[0]
    checks = {'fixture_input_observed':any(r['kind']==('stop-input' if family.startswith('stop-') else 'command-complete') for r in logs)}
    compacts = [r['value'] for r in logs if r['kind']=='compact-input']
    results = [r['value'] for r in logs if r['kind']=='compact-result']
    summaries = [r['value'] for r in logs if r['kind']=='summary-input']
    appended = [e for e in lifecycle if e.get('name')=='session-appended' and any(b.get('type')=='text' and b.get('text','').startswith('[context-harness]') for b in e.get('message',{}).get('content',[]) if isinstance(b,dict))]
    notes = json.dumps(appended)
    responses = [r['value'] for r in logs if r['kind']=='jev-response']
    tools = [r['value'] for r in logs if r['kind']=='tool-result']
    if family in ['post-compact-note','project-reread','fold-shadow'] or identifier=='fold-other-paths.nothing-eligible-summary' or identifier in ['conditional-instructions.reattach-after-summary','conditional-instructions.no-reattach-after-fold-only']:
        checks['actual_compaction_completed'] = bool(results) and all('messages' in r and 'skip' not in r for r in results) and any(e.get('name')=='compact-after' for e in lifecycle)
    if family in ['fold-ordinary','fold-other-paths','archive-storage','automatic-compact','consolidation','post-compact-note','project-reread','read-coordinate']:
        checks['no_judgment_records'] = not records
    if family == 'fold-ordinary':
        folds = int(name=='eligible-old-large')
        checks.update(exact_archive_count=len(archives)==folds, summary_path=len(summaries)==(0 if folds else 1))
    elif family == 'fold-other-paths':
        expected = 1 if name in ['folded-still-large-summary','second-fold-only-new'] else 0
        checks['exact_archive_count'] = len(archives)==expected
        checks['summary_path'] = bool(summaries) == (name!='second-fold-only-new')
        if name=='second-fold-only-new': checks['only_new_archived'] = [a['id'] for a in archives]==['new']
        if name=='skipped-compaction-no-records': checks['skipped_and_no_note'] = bool(results) and 'skip' in results[-1] and not appended
    elif family == 'archive-storage':
        checks['archive_count'] = len(archives)==int(name=='private-directories-before-first-write')
        chmod = [r for r in logs if r['kind']=='process-return' and r['value']['argv'][0]=='chmod']
        writes = [r for r in logs if r['kind']=='archive-before-write']
        checks['chmod_observed'] = bool(chmod)
        if name=='private-directories-before-first-write':
            checks['chmod_before_first_write'] = bool(writes) and logs.index(chmod[0]) < logs.index(writes[0])
            checks['actual_directories_private'] = all(p.stat().st_mode & 0o777 == 0o700 for a in archives for p in [Path(a['path']).parent,Path(a['path']).parent.parent,Path(a['path']).parent.parent.parent])
        else: checks['chmod_fault_writes_nothing'] = not writes and bool(summaries)
    elif family == 'automatic-compact': checks['automatic_compaction_count'] = len(compacts)==int(name=='thresholds-met')
    elif family == 'consolidation':
        if name=='at-most-two-deferrals': checks['two_deferrals_then_fold'] = len(appended)==3 and len(compacts)==1 and 'Not written' in notes
        elif name in ['stale-phase','stale-episodes']: checks['one_deferral_no_fold'] = len(appended)==1 and not compacts and 'consolidate' in notes
        elif name=='current-files-no-request': checks['no_deferral_then_fold'] = len(compacts)==1 and sum('Before this conversation is folded' in json.dumps(n) for n in appended)==0
        else: checks['forced_no_deferral'] = len(compacts)==1 and 'Before this conversation is folded' not in notes
    elif family in ['post-compact-note','project-reread']:
        expected = name not in ['neither-no-note','no-note-no-reread-obligation']
        checks['note_delivery'] = bool(appended)==expected
        if name=='canonical-order-after-compact': checks['canonical_order'] = notes.find('INTENT.md')>=0 and notes.find('INTENT.md') < notes.find('PHASE.md')
    elif family == 'read-coordinate':
        checks['one_tool_result'] = len(tools)==1
        raw = tools[0]['result'] if tools else {}
        if name in ['exact-original','offset-and-limit-beyond-400']:
            expected = next(r['where']['result'] for r in case['assertions'] if r.get('where',{}).get('result'))
            checks['exact_requested_lines'] = raw.get('result')==expected
        else:
            requested=next(s['input']['id'] for s in case['steps'] if s['event']=='tool.call')
            checks['explicit_error_no_foreign_original'] = raw.get('deny')==f'No folded result is kept under "{requested}".' and 'FOREIGN-CONTROL' not in json.dumps(raw)
            calls,model_results=collect([message for body in stage_rows for message in body.get('messages',[])])
            matching=[c for c in calls if c['name']=='mcp__context-harness__read_coordinate' and c['input'].get('id')==requested]
            checks['actual_model_error_flag']=len(matching)==1 and any(r.get('is_error') is True for r in model_results.get(matching[0]['id'],[]))
    elif family in ['stop-active','stop-shadow']:
        candidates = [load(p) for p in sorted((observer.store/'candidates').glob('*.json'))]
        decisions = [load(p) for p in sorted((observer.store/'decisions').glob('*.json'))]
        blocked = [d for d in decisions if 'block' in d['result']]
        firsts = [c for c in candidates if c['ordinal']==1]
        text = case['steps'][0]['input']['last_assistant_message']
        checks['all_stimuli_matched'] = bool(firsts) and all(c['event'].get('last_assistant_message','').strip()==text for c in firsts)
        if name=='plan-mode-skip':
            checks['native_plan_mode_observed'] = bool(firsts) and all(c['event'].get('permission_mode')=='plan' for c in firsts)
        if name=='announce-retry-once':
            checks['one_block_one_reentry'] = len(blocked)==1 and len(candidates)==2 and sum(c.get('continuation_of') is not None for c in candidates)==1
            checks['one_continue_one_skip_record'] = len(records)==2 and sum(r.get('decision')=='continue' for r in records)==1 and sum(r.get('skipped')=='stop-hook-active' for r in records)==1
        elif 'underlying' in name:
            checks['underlying_block_wins'] = len(blocked)==1 and blocked[0]['result']['block']=='Evaluator underlying Stop block'
            initial_join={c['event']['prompt_id'] for c in firsts}
            checks['no_product_record_for_underlying_block'] = not any(r.get('joinKey') in initial_join and not r.get('skipped') for r in records)
            checks['no_jev'] = not responses
            checks['one_reentry_skip_record'] = len(records)==1 and records[0].get('skipped')=='stop-hook-active'
        else:
            checks['not_blocked'] = not blocked
            if family=='stop-shadow' and name=='eligible-record-and-delayed-judgment': checks['shadow_result_recorded'] = len(records)==1 and records[0].get('decision') in ['stop','would-continue'] and 'jev' in records[0]
            else:
                expected_rule = next((r for r in case.get('assertions',[]) if r['source']=='records' and not r.get('where')),None)
                if expected_rule: checks['exact_stop_record_count'] = len(records)==expected_rule['count']
                for r in case.get('assertions',[]):
                    if r['source']=='records' and r.get('where'):
                        checks['record_fields_'+digest(r)[:8]] = sum(all(row.get(k)==v for k,v in r['where'].items()) for row in records)==r['count']
        if name in ['completed-report-allowed','approval-or-input-wait','explicit-user-stop']: checks['real_report_judgment_below_threshold'] = bool(records) and records[0].get('jev',1)<0.7
    elif family == 'tool-floor':
        denied = name in ['external-secret-file-denied','external-secret-print-denied','external-direct-archive-denied','first-party-protected-write-denied']
        checks['one_actual_tool_result'] = len(tools)==1
        raw = tools[0]['result'] if tools else {}
        checks['expected_tool_decision'] = bool(raw.get('deny'))==denied
        if not denied:checks['actual_control_file_read']=raw.get('isError') is not True and 'DEVICE-NATIVE-READ-CONTROL' in json.dumps(raw)
        expected = 0 if name=='ordinary-file-allowed' else 1
        checks['exact_floor_record_count'] = len(records)==expected
        checks['no_jev_call'] = not responses
    elif family == 'tool-jev':
        external = name!='first-party-no-call'
        denied = name=='external-restricted-denied'
        checks['actual_tool_decision'] = all(bool(t['result'].get('deny'))==denied for t in tools)
        checks['expected_call_and_record_count'] = len(responses)==int(external) and len(records)==int(external)
        if external: checks['real_judgment_has_usage'] = bool(responses) and bool(records) and 'usage' in responses[0]['response'] and 'jev' in records[0]
        if external:
            p=responses[0]['response'].get('answers',{}).get('data',{}).get('probabilities',{}) if responses else {}
            checks['risk_matches_actual_answer']=bool(records) and bool(p) and abs(records[0].get('jev',-1)-p.get('restricted',0)-p.get('custom',0))<1e-12
    elif family == 'fold-shadow':
        quiet = name in ['missing-key-no-call','no-person-prompt-no-call']
        checks['sample_count'] = len(records)==(0 if quiet else 48)
        if not quiet:
            checks['independent_sample_ids'] = {r.get('joinKey') for r in records}=={*[f't{i}' for i in range(13,60)],'kept-error'}
            archived={a['id'] for a in archives}
            checks['heuristic_matches_actual_archive'] = all(r['heuristic']==(r['joinKey'] in archived) for r in records)
            if name=='failed-call-error-no-probability': checks['all_errors_without_probability'] = all(r.get('error')=='http 503' and 'jev' not in r for r in records)
            else:
                checks['two_real_batches_and_probabilities'] = len(responses)==2 and all('jev' in r for r in records)
                ordered=sorted([('t'+str(i),500+37*i) for i in range(60)]+[('kept-error',1500)],key=lambda pair:-pair[1])[:48]
                probabilities={}
                for batch,response in enumerate(responses):
                    for index in range(24):
                        answer=response['response'].get('answers',{}).get('r'+str(index),{})
                        needed=answer.get('probabilities',{}).get('needed')
                        if needed is not None:probabilities[ordered[batch*24+index][0]]=1-needed
                checks['probability_matches_its_originating_answer']=len(probabilities)==48 and all(abs(row.get('jev',-1)-probabilities.get(row['joinKey'],2))<1e-12 for row in records)
        else: checks['no_call'] = not responses
    elif family == 'conditional-instructions':
        chunks = [r for r in records if r.get('point')=='instructions']
        wire = stage_rows
        blocks = [text for body in wire for message in body.get('messages',[]) for text in [json.dumps(message)] if '<instruction name=' in text]
        if name=='pinned-in-system':
            checks['pinned_on_wire'] = any('PINNED-CONTROL-MARKER' in json.dumps(body) for body in wire)
            checks['no_conditional_records'] = not chunks
        elif name=='nonmatch-no-attach':
            checks['one_skip_no_attachment'] = len(chunks)==1 and chunks[0].get('decision')=='skip' and not blocks
        else:
            expected=2 if name=='reattach-after-summary' else 1
            checks['attach_once_per_conversation'] = len(chunks)==expected and all(r.get('decision')=='attach' for r in chunks)
            checks['attachment_delivered_on_wire'] = bool(blocks) and all('CONDITIONAL-CONTROL' in json.dumps(r) for r in blocks)
            if name=='keyword-attach-once': checks['keyword_no_jev'] = not responses
            else: checks['semantic_service_exercised'] = len(responses)==expected
    elif family in ['instruction-filter-jev','instruction-filter-deferred']:
        delivered=[r['value'] for r in logs if r['kind']=='instruction-delivered']
        inputs=[r['value']['files'] for r in logs if r['kind']=='instruction-input']
        checks['shadow_preserves_all_files'] = bool(inputs) and delivered==inputs
        chunks=[r for r in records if r.get('point')=='instr-filter' and r.get('decision')!='sent']
        deferred=[r for r in records if r.get('point')=='instr-defer']
        used=[r for r in records if r.get('point')=='instr-tool']
        if family=='instruction-filter-jev':
            checks['chunk_count'] = len(chunks)==4
            checks['scope_and_cover_recorded'] = len([r for r in records if r.get('decision')=='sent'])==2
            checks['always_kept_stays'] = any(r.get('facts',{}).get('heading')=='## Language' and r.get('decision')=='would-keep' for r in chunks)
            checks['all_readings_have_fields'] = all(all(k in r.get('facts',{}) for k in ['conditional','covered','reason']) for r in chunks)
            scopes=[r for r in responses if r['request'].get('questions') and all(re.fullmatch(r's\d+',k) for k in r['request']['questions'])]
            covers=[r for r in responses if r['request'].get('questions') and all(re.fullmatch(r'c\d+',k) for k in r['request']['questions'])]
            deferred_calls=[r for r in responses if r['request'].get('questions') and all(re.fullmatch(r'd\d+',k) for k in r['request']['questions'])]
            deferred_records=[r for r in records if r.get('point')=='instr-defer']
            checks['real_service_calls'] = len(scopes)==1 and len(covers)==1
            checks['all_service_calls_accounted'] = len(responses)==len(scopes)+len(covers)+len(deferred_calls)
            checks['deferred_calls_reconciled'] = len(deferred_records)==sum(len(r['request']['questions']) for r in deferred_calls) and all(any(r.get('sent')==call['request'].get('state') for call in deferred_calls) for r in deferred_records)
        else:
            checks['exact_chunk_record_count'] = len(chunks)==1
            prompts=[r['value']['effective'] for r in logs if r['kind']=='prompt-input']
            def prompt_text(p):
                command=p.get('command')
                return f"/{command['name']} {command.get('args','')}" if command else p.get('text','')
            deferred_chunks=[r['joinKey'] for r in chunks if r.get('decision')=='would-defer']
            # An idle SDK prompt has no turnId by contract. Preserve an actual
            # running-turn id when present and reconcile every request by its
            # observed text, engine origin and deferred chunk, including setup.
            expected=Counter((prompt_text(p)[:600],p.get('origin',{}).get('kind','unknown'),p.get('turnId'),chunk)
                             for p in prompts if prompt_text(p).strip() and case.get('setup',{}).get('env') for chunk in deferred_chunks)
            actual=Counter((r.get('sent',{}).get('request'),r.get('facts',{}).get('origin'),r.get('joinKey'),r.get('facts',{}).get('chunk')) for r in deferred)
            checks['all_prompt_records_reconciled'] = bool(prompts) and expected==actual
            targeted=[r for r in deferred if r.get('sent',{}).get('request')!=PROBE]
            requests=2 if name=='each-request' else int(name=='slash-command-origin')
            checks['deferred_use_count'] = len(targeted)==requests
            checks['turn_origin_and_decision_present'] = all(r.get('decision') in ['would-attach','skip'] and 'jev' in r for r in deferred)
            if name=='slash-command-origin':checks['native_slash_command_observed'] = any(p.get('command',{}).get('name')=='device-fixture:diagnostic' for p in prompts)
            if name=='empty-request-no-record':checks['empty_request_observed'] = any(not prompt_text(p).strip() for p in prompts)
            signatures={'browser-tool-kind':'browser','web-fetch-tool-kind':'web','orca-tool-kind':'orca','claude-print-tool-kind':'llm'}
            signature=signatures.get(name)
            checks['tool_kind_count'] = len(used)==int(signature is not None)
            if signature: checks['exact_tool_kind'] = bool(used) and used[0].get('facts',{}).get('signature')==signature and used[0].get('sent') is None
            if name=='none-deferred-no-record': checks['no_deferred_chunk'] = not deferred_chunks
            elif name=='missing-key-no-record':checks['no_key_observed'] = bool(chunks) and not deferred and not responses and any(r.get('facts',{}).get('jev')=='no-key' for r in chunks)
            else: checks['deferred_chunk_exercised'] = bool(deferred_chunks)
    else: raise ValueError('No live checker for '+identifier)
    # Compare the actual hook input with the transcript forwarded to the
    # engine, or installed directly by the product. Never inspect a summary
    # as if it were an unchanged transcript.
    for original in compacts:
        candidate = next((s['messages'] for s in summaries if s.get('messages') and s['messages'][0]==original['messages'][0]),None)
        if candidate is None:
            candidate = next((r['messages'] for r in results if 'messages' in r and len(r['messages'])==len(original['messages'])),None)
        if candidate is not None: checks['compaction_integrity_'+str(len(checks))] = compaction_integrity(original['messages'],candidate,archives)
    return checks


def run_case(args, definition, repetition, root):
    root.mkdir(parents=True, exist_ok=False)
    task, home = root/'task',root/'home'
    task.mkdir(); home.mkdir()
    logs, spec_path, state = root/'log',root/'stimulus.json',root/'evidence/plugin-state'
    spec = {'caseId':definition['id'],'productHome':str(home),'hideOrca':True}
    family,name=definition['id'].split('.',1)
    no_key = not definition.get('setup',{}).get('env')
    core=REPO
    if no_key:
        core=root/'core-no-key'; (core/'.claude-plugin').mkdir(parents=True)
        shutil.copyfile(REPO/'.claude-plugin/plugin.json',core/'.claude-plugin/plugin.json')
        for part in ['hooks','skills']:shutil.copytree(REPO/part,core/part)
    launcher=root/'claude'
    bridge(launcher,binary=args.claude,core=core,fixture=HERE/'device_fixture',sink=HERE/'device_sink',launch=root/'underlying-launch.json',permission_mode=definition.get('setup',{}).get('nativePermissionMode'))
    ledger=SpendLedger(args.ledger)
    observer=ObservationServer(task,root/'observer',ledger,root.name)
    threading.Thread(target=observer.serve_forever,daemon=True).start()
    session=None
    case=copy.deepcopy(definition)
    try:
        setup=case.get('setup',{})
        spec.update(usage={k:setup[k] for k in ['percent','window'] if k in setup},denyArchive=bool(setup.get('failWrite')),denyChmod=setup.get('failRun')=='chmod',
                    failJev=case.get('response',{}).get('http')=='error',fastTimeout=case.get('response',{}).get('http')=='timeout',skipCore=setup.get('compactBelow')=='skip')
        prepared=mapped(case,task,state,home,'pending-session')
        if family=='tool-floor' and name=='external-secret-print-denied':spec['stubTools']=['Bash']
        if family=='tool-jev':
            target=str(task/('patient_medical_records.csv' if name=='external-restricted-denied' else 'public_readme.txt'))
            for step in prepared['steps']:
                if step['event']=='tool.call':step['input']['file_path']=target
        for path,text in prepared['setup'].get('files',{}).items():
            if '/archive/' in path:continue
            p=Path(path);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
        for step in prepared['steps']:
            request=step.get('input',{})
            if request.get('tool')=='Read' and str(request.get('file_path','')).startswith(str(task)+'/'):
                path=Path(request['file_path'])
                if not path.exists():path.parent.mkdir(parents=True,exist_ok=True);path.write_text('DEVICE-NATIVE-READ-CONTROL\n')
        spec['mtimes']={path:(1 if value<=2 else time.time()*1000+100000) for path,value in prepared['setup'].get('mtimes',{}).items()}
        if family=='conditional-instructions':
            fragments=Path(prepared['options']['fragmentsDir']);fragments.mkdir(parents=True,exist_ok=True)
            if name=='pinned-in-system':(fragments/'pin.md').write_text('---\npin: true\n---\nPINNED-CONTROL-MARKER\n')
            else:(fragments/'control.md').write_text('---\nwhen: The request asks about stellar spectroscopy or galaxy spectra.\nkeywords: starword\n---\nUse prefix CONDITIONAL-CONTROL in the answer.\n')
        if family in ['instruction-filter-jev','instruction-filter-deferred']:
            if family=='instruction-filter-jev':files=next(s['input']['instructionFiles'] for s in prepared['steps'] if s['event']=='prompt.context')
            elif name=='none-deferred-no-record':files=[{'path':str(task/'instructions.md'),'kind':'user','content':'## Language\n\nAnswer in the same language as the user for every request.\n'}]
            else:files=[{'path':str(task/'instructions.md'),'kind':'user','content':'## Orca work\n\nFor an Orca workspace request, inspect the workspace status before responding.\n'}]
            spec['instructions']=files
        spec_path.write_text(json.dumps(spec))
        session=PersistentSession(binary=launcher,config=args.config,model=DEFAULT_MODEL,workspace=task,evidence=root/'evidence',plugin=core,observer=observer,
            settings={'alwaysThinkingEnabled':True,'enabledPlugins':{},'env':{'CH_DEVICE_SPEC_FILE':str(spec_path),'CH_DEVICE_LOG_DIR':str(logs)},'pluginConfigs':{'context-harness@inline':{'options':prepared['options']}}})
        case=mapped(case,task,state,home,session.session_id)
        if family=='tool-jev':
            for step in case['steps']:
                if step['event']=='tool.call':step['input']['file_path']=target
        write_new(root/'mapped-definition.json',case)
        for path,text in case['setup'].get('files',{}).items():
            if '/archive/' not in path:continue
            p=Path(path);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
        steps=case['steps']
        spec_path.write_text(json.dumps(spec))
        stage=0
        def stage_call(text,model=False):
            nonlocal stage
            if model:stage+=1
            return session.stage(text,stage_id=stage if model else None,timeout=180)
        def set_spec(**values):
            spec.update(values);spec_path.write_text(json.dumps(spec))
        if family.startswith('stop-'):
            source=steps[0]['input']
            facts={k:source[k] for k in ['permission_mode','background_tasks','session_crons','stop_hook_active'] if k in source and (k!='stop_hook_active' or source[k])}
            set_spec(stopFacts=facts,stopBelowOnce='underlying' in name)
            times=4 if name=='circuit-fail-open' else 1
            for _ in range(times):stage_call('For this controlled Stop diagnostic, do not use tools. Reply with exactly this sentence: '+source['last_assistant_message'],True)
        elif family=='conditional-instructions':
            stage_call('/device')
            positive='In two sentences, explain the spectrum of a distant galaxy. No tools are needed.'
            if name=='pinned-in-system':stage_call(PROBE,True)
            else:
                text='starword: answer with a brief acknowledgement.' if name=='keyword-attach-once' else 'What is two plus two?' if name=='nonmatch-no-attach' else positive
                stage_call(text,True)
                if name in ['reattach-after-summary','no-reattach-after-fold-only']:
                    compact_step=next(s for s in steps if s['event']=='session.compact')
                    # The fold-only fixture must retain the actual attached
                    # fragment in the conversation; the native input remains
                    # the source of whether it is present after compaction.
                    transcript=copy.deepcopy(compact_step['input']['messages'])
                    if name=='no-reattach-after-fold-only':
                        transcript[0]['text']+='\n<instruction name="control" source="context-harness">\nUse prefix CONDITIONAL-CONTROL in the answer.\n</instruction>'
                    set_spec(transcript=transcript)
                    stage_call('/compact')
                if name!='nonmatch-no-attach':stage_call(text,True)
        elif family in ['instruction-filter-jev','instruction-filter-deferred']:
            stage_call('/device')
            stage_call(PROBE,True)
            deadline=time.monotonic()+35
            while time.monotonic()<deadline:
                if any(r.get('point')=='instr-filter' and r.get('decision')!='sent' for r in record_rows(state)):break
                time.sleep(.1)
            if family=='instruction-filter-deferred':
                if name=='each-request':
                    stage_call('Explain the status of this Orca workspace without using tools.',True)
                    stage_call('Explain this Orca workspace status again without using tools.',True)
                elif name=='slash-command-origin':stage_call('/device-fixture:diagnostic status',True)
                elif name in ['none-deferred-no-record','missing-key-no-record']:stage_call(PROBE,True)
                elif name=='empty-request-no-record':
                    set_spec(emptyPrompt=True);stage_call(PROBE,True)
                else:
                    tool_step=next(s for s in steps if s['event']=='tool.call')
                    tool=tool_step['input']['tool']
                    set_spec(operation='tools',tools=[tool_step['input']],stubTools=[tool])
                    stage_call('/device')
        else:
            stage_call('/device')
            for step in steps:
                event,stimulus=step['event'],step.get('input',{})
                if event=='session.start':continue
                if event=='session.compact':
                    if name=='at-most-two-deferrals':continue
                    set_spec(transcript=stimulus['messages'],operation='compact')
                    stage_call('/compact')
                    set_spec(operation='inspect');stage_call('/device')
                elif event=='tool.call':
                    set_spec(operation='tools',tools=[stimulus]);stage_call('/device')
                elif event=='turn.complete':
                    set_spec(transcript=case['setup'].get('messages',[]))
                    stage_call(PROBE,True)
                else:raise ValueError('Unsupported live stimulus '+event)
            if family in ['project-reread'] and name=='canonical-order-after-compact':
                (task/'sample.txt').write_text('Read control\n')
                stage_call('Read sample.txt and report its exact text.',True)
            elif family=='read-coordinate' and name in ['unknown-id','malformed-id','other-session-id']:
                requested=next(s['input']['id'] for s in steps if s['event']=='tool.call')
                stage_call('Call mcp__context-harness__read_coordinate with exactly this JSON input once: '+json.dumps({'id':requested})+'. Then report its error. Use no other tools.',True)
            else:
                if family in ['automatic-compact','consolidation']:set_spec(usage={'percent':0})
                stage_call(PROBE,True)
        # Device cases have a bounded 60-second reconciliation window. Close
        # once every expected record and originating service call is settled;
        # the four staged pilot runs retain the driver's full 60-second drain.
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            lifecycle=[load(p) for p in (observer.store/'events').glob('*.json')]
            outstanding=sum(e['kind']=='jev-reserved' for e in lifecycle)-sum(e['kind']=='jev-settled' for e in lifecycle)
            if outstanding==0:break
            time.sleep(.1)
        closure=session.close(drain_seconds=2.5)
        session=None
        observed=read_logs(logs)
        records=record_rows(state);archives=archive_rows(state)
        lifecycle=[load(p) for p in (observer.store/'events').glob('*.json')]
        captures=[load(p) for p in (root/'evidence/requests').glob('*.json')]
        wire=[json.loads(r['request_body']) for r in captures if r.get('path','').split('?',1)[0]=='/v1/messages']
        checks=checks_for(case,observed,records,archives,lifecycle,observer,wire)
        checks['actual_executor_settings']=bool(wire) and all(b.get('model')==DEFAULT_MODEL and b.get('output_config',{}).get('effort')=='max' and b.get('thinking',{}).get('type')=='adaptive' for b in wire)
        checks['clean_close']=closure['runner_observed_end'] and closure['evidence_complete']
        checks['observer_complete']=validate_observations(observer.store)['complete']
        checks['no_observer_errors']=not observer.errors
        # A missing artifact cannot turn a legitimate zero into a pass. Also
        # require every semantic/content checker to reject an empty evidence set.
        checks['empty_evidence_rejected']=not all(checks_for(case,[],[],[],[],observer,[]).values())
        damaged=records[1:] if records else [{'point':'instructions' if family=='conditional-instructions' else 'instr-defer' if family=='instruction-filter-deferred' else 'stop','decision':'unexpected'}]
        try:checks['record_loss_or_unexpected_record_rejected']=not all(checks_for(case,observed,damaged,archives,lifecycle,observer,wire).values())
        except (KeyError,ValueError,IndexError):checks['record_loss_or_unexpected_record_rejected']=True
        corrupted=copy.deepcopy(observed)
        removed=False
        for entry in corrupted:
            if entry['kind'] in ['compact-result','summary-input']:
                for message in entry.get('value',{}).get('messages',[]):
                    for result in message.get('toolResults',[]):
                        if result.get('text','').startswith('[folded '):result['text']='REMOVED POINTER';removed=True
        if removed:checks['removed_pointer_rejected']=not all(checks_for(case,corrupted,records,archives,lifecycle,observer,wire).values())
        row={'case':case['id'],'repetition':repetition,'checks':checks,'passed':all(checks.values()),'closure':closure,'records':len(records),'archives':len(archives),
             'frozen_definition_sha256':digest(definition),'synthetic_stimulus':True,'phase_1_complete':False}
        row['artifacts']={p.relative_to(root).as_posix():file_digest(p) for p in root.rglob('*') if p.is_file()}
        write_new(root/'case.json',row)
        return row
    except BaseException as exc:
        if session is not None:session.abort()
        write_new(root/'error.json',{'error':type(exc).__name__,'message':str(exc),'observer_errors':observer.errors})
        raise
    finally:
        observer.shutdown();observer.server_close()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,required=True);p.add_argument('--config',type=Path,required=True);p.add_argument('--ledger',type=Path,required=True)
    p.add_argument('--cases',nargs='+',required=True);p.add_argument('--repetitions',type=int,default=3)
    p.add_argument('--claude',type=Path,default=Path.home()/'.local/share/claude/versions/2.1.309')
    args=p.parse_args();version=check_subscription(args.claude,args.config)
    args.root.mkdir(parents=True,exist_ok=False,mode=0o700)
    cases={c['id']:c for c in build_cases()}
    chosen=[cases[name] for name in args.cases]
    paths=[Path(__file__),HERE/'device_contract.py',HERE/'device_fixture/hooks/register.ts',HERE/'device_sink/hooks/register.ts',*(REPO/'hooks').glob('*.ts')]
    identity={str(path):file_digest(path) for path in paths}
    write_new(args.root/'frozen-manifest.json',{'version':1,'cli':version,'cases':chosen,'minimum_live':3,'source_sha256':identity,'before_execution':True})
    results=[]
    for case in chosen:
        for repetition in range(1,args.repetitions+1):
            row=run_case(args,case,repetition,args.root/(case['id']+'-'+str(repetition)))
            results.append(row)
            if not row['passed']:raise ValueError('Device case failed: '+case['id'])
            if any(file_digest(Path(path))!=value for path,value in identity.items()):raise ValueError('Device execution source changed')
    write_new(args.root/'results.json',{'cases':results,'all_selected_passed':all(r['passed'] for r in results),'phase_1_complete':False})
    print(json.dumps({'cases':len(chosen),'executions':len(results),'all_selected_passed':True,'phase_1_complete':False}))


if __name__=='__main__':main()
