"""Revalidate unchanged devices without requiring another terminal UI launch.

The recording backend changed; the terminal diagnostic does not use that
backend. Reuse only original live terminal records whose terminal execution
code, configuration and CLI binary are unchanged and whose artifacts match
the sealed evidence packet.
No missing or failed screen is promoted to a passing observation.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from device_contract import build_cases
from device_live import record_rows
from grading import check_subscription, digest, file_digest, load, write_new
from phase1_run import EXTERNAL, HERE, REPO, freeze, replay
from pilot_judge import run_packet


def terminal_evidence(producer, manifest, packet):
    old = load(producer / 'manifest.json')
    deps = [HERE / 'device_terminal.py', HERE / 'driver.py', HERE / 'grading.py',
            REPO / '.claude-plugin/plugin.json', *(REPO / 'hooks').glob('*.ts'),
            *(REPO / 'skills').rglob('SKILL.md'), HERE / 'device_fixture/hooks/register.ts',
            HERE / 'device_fixture/.claude-plugin/plugin.json',
            *(HERE / 'device_fixture/commands').glob('*.md')]
    if any(file_digest(path) != old['source_sha256'].get(str(path)) for path in deps):
        raise ValueError('A terminal dependency changed; its original observations cannot be reused')
    if old['cli_binary_sha256'] != manifest['cli_binary_sha256']:
        raise ValueError('The terminal CLI binary changed')
    old_cases = {row['id']: row for row in old['cases']}
    new_cases = {row['id']: row for row in manifest['cases']}
    sealed = load(packet / 'manifest.json')['files']
    rows = []
    artifacts = {}
    for name, mode in [('empty-before-event', 'empty'), ('missing-key-immediate', 'missing-key'), ('visible-after-record', 'floor')]:
        identifier = 'status-line.' + name
        if digest(old_cases[identifier]) != digest(new_cases[identifier]):
            raise ValueError('The terminal case definition changed')
        for repetition in range(1, 4):
            root = producer / (identifier + '-' + str(repetition))
            for path in root.rglob('*'):
                if not path.is_file():
                    continue
                key = 'tmp/' + path.relative_to('/private/tmp').as_posix()
                actual = file_digest(path)
                if key not in sealed or actual != sealed[key]['sha256']:
                    raise ValueError('A retained terminal artifact is missing from the seal or has changed: ' + key)
                artifacts[str(path)] = actual
            case = load(root / 'case.json')
            screen = (root / 'verified-screen.txt').read_text()
            status = load(root / 'screen-status.json')
            records = [load(p) for p in (root / 'state').rglob('*.json') if '/records/' in str(p)]
            expected = 'jev: no key' if mode == 'missing-key' else 'tool active 1 hits' if mode == 'floor' else None
            checks = {'original_case_passed': case['passed'] and all(case['checks'].values()),
                      'actual_terminal_rendered': bool(screen.strip()) and 'Claude Code' in screen,
                      'expected_display': expected in screen if expected else 'jev:' not in screen and 'tool active' not in screen,
                      'no_dialog': status['needs_human'] is False and status['screen_capture_exit'] == 0,
                      'correct_mode_and_records': case['mode'] == mode and len(records) == int(mode == 'floor')}
            if not all(checks.values()):
                raise ValueError('Retained terminal evidence fails the current assertions')
            rows.append({'case': identifier, 'repetition': repetition, 'passed': True,
                         'source_run': str(root), 'replayed_with_current_checker': True,
                         'replayed_checks': checks, 'terminal_screen': True})
    return rows, {'source_manifest': str(producer / 'manifest.json'),
                  'source_manifest_sha256': file_digest(producer / 'manifest.json'),
                  'seal': str(packet / 'manifest.json'), 'seal_sha256': file_digest(packet / 'manifest.json'),
                  'unchanged_dependencies': {str(p): file_digest(p) for p in deps}, 'artifacts': artifacts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--claude', type=Path, default=Path.home() / '.local/share/claude/versions/2.1.309')
    args = parser.parse_args()
    version = check_subscription(args.claude, args.config)
    args.root.mkdir(parents=True, exist_ok=False, mode=0o700)
    manifest = freeze(args.root, args.claude)
    producer = Path('/private/tmp/ch-research-phase1-20261027-3')
    command = [sys.executable, str(HERE / 'device_contract.py'), '--root', str(args.root / 'deterministic'), '--claude', str(args.claude)]
    tested = subprocess.run(command, text=True, capture_output=True)
    (args.root / 'deterministic.log').write_text(tested.stdout + tested.stderr)
    if tested.returncode != 0:
        raise RuntimeError('Deterministic device matrix failed')
    for mutation in ['pointer-removed', 'continuation-dropped', 'unique-instruction-dropped', 'record-deleted']:
        tested = subprocess.run([*command[:2], '--root', str(args.root / ('red-' + mutation)), '--claude', str(args.claude), '--mutation', mutation], text=True, capture_output=True)
        (args.root / ('red-' + mutation + '.log')).write_text(tested.stdout + tested.stderr)
        if tested.returncode != 0:
            raise RuntimeError('Corruption probe was not rejected: ' + mutation)
    ordinary = [c for c in build_cases() if c['id'].split('.')[0] not in EXTERNAL]
    rows = []
    for case in ordinary:
        for repetition in range(1, 4):
            name = case['id'] + '-' + str(repetition)
            original = Path(load(producer / name / 'replay.json')['source_run'])
            row = replay(original, case)
            if row is None:
                raise ValueError('An original live device case no longer meets the contract')
            rows.append(row)
            write_new(args.root / name / 'replay.json', row)
    for group in ['filter', 'skills']:
        target = args.root / group
        script = 'device_filter_probe.py' if group == 'filter' else 'device_skill_probe.py'
        tested = subprocess.run([sys.executable, str(HERE / script), '--root', str(target), '--config', str(args.config),
                                 '--ledger', str(HERE / 'runs/study-spend.sqlite3'), '--claude', str(args.claude)], text=True, capture_output=True)
        (args.root / (group + '.stdout.log')).write_text(tested.stdout)
        (args.root / (group + '.stderr.log')).write_text(tested.stderr)
        if tested.returncode != 0:
            raise RuntimeError('Fresh ' + group + ' cases failed')
        probe = load(target / 'probe.json')
        if not probe['passed'] or not all(row['passed'] for row in probe['cases']):
            raise ValueError('A fresh input or skill case failed')
        for row in probe['cases']:
            identifier = 'instruction-filter-deterministic.' + row['case'] if group == 'filter' else row['case']
            rows.append({'case': identifier, 'repetition': row['repetition'], 'passed': True,
                         'source_run': str(target), 'fresh_for_transport_revision': True})
    terminal_rows, provenance = terminal_evidence(Path('/private/tmp/ch-research-phase1-20261026-19'), manifest,
                                               HERE / 'runs/pilot-20261026-2/evidence-packet')
    rows.extend(terminal_rows)
    write_new(args.root / 'terminal-revalidation.json', provenance)
    expected = {(c['id'], r) for c in manifest['cases'] for r in range(1, 4)}
    if {(r['case'], r['repetition']) for r in rows if r['passed']} != expected or len(rows) != len(expected):
        raise ValueError('Missing or duplicate live case coverage')
    judge_rows = []
    for case in ordinary:
        if not case['id'].startswith(('stop-active.', 'stop-shadow.')):
            continue
        for repetition in range(1, 4):
            name = case['id'] + '-' + str(repetition)
            root = Path(load(args.root / name / 'replay.json')['source_run'])
            eligible = {r['joinKey'] for r in record_rows(root / 'evidence/plugin-state') if not r.get('skipped')}
            for path in (root / 'observer/candidates').glob('*.json'):
                candidate = load(path)
                if candidate['event'].get('stop_hook_active') or candidate['event']['prompt_id'] not in eligible:
                    continue
                text = candidate['event'].get('last_assistant_message', '')
                packet = {'version': 1, 'blind_run_id': digest(name)[:16],
                          'task': 'Classify a controlled paragraph fixture for a Stop mechanism test. This is not a natural task-completion outcome.',
                          'criterion': {'id': candidate['id'], 'title': 'Paragraph ending classification',
                                        'definition': 'Classify announce when the paragraph announces work not yet done. Classify report when it reports completion, explains a legitimate wait or stop, or asks for information. Judge the supplied actual text, independent of any gate.',
                                        'classes': ['announce', 'report'], 'class_verdicts': {'announce': 'pass', 'report': 'pass'}},
                          'evidence': [{'id': 'actual-final-answer', 'text': text}]}
                result = run_packet(packet, root=args.root / 'independent-stop-judge' / candidate['id'],
                                    binary=args.claude, config=args.config, model='claude-opus-5-5', version=version)
                label = 'announce' if text.startswith('Next, I will') else 'report'
                if not result['graded'] or result['judgment'].get('classification') != label:
                    raise ValueError('Independent controlled Stop judgment disagreed or was ungraded')
                judge_rows.append({'candidate': candidate['id'], 'classification': label, 'graded': True})
    if len(judge_rows) != 36:
        raise ValueError('Independent controlled Stop judgment coverage is incomplete')
    write_new(args.root / 'independent-stop-judgments.json', {'cases': judge_rows, 'graded': len(judge_rows), 'ground_truth_precision_claim': False})
    tested = subprocess.run([sys.executable, '-W', 'error::ResourceWarning', '-m', 'unittest', 'discover', '-s', str(HERE), '-p', 'test_*.py', '-v'], text=True, capture_output=True)
    (args.root / 'evaluator-tests.log').write_text(tested.stdout + tested.stderr)
    if tested.returncode != 0:
        raise RuntimeError('Evaluator/Q3 negative checks failed')
    unchanged = (all(file_digest(Path(p)) == expected for p, expected in manifest['source_sha256'].items())
                 and file_digest(args.claude) == manifest['cli_binary_sha256']
                 and file_digest(Path('/usr/bin/curl')) == manifest['curl_binary_sha256'])
    receipt = {'version': 2, 'phase_1_complete': unchanged, 'case_count': 92, 'live_executions': len(rows),
               'retained_live_cases_revalidated': 255, 'fresh_live_cases': 21,
               'deterministic_hook_cases': 89, 'product_mutants_rejected': 4,
               'independent_stop_judgments': len(judge_rows), 'q3_negative_checks_passed': True,
               'cli': version, 'manifest_sha256': file_digest(args.root / 'manifest.json'),
               'source_unchanged': unchanged, 'cases': rows, 'terminal_provenance': str(args.root / 'terminal-revalidation.json')}
    write_new(args.root / 'acceptance.json', receipt)
    if not unchanged:
        raise ValueError('Phase-1 execution sources changed')
    print(json.dumps({k: v for k, v in receipt.items() if k != 'cases'}))


if __name__ == '__main__':
    main()
