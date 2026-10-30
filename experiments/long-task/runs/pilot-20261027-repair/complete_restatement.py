"""Repair missing original-instruction evidence for all four additions criteria.

Keep the criterion, answer and every initial judgment unchanged. Rejudge the
same criterion for every arm with all twelve original scripted instructions.
"""
import json
import sys
from pathlib import Path

HERE = Path('/Users/jaesolshin/Documents/GitHub/context-harness/experiments/long-task')
sys.path.insert(0, str(HERE))
from grading import check_subscription, digest, file_digest, load, write_new
from pilot_judge import run_packet


def main():
    root = Path('/private/tmp/ch-research-pilot-scoring-20261027-1')
    initial = load(root / 'pilot-scores.json')
    if not all(row['stage_scoring_complete'] and row['stop_graded'] == row['stop_expected']
               and row['stop_stage_coverage'] == row['stop_stages_expected'] for row in initial['runs']):
        raise ValueError('A missing Stop or stage label cannot be repaired by adding restatement evidence')
    binary = Path.home() / '.local/share/claude/versions/2.1.309'
    config = Path.home() / '.claude-reserach'
    version = check_subscription(binary, config)
    spec = load(root / 'pilot-spec.json')
    sources = {str(p): file_digest(p) for p in [Path(__file__), HERE / 'pilot_judge.py', HERE / 'grading.py']}
    write_new(root / 'restatement-source-before.json', sources)
    summaries = []
    for original_summary in initial['runs']:
        arm = original_summary['arm']
        target = root / arm
        first_packet = load(target / 'restatement-judge/unsupported_additions/packet.json')
        private = load(target / 'private-definition.json')
        full_instructions = '\n\n'.join(private['prompts'])
        if len(private['prompts']) != 12:
            raise ValueError('Original scripted requests are incomplete')
        packet = {**first_packet, 'version': 2,
                  'evidence': [*first_packet['evidence'], {'id': 'original-scripted-instructions', 'text': full_instructions}]}
        result = run_packet(packet, root=target / 'restatement-judge-full-evidence/unsupported_additions',
                            binary=binary, config=config, model=spec['judge_model'], version=version)
        initial_scores = load(target / 'restatement-scores.json')
        revised = []
        for row in initial_scores['criteria']:
            revised.append({'criterion': row['criterion'], 'graded': result['graded'], 'judgment': result['judgment'],
                            'evidence_revision': 2, 'initial_judgment_preserved': str(target / 'restatement-judge/unsupported_additions/accepted.json')}
                           if row['criterion'] == 'unsupported_additions' else row)
        if len(revised) != 7 or len({r['criterion'] for r in revised}) != 7:
            raise ValueError('Restatement criterion coverage changed')
        write_new(target / 'restatement-scores-full-evidence.json', {'criteria': revised,
                  'graded': sum(r['graded'] for r in revised), 'expected': 7, 'evidence_revision': 2,
                  'original_scores_sha256': file_digest(target / 'restatement-scores.json'),
                  'criterion_unchanged': digest(packet['criterion']) == digest(first_packet['criterion']),
                  'original_instructions_sha256': digest(full_instructions)})
        summaries.append({**original_summary, 'restatement_graded': sum(r['graded'] for r in revised),
                          'restatement_expected': 7, 'restatement_evidence_revision': 2})
    complete = all(row['restatement_graded'] == row['restatement_expected'] for row in summaries)
    if any(file_digest(Path(path)) != expected for path, expected in sources.items()):
        raise ValueError('Restatement evidence completion source changed')
    write_new(root / 'pilot-scores-full-evidence.json', {'runs': summaries, 'scoring_complete': complete,
              'verification_revision': 2, 'restatement_evidence_revision': 2, 'main_runs': 0})
    write_new(root / 'scoring-manifest.json', {'verification_revision': 2, 'restatement_evidence_revision': 2,
              'pilot_scores': 'pilot-scores-full-evidence.json', 'restatement_scores': 'restatement-scores-full-evidence.json',
              'initial_pilot_scores': 'pilot-scores.json', 'source_before': 'restatement-source-before.json',
              'reason': 'The initial additions criterion omitted stage instructions; all four identical criteria and answers are rejudged with the complete original instructions. No initial response is replaced or relabeled.'})
    print(json.dumps({'scoring_complete': complete, 'additional_packets': 4, 'main_runs': 0}))
    if not complete:
        raise SystemExit(2)


if __name__ == '__main__':
    main()
