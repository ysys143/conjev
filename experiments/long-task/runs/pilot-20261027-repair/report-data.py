"""Collect accepted fresh-pilot numbers and keep historical attempts separate."""
import json
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

REPO = Path('/Users/jaesolshin/Documents/GitHub/context-harness')
HERE = REPO / 'experiments/long-task'
sys.path.insert(0, str(HERE))
from grading import file_digest, load, write_new
from spend import SpendLedger

root = Path('/private/tmp/ch-research-pilot-scoring-20261027-1')
execution_root = Path('/private/tmp/ch-research-pilot-20261027-2')
run = HERE / 'runs/pilot-20261027-2'
acceptance = load(run / 'acceptance-final.json')
if acceptance.get('pilot_complete') is not True:
    raise ValueError('The pilot has not passed the raw-evidence audit')
scoring = load(root / 'scoring-manifest.json')
environment = load(root / 'environment-audit-manifest.json')
scores = {row['arm']: row for row in load(root / environment['pilot_scores'])['runs']}
actors = {}


def usage(rows):
    return {'input_tokens': sum(sum((r.get('usage') or {}).get(k, 0) for k in ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) for r in rows),
            'output_tokens': sum((r.get('usage') or {}).get('output_tokens', 0) for r in rows),
            'captured_requests': len(rows), 'incomplete_requests': sum(r.get('complete') is not True for r in rows)}


def meter(record, path):
    h = {k.lower(): v for k, v in record.get('response_headers', {}).items()}
    return {'source': str(path), 'sha256': file_digest(path), 'observed_at': record['ended_at'],
            'status': h.get('anthropic-ratelimit-unified-status'),
            'five_hour_utilization': h.get('anthropic-ratelimit-unified-5h-utilization'),
            'five_hour_reset': h.get('anthropic-ratelimit-unified-5h-reset'),
            'weekly_utilization': h.get('anthropic-ratelimit-unified-7d-utilization'),
            'weekly_reset': h.get('anthropic-ratelimit-unified-7d-reset')}


all_model_paths = []
for arm in ['V', 'H', 'S1', 'S0']:
    target = root / arm
    result = load(target / 'run-result.json')
    paths = list((target / 'evidence/requests').glob('*.json'))
    captures = [load(p) for p in paths]
    model_rows = [r for r in captures if r.get('path', '').split('?', 1)[0] == '/v1/messages']
    all_model_paths.extend(p for p, record in zip(paths, captures) if record in model_rows)
    restatement = load(target / scoring['restatement_scores'])
    actors[arm] = {'result': result, 'scores': scores[arm], 'usage': usage(captures),
                   'model_requests': len(model_rows), 'completed_stages_v1': load(execution_root / arm / 'run-result.json')['completed_stages'],
                   'verification_changes': [r['stage'] for r in load(target / 'rescore-provenance.json')['changes']], 'environment_audit': load(target / environment['audit_file']),
                   'connections': len({r.get('upstream_connection_id') for r in model_rows}),
                   'connection_reuses': sum(r.get('upstream_connection_reused') is True for r in model_rows),
                   'restatement_passed': sum(r['judgment']['verdict'] == 'pass' for r in restatement['criteria']),
                   'restatement_graded': restatement['graded'], 'restatement_expected': restatement['expected'],
                   'clarification_replies': len(list((target / 'observer/clarifications').glob('*.json')))}
history = []
for name, arm in [('pilot-20261026-1', 'V'), ('pilot-20261026-2', 'V'), ('pilot-20261026-2', 'H'),
                  ('pilot-20261026-2', 'S1'), ('pilot-20261026-2', 'S0'), ('pilot-20261027-1', 'V')]:
    target = Path('/private/tmp/ch-research-' + name) / arm
    captures = [load(p) for p in (target / 'evidence/requests').glob('*.json')]
    history.append({'attempt': name, 'arm': arm, 'usage': usage(captures), 'included_in_fresh_pair_estimates': False})
ledger = HERE / 'runs/study-spend.sqlite3'
with closing(sqlite3.connect(ledger)) as db:
    jev = [{'run': name, 'calls': count, 'known_spend_usd': known / 1e9,
            'unknown_calls': unknown, 'unknown_reserved_usd': reserved / 1e9, 'models': models}
           for name, count, known, unknown, reserved, models in db.execute(
               'SELECT run,count(*),coalesce(sum(charged_nano),0),sum(charged_nano IS NULL),'
               'coalesce(sum(CASE WHEN charged_nano IS NULL THEN reserved_nano ELSE 0 END),0),group_concat(DISTINCT model) '
               'FROM calls WHERE run LIKE ? GROUP BY run', (execution_root.name + '-%',))]
ordered = sorted(((load(p), p) for p in all_model_paths), key=lambda row: row[0]['started_at'])
first_record, first_path = ordered[0]
last_record, last_path = max(ordered, key=lambda row: row[0]['ended_at'])
execution_job = load(run / 'job.json')
before_candidates = []
for path in Path('/private/tmp/ch-research-phase1-20261027-5').rglob('requests/*.json'):
    record = load(path)
    headers = {k.lower(): v for k, v in record.get('response_headers', {}).items()}
    if record.get('ended_at', float('inf')) <= execution_job['started_at'] and 'anthropic-ratelimit-unified-status' in headers:
        before_candidates.append((record, path))
if not before_candidates:
    raise ValueError('A genuine pre-pilot account meter is missing')
before_record, before_path = max(before_candidates, key=lambda row: row[0]['ended_at'])
judge_paths = [p for arm in ['V','H','S1','S0'] for group in ['semantic-judge','restatement-judge','restatement-judge-full-evidence']
               for p in (root / arm / group).rglob('requests/*.json')]
judge_captures = [load(p) for p in judge_paths]

data = {'version': 1, 'pilot_complete': True, 'spec': load(root / 'pilot-spec.json'), 'actors': actors,
        'execution_job': execution_job, 'grading_job': load(run / 'scoring-v2-job.json'),
        'acceptance': acceptance, 'historical_attempts': history,
        'fresh_known_usage': {k: sum(row['usage'][k] for row in actors.values()) for k in ['input_tokens', 'output_tokens', 'captured_requests', 'incomplete_requests']},
        'jev_pilot': jev, 'jev_global': SpendLedger(ledger).summary(),
        'judge_known_usage': usage(judge_captures),
        'judge_packets': sum(len(list((root / arm / group).rglob('packet.json'))) for arm in ['V','H','S1','S0'] for group in ['semantic-judge','restatement-judge','restatement-judge-full-evidence']),
        'account_meters': {'before': meter(before_record, before_path), 'first_executor_response': meter(first_record, first_path), 'after': meter(last_record, last_path),
                          'attribution': 'Shared account meters; no difference is attributed to this study.'},
        'Q1': {'valid_pairs': 1, 'completed_stage_difference_H_minus_V': actors['H']['result']['completed_stages'] - actors['V']['result']['completed_stages'],
               'goal_failure_difference_H_minus_V': actors['H']['result']['goal_failures'] - actors['V']['result']['goal_failures']},
        'Q3': {'valid_pairs': 1, 'completed_stage_difference_S1_minus_S0': actors['S1']['result']['completed_stages'] - actors['S0']['result']['completed_stages'],
               'goal_failure_difference_S1_minus_S0': actors['S1']['result']['goal_failures'] - actors['S0']['result']['goal_failures']},
        'main_runs': 0}
write_new(run / 'report-data.json', data)
print(json.dumps({'pilot_complete': True, 'valid_pairs': acceptance['valid_pairs'], 'fresh_usage': data['fresh_known_usage'], 'jev_global': data['jev_global']}))
