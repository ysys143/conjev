"""Audit the fresh pilot's completion from original artifacts, not job exit alone."""
import argparse
import json
import sys
from pathlib import Path

REPO = Path('/Users/jaesolshin/Documents/GitHub/context-harness')
sys.path.insert(0, str(REPO / 'experiments/long-task'))
from grading import digest, file_digest, load, write_new
from observation import validate_observations
from task_generator import make_case
from contamination import Scope, captured_calls
from scratch_audit import audit_with_creation
import re


def inspect(root):
    spec = load(root / 'pilot-spec.json')
    scoring = load(root / 'scoring-manifest.json')
    environment = load(root / 'environment-audit-manifest.json')
    scores = load(root / environment['pilot_scores'])
    summaries = {row['arm']: row for row in scores['runs']}
    order = [arm for pair in spec['order'] for arm in pair]
    checks = {'fresh_four_condition_order': order == ['V', 'H', 'S1', 'S0'],
              'new_shared_specification': spec['version'] == 4 and spec['ceilings']['input_tokens'] == 30_000_000
                                          and spec['ceilings']['output_tokens'] == 1_000_000,
              'all_execution_sources_unchanged': all(file_digest(Path(p)) == expected for p, expected in spec['source_sha256'].items()),
              'task_case_unchanged': spec['task_identity'] == make_case(spec['family'], spec['seed']).identity,
              'all_four_summaries': len(scores['runs']) == 4 and set(summaries) == set(order),
              'scorer_declares_complete': scores.get('scoring_complete') is True}
    checks['verification_revision_is_explicit'] = spec.get('verification_revision') == scores.get('verification_revision') == 2
    execution_root = Path(spec['original_execution_root'])
    checks['original_execution_spec_bound'] = file_digest(execution_root / 'pilot-spec.json') == spec['original_spec_sha256']
    grading_sources = load(root / 'grading-source-before.json')
    checks['grading_sources_unchanged'] = all(file_digest(Path(p)) == expected for p, expected in grading_sources.items())
    checks['full_instruction_evidence_versioned'] = scoring.get('restatement_evidence_revision') == scores.get('restatement_evidence_revision') == 2
    checks['restatement_completion_sources_unchanged'] = all(file_digest(Path(p)) == expected for p, expected in load(root / scoring['source_before']).items())
    checks['environment_audit_versioned_and_source_bound'] = environment['revision'] == 2 and all(file_digest(Path(p)) == expected for p, expected in load(root / environment['source_before']).items())
    arms = {}
    for arm in order:
        run = root / arm
        result = load(run / 'run-result.json')
        stage_scores = load(run / 'stage-scores.json')['stages']
        stop = load(run / 'stop-judgments.json')
        restatement = load(run / scoring['restatement_scores'])
        summary = summaries[arm]
        captures = [load(p) for p in (run / 'evidence/requests').glob('*.json')]
        starts = {p.stem for p in (run / 'evidence/requests/started').glob('*.json')}
        messages = [r for r in captures if r.get('path', '').split('?', 1)[0] == '/v1/messages']
        bodies = [json.loads(r['request_body']) for r in messages]
        census = validate_observations(run / 'observer')
        task_candidates = {identifier for stage in range(1, 13)
                           for identifier in load(run / 'observer/stages' / f'{stage:02}.json')['candidate_ids']}
        closure = load(run / 'closure.json')
        environment_result = load(run / environment['audit_file'])
        stage_numbers = {int(p.stem) for p in (run / 'stages').glob('*.json')}
        row = {'twelve_stage_receipts': stage_numbers == set(range(1, 13)),
               'twelve_stage_scores': len(stage_scores) == 12 and all(s['complete'] for s in stage_scores),
               'run_result_bound_to_case': result['arm'] == arm and result['task_identity'] == spec['task_identity']
                                           and result['stage_count'] == 12 and result['scores_complete'],
               'clean_closed_process': closure['runner_observed_end'] and closure['exit_code'] == 0 and closure['evidence_complete'],
               'every_request_start_has_original_capture': bool(captures) and starts == {r['id'] for r in captures},
               'every_model_capture_is_complete': bool(messages) and all(r.get('complete') is True
                     and not r.get('body_redacted') and r.get('message_stop') is True for r in messages),
               'every_upload_recorded': all(r.get('request_bytes', 0) == r.get('body_bytes_sent') > 0 for r in messages),
               'executor_wire_settings': bool(bodies) and all(b.get('model') == spec['executor_model']
                     and b.get('output_config', {}).get('effort') == spec['executor_effort']
                     and b.get('thinking', {}).get('type') == 'adaptive' for b in bodies),
               'three_exposure_boundaries': len(result['exposure']) == 3 and all(e['met'] for e in result['exposure']),
               'every_stop_candidate_graded': stop['graded'] == stop['expected'] == len(stop['candidates'])
                     and {r['candidate'] for r in stop['candidates']} == task_candidates
                     and len(task_candidates) <= census['candidates']
                     and summary['stop_stage_coverage'] == summary['stop_stages_expected'] == 12,
               'seven_restatement_criteria_graded': restatement['graded'] == restatement['expected'] == len(restatement['criteria']) == 7,
               'restatement_from_original_run': (run / 'restatement.json').is_file(),
               'no_detected_contamination': environment_result['classification'] in ['clean', 'unresolved'],
               'runtime_measured': result['task_wall_seconds'] > 0 and result['wall_seconds'] >= result['task_wall_seconds']}
        provenance = load(run / 'rescore-provenance.json')
        row['verification_source_bound'] = provenance['verification_source_sha256'] == next(
            value for path, value in grading_sources.items() if path.endswith('/verification_v2.py'))
        row['original_inputs_unchanged'] = all(file_digest(Path(p)) == expected for p, expected in provenance['original_inputs'].items())
        raw_scores = load(execution_root / arm / 'stage-scores.json')['stages']
        row['nonverification_verdicts_unchanged'] = all(
            {r['id']: r['verdict'] for r in old['criteria'] if r['role'] != 'verification'} ==
            {r['id']: r['verdict'] for r in new['criteria'] if r['role'] != 'verification'}
            for old, new in zip(raw_scores, stage_scores))
        row['completed_stage_total_matches_v2'] = result['completed_stages'] == sum(s['all_pass'] is True for s in stage_scores)
        initial_restatement = load(run / 'restatement-scores.json')
        row['other_six_restatement_judgments_unchanged'] = [r for r in initial_restatement['criteria'] if r['criterion'] != 'unsupported_additions'] == [r for r in restatement['criteria'] if r['criterion'] != 'unsupported_additions']
        original_packet = load(run / 'restatement-judge/unsupported_additions/packet.json')
        full_packet = load(run / 'restatement-judge-full-evidence/unsupported_additions/packet.json')
        expected_instructions = '\n\n'.join(load(run / 'private-definition.json')['prompts'])
        row['same_criterion_and_full_original_instructions'] = full_packet['criterion'] == original_packet['criterion'] and any(e['id'] == 'original-scripted-instructions' and e['text'] == expected_instructions for e in full_packet['evidence']) and restatement['original_instructions_sha256'] == digest(expected_instructions)
        full_judgment = load(run / 'restatement-judge-full-evidence/unsupported_additions/accepted.json')
        revised_additions = next(r for r in restatement['criteria'] if r['criterion'] == 'unsupported_additions')
        row['full_evidence_judgment_bound'] = full_judgment['packet_sha256'] == digest(full_packet) and full_judgment['graded'] is True and full_judgment['judgment'] == revised_additions['judgment']
        row['original_restatement_evidence_unchanged'] = [e for e in full_packet['evidence'] if e['id'] != 'original-scripted-instructions'] == original_packet['evidence']
        row['original_environment_audit_preserved'] = file_digest(execution_root / arm / 'contamination.json') == environment_result['original_audit_sha256']
        row['created_output_witnesses_bound'] = all(file_digest(Path(witness['retained_witness'])) == witness['created_content_sha256'] == witness['current_file_sha256'] for witness in environment_result['created_scratch_outputs'])
        original_arm = execution_root / arm
        session_id = load(original_arm / 'evidence/launch.json')['session_id']
        project = Path('/Users/jaesolshin/.claude-reserach/projects') / re.sub(r'[^a-zA-Z0-9_-]', '-', str((original_arm / 'task').resolve()))
        scope = Scope(original_arm / 'task', project / (session_id + '.jsonl'), tuple((REPO / 'skills').glob('*/SKILL.md')))
        original_calls, original_results = captured_calls(original_arm / 'evidence', workspace=original_arm / 'task')
        audited_again = audit_with_creation(original_calls, original_results, scope,
                          [Path(p) for p in environment['temporary_roots']], [Path(p) for p in environment['forbidden_roots']])
        row['environment_audit_reproduced_from_original_calls'] = audited_again['classification'] == environment_result['classification'] and digest(original_calls) == environment_result['original_actions_sha256']
        arms[arm] = {'checks': row, 'passed': all(row.values()), 'requests': len(messages),
                     'completed_stages': result['completed_stages'], 'goal_failures': result['goal_failures'],
                     'task_stop_candidates': stop['expected'], 'all_observed_stop_candidates': census['candidates'],
                     'restatement_criteria': restatement['expected']}
    checks['all_four_arms_admitted'] = all(row['passed'] for row in arms.values())
    return {'version': 1, 'pilot_complete': all(checks.values()), 'checks': checks, 'arms': arms,
            'valid_pairs': {'Q1': int(arms['V']['passed'] and arms['H']['passed']),
                            'Q3': int(arms['S1']['passed'] and arms['S0']['passed'])},
            'source_spec_sha256': file_digest(root / 'pilot-spec.json'),
            'scores_file': environment['pilot_scores'], 'scores_sha256': file_digest(root / environment['pilot_scores']),
            'initial_scores_sha256': file_digest(root / 'pilot-scores.json'), 'main_runs': 0,
            'limits': ['Completion of this pilot is not a main-study or efficacy decision.',
                       'Semantic model labels are not validated human ground truth.',
                       'Opaque shell access is not an OS-level contamination trace.']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = inspect(args.root)
    write_new(args.output, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result['pilot_complete']:
        raise SystemExit(2)
