"""Reuse valid original judgments; retry only a rejected citation/format reply."""
import copy
import json
import sys
from pathlib import Path

HERE = Path('/Users/jaesolshin/Documents/GitHub/context-harness/experiments/long-task')
sys.path.insert(0, str(HERE))
from grading import check_subscription, digest, file_digest, load, parse_verdict, result_object, write_new
from pilot_judge import run_packet as original_run_packet
from verification_v2 import score
import pilot_score

ROOT = Path('/private/tmp/ch-research-pilot-scoring-20261027-1')
EXECUTION = Path('/private/tmp/ch-research-pilot-20261027-2')


def stable_packet(packet):
    result = copy.deepcopy(packet)
    for evidence in result['evidence']:
        if evidence['id'] == 'pre-decision-oracle':
            oracle = json.loads(evidence['text'])
            # A fresh local test run changes its elapsed-time text, not its
            # source, test counts, verdicts or original model actions.
            oracle.get('verification_audit', {}).get('snapshot_tests', {}).pop('output', None)
            evidence['text'] = json.dumps(oracle, sort_keys=True)
    return result


def accepted_at(root):
    result = load(root / 'accepted.json')
    packet = load(root / 'packet.json')
    actual = parse_verdict(result_object((root / 'stdout.json').read_text())['result'], packet)
    if result['packet_sha256'] != digest(packet) or result['judgment'] != actual:
        raise ValueError('A retained valid judgment no longer matches its original packet/response')
    return result


def resumable_packet(packet, *, root, **kwargs):
    if (root / 'packet.json').exists():
        stored = load(root / 'packet.json')
        if stable_packet(packet) != stable_packet(stored):
            raise ValueError('A resumed criterion changed nonvolatile original evidence')
        packet = stored
    if (root / 'accepted.json').exists():
        return accepted_at(root)
    if not root.exists():
        return original_run_packet(packet, root=root, **kwargs)
    selector = root / 'selected-valid-attempt.json'
    if selector.exists():
        return accepted_at(Path(load(selector)['selected_root']))
    if not (root / 'error.json').exists():
        raise ValueError('An unfinished judgment cannot be silently retried')
    original_error = load(root / 'error.json')
    if original_error['message'] != 'Evidence quote is absent or altered':
        raise ValueError('Unrecognized initial judgment failure requires inspection')
    for attempt in range(1, 4):
        target = root / 'citation-retries' / str(attempt)
        retry = {**packet, 'task': packet['task'] + '\nEvidence quotations must be literal substrings, including Markdown and escape characters. Choose short exact quotes; do not paraphrase evidence.'}
        if target.exists():
            if (target / 'accepted.json').exists():
                result = accepted_at(target)
            else:
                continue
        else:
            try:
                result = original_run_packet(retry, root=target, **kwargs)
            except ValueError as error:
                if str(error) == 'Evidence quote is absent or altered':
                    continue
                raise
        write_new(selector, {'original_packet_sha256': digest(packet), 'selected_root': str(target),
                  'selected_response_sha256': file_digest(target / 'accepted.json'),
                  'criterion_unchanged': retry['criterion'] == packet['criterion'],
                  'evidence_unchanged': retry['evidence'] == packet['evidence'],
                  'policy': 'First format-valid response; valid unscorable labels are not retried.'})
        return result
    raise ValueError('Citation validity still failed; inspect rather than changing a quote or verdict')


def main():
    binary = Path.home() / '.local/share/claude/versions/2.1.309'
    config = Path.home() / '.claude-reserach'
    version = check_subscription(binary, config)
    spec = load(ROOT / 'pilot-spec.json')
    for path, expected in load(ROOT / 'grading-source-before.json').items():
        if file_digest(Path(path)) != expected:
            raise ValueError('Original grading source changed before resumption')
    write_new(ROOT / 'resume-source-before.json', {str(Path(__file__)): file_digest(Path(__file__))})
    summaries = []
    original_neutral = pilot_score.neutral
    original_score = pilot_score.score_stage
    original_packet = pilot_score.run_packet
    try:
        pilot_score.run_packet = resumable_packet
        for pair in spec['order']:
            for arm in pair:
                root = ROOT / arm
                if not (root / 'rescore-provenance.json').exists():
                    raise ValueError('A complete versioned scoring view is required')
                original = EXECUTION / arm
                pilot_score.score_stage = lambda snap, contract, **kw: score(snap, contract, workspace=original / 'task', **kw)
                pilot_score.neutral = lambda value, task: original_neutral(value, original / 'task')
                if (root / 'stop-judgments.json').exists():
                    judgments = load(root / 'stop-judgments.json')['candidates']
                else:
                    judgments = pilot_score.classify_candidates(root, binary=binary, config=config, model=spec['judge_model'], version=version)
                if (root / 'restatement-scores.json').exists():
                    restatements = load(root / 'restatement-scores.json')['criteria']
                else:
                    restatements = pilot_score.restatement(root, binary=binary, config=config, model=spec['judge_model'], version=version)
                summaries.append(pilot_score.summarize(root, judgments, restatements))
    finally:
        pilot_score.neutral = original_neutral
        pilot_score.score_stage = original_score
        pilot_score.run_packet = original_packet
    complete = all(row['stage_scoring_complete'] and row['stop_graded'] == row['stop_expected']
                   and row['restatement_graded'] == row['restatement_expected'] for row in summaries)
    write_new(ROOT / 'pilot-scores.json', {'runs': summaries, 'scoring_complete': complete, 'verification_revision': 2,
              'citation_retry_preserved': True, 'main_runs': 0})
    print(json.dumps({'initial_scoring_complete': complete, 'runs': len(summaries)}))
    if not complete:
        raise SystemExit(2)


if __name__ == '__main__':
    main()
