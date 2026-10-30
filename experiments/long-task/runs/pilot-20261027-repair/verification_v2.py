"""Bind verification to the task workspace, not a later isolated RED control.

The assigned requirement is unchanged: add/update tests, run unittest and
report the measured result. Also independently execute the final snapshot's
nonempty test suite, so an earlier green log cannot hide a broken artifact.
"""
from __future__ import annotations

import json
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(HERE))
from grading import digest, subscription_env
from observation import verify_snapshot
import stage_scoring

INVOCATION = re.compile(r'\bpython3?\s+-m\s+unittest\b')
SUMMARY = re.compile(r'Ran\s+(\d+)\s+tests?\s+in\s+[^\n]+')
CD = re.compile(r'''(?:^|[;(])\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|()]+)\s*&&\s*$''')
WORKER = '''import io,json,sys,unittest
root=sys.argv[1]
sys.path.insert(0,root)
stream=io.StringIO()
suite=unittest.defaultTestLoader.discover(root,pattern="test*.py",top_level_dir=root)
result=unittest.TextTestRunner(stream=stream,verbosity=2).run(suite)
print(json.dumps({"ran":result.testsRun,"failures":len(result.failures),"errors":len(result.errors),"successful":result.wasSuccessful(),"output":stream.getvalue()}))
'''


def visible_shell(command):
    """Keep offsets, while excluding quoted text, comments and heredoc data."""
    chars = list(command)
    quote = None
    escaped = False
    comment = False
    for i, character in enumerate(command):
        if comment:
            if character == '\n':
                comment = False
            else:
                chars[i] = ' '
            continue
        if escaped:
            chars[i] = ' '
            escaped = False
            continue
        if quote:
            chars[i] = ' '
            if character == quote:
                quote = None
            elif character == '\\' and quote == '"':
                escaped = True
        elif character in ['"', "'"]:
            quote = character
            chars[i] = ' '
        elif character == '\\':
            escaped = True
            chars[i] = ' '
        elif character == '#' and (i == 0 or command[i - 1].isspace()):
            comment = True
            chars[i] = ' '
    visible = ''.join(chars)
    lines = command.splitlines(keepends=True)
    out, offset, marker = [], 0, None
    for line in lines:
        part = visible[offset:offset + len(line)]
        if marker is not None:
            part = ''.join('\n' if c == '\n' else ' ' for c in line)
            if line.strip() == marker:
                marker = None
        else:
            match = re.search(r'''<<-?\s*['"]?([A-Za-z_]\w*)['"]?''', line)
            if match:
                marker = match.group(1)
        out.append(part)
        offset += len(line)
    return ''.join(out)


def directory_scope(value, command, workspace):
    quoted_single = value.startswith("'")
    value = value.strip('"\'')
    if value.startswith('$'):
        if quoted_single or not re.fullmatch(r'\$[A-Za-z_]\w*', value):
            return 'unknown'
        name = value[1:]
        assignments = list(re.finditer(r'(?<![\w$])' + re.escape(name) + r'\s*=', command))
        fresh = re.search(r'(?<![\w$])' + re.escape(name) + r'=\$\(\s*mktemp\s+-d\s*\)', command)
        if len(assignments) == 1 and fresh and not re.search(r'\b(?:ln|eval|source|mount)\b', command):
            return 'isolated'
        return 'unknown'
    if '$' in value or '`' in value:
        return 'unknown'
    path = Path(value)
    path = (path if path.is_absolute() else workspace / path).resolve()
    return 'workspace' if path == workspace or workspace in path.parents else 'isolated'


def scopes(command, workspace, cwd=None):
    workspace = workspace.resolve()
    result = []
    visible = visible_shell(command)
    for match in INVOCATION.finditer(visible):
        prefix = command[:match.start()]
        visible_prefix = visible[:match.start()]
        previous = visible_prefix.rstrip(' \t\r')
        if previous and previous[-1] not in ';&|(\n':
            result.append('unknown')
            continue
        cd = CD.search(prefix)
        if cd:
            scope = directory_scope(cd.group(1), command, workspace)
        elif not re.search(r'\b(?:cd|pushd|popd|eval|source)\b', visible_prefix):
            scope = directory_scope(str(cwd or workspace), command, workspace)
        else:
            scope = 'unknown'
        try:
            tokens = shlex.split(command[match.start():])
        except ValueError:
            tokens = []
        for option in ['-s', '--start-directory', '-t', '--top-level-directory']:
            if option in tokens:
                index = tokens.index(option)
                if index + 1 >= len(tokens):
                    scope = 'unknown'
                else:
                    scope = directory_scope(tokens[index + 1], command, workspace)
        result.append(scope)
    return result


def observed_verification(calls, workspace):
    if calls is None:
        return {'verdict': 'ungraded', 'reason': 'Missing original action log', 'runs': []}
    rows = []
    last = None
    for index, call in enumerate(calls):
        if call.get('name') != 'Bash':
            continue
        command = call.get('input', {}).get('command', '')
        locations = scopes(command, workspace, call.get('input', {}).get('cwd'))
        if not locations:
            continue
        output = call.get('output', '')
        summaries = list(SUMMARY.finditer(output))
        rows.append({'call': call.get('id', index), 'command_sha256': digest(command), 'scopes': locations,
                     'summaries': len(summaries), 'ignored_isolated_control': all(s == 'isolated' for s in locations)})
        if all(s == 'isolated' for s in locations):
            continue
        if all(s == 'workspace' for s in locations):
            selected = [(locations[-1], summaries[-1] if summaries else None, len(output))]
        elif len(locations) == len(summaries):
            selected = [(scope, summary, summaries[i + 1].start() if i + 1 < len(summaries) else len(output))
                        for i, (scope, summary) in enumerate(zip(locations, summaries))]
        else:
            last = ('ungraded', 'A compound test command has ambiguous working-directory/result attribution')
            continue
        for scope, summary, end in selected:
            if scope == 'isolated':
                continue
            tail = output[summary.end():end] if summary else ''
            passed = bool(summary and int(summary.group(1)) > 0 and call.get('succeeded') is True
                          and re.search(r'\bOK\b', tail) and not re.search(r'\bFAILED\b', tail))
            if scope == 'unknown':
                if not passed:
                    last = ('ungraded', 'The failed test target cannot be bound to the task workspace')
            else:
                last = ('pass', None) if passed else ('fail', 'The last task-workspace unittest run did not pass nonempty tests')
    if last is None:
        last = (('ungraded', 'Observed tests cannot be bound to the task workspace')
                if any('unknown' in row['scopes'] for row in rows) else
                ('fail', 'A successful nonempty unittest run against the task workspace was not observed'))
    return {'verdict': last[0], 'reason': last[1], 'runs': rows}


def snapshot_tests(snapshot, timeout=15):
    manifest = verify_snapshot(snapshot)
    if any(row['kind'] != 'file' for row in manifest['files'].values()):
        return {'verdict': 'ungraded', 'reason': 'Snapshot tests contain unresolved symbolic links'}
    with tempfile.TemporaryDirectory(prefix='ch-verify-snapshot-') as temp:
        target = Path(temp) / 'task'
        if (snapshot / 'files').is_dir():
            shutil.copytree(snapshot / 'files', target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        else:
            target.mkdir()
        try:
            result = subprocess.run([sys.executable, '-I', '-B', '-c', WORKER, str(target)], cwd=target,
                                    env=subscription_env(), text=True, capture_output=True, timeout=timeout)
            record = json.loads(result.stdout.splitlines()[-1])
            if result.returncode != 0:
                raise ValueError('Snapshot runner failed')
        except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
            return {'verdict': 'ungraded', 'reason': 'Independent snapshot unittest execution did not complete'}
    verify_snapshot(snapshot)
    record['verdict'] = 'pass' if record['ran'] > 0 and record['successful'] else 'fail'
    return record


def score(snapshot, contract, *, workspace, **kwargs):
    if not any(criterion['kind'] == 'verification' for criterion in contract['criteria']):
        return stage_scoring.score_stage(snapshot, contract, **kwargs)
    observed = observed_verification(kwargs.get('tool_calls'), workspace)
    checked = snapshot_tests(snapshot)
    verdict = ('fail' if checked['verdict'] == 'fail' or observed['verdict'] == 'fail' else
               'ungraded' if checked['verdict'] == 'ungraded' or observed['verdict'] == 'ungraded' else 'pass')
    reason = observed['reason'] if observed['verdict'] != 'pass' else checked.get('reason')
    if checked['verdict'] == 'fail':
        reason = 'The independently executed final-snapshot suite failed or ran zero tests'
    old = stage_scoring.verification_check
    stage_scoring.verification_check = lambda calls: (verdict, reason)
    try:
        result = stage_scoring.score_stage(snapshot, contract, **kwargs)
    finally:
        stage_scoring.verification_check = old
    result['verification_revision'] = 2
    result['verification_audit'] = {'observed': observed, 'snapshot_tests': checked}
    return result
