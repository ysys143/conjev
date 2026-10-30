"""Retain a closed, accepted pilot and its current prerequisite evidence."""
import json
import shutil
import sqlite3
import sys
from pathlib import Path

REPO = Path('/Users/jaesolshin/Documents/GitHub/context-harness')
HERE = REPO / 'experiments/long-task'
sys.path.insert(0, str(HERE))
from grading import file_digest, load, write_new

run = HERE / 'runs/pilot-20261027-1'
accepted = load(run / 'acceptance.json')
if not accepted['pilot_complete'] or accepted['valid_pairs'] != {'Q1': 1, 'Q3': 1}:
    raise RuntimeError('Only a closed and accepted pilot can be retained as complete')
packet = run / 'evidence-packet'
packet.mkdir(exist_ok=False)
copied = []


def copy_file(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def copy_tmp(source):
    source = Path(source)
    if any(source == p or p in source.parents for p in copied):
        return
    target = packet / 'tmp' / source.relative_to('/private/tmp')
    if source.is_dir():
        shutil.copytree(source, target, symlinks=True, ignore=shutil.ignore_patterns('__pycache__'))
    else:
        copy_file(source, target)
    copied.append(source)


copy_tmp('/private/tmp/ch-research-pilot-20261027-1')
copy_tmp('/private/tmp/ch-research-phase1-20261027-4')
copy_tmp('/private/tmp/ch-research-phase1-20261027-3')
copy_tmp('/private/tmp/ch-research-transport-stress-20261027-2')
copy_tmp('/private/tmp/ch-research-full-chain-20261027-1')
phase0 = load(HERE / 'phase0-evidence-20261027-2.json')
for row in phase0['runs'].values():
    copy_tmp(row['run'])
phase1 = load(Path('/private/tmp/ch-research-phase1-20261027-4/acceptance.json'))
retained_producers = set()
for row in phase1['cases']:
    source = Path(row['source_run'])
    if '20261027' not in str(source):
        continue
    copy_tmp(source)
    if (source.parent / 'manifest.json').is_file():
        retained_producers.add(source.parent)
for source in retained_producers:
    copy_tmp(source / 'manifest.json')
    if (source / 'source').is_dir():
        copy_tmp(source / 'source')
spec = load(Path('/private/tmp/ch-research-pilot-20261027-1/pilot-spec.json'))
binary_identities = {}
for name, expected in spec['source_sha256'].items():
    source = Path(name)
    if file_digest(source) != expected:
        raise ValueError('An executed source changed before retention: ' + name)
    if source.is_relative_to(REPO):
        copy_file(source, packet / 'source' / source.relative_to(REPO))
    else:
        binary_identities[name] = expected
write_new(packet / 'binary-identities.json', binary_identities)
for source in (HERE / 'runs/pilot-20261027-repair').iterdir():
    if source.is_file():
        copy_file(source, packet / 'repair' / source.name)
for name in ['phase0-evidence-20261027-2.json', 'phase0-budget-snapshots-20261027-2.json']:
    copy_file(HERE / name, packet / 'repo' / 'experiments/long-task' / name)
for folder in ['pilot-20261027-1', 'phase0-20261027-2', 'phase1-20261027-1', 'phase1-20261027-2', 'phase1-20261027-3', 'phase1-20261027-4']:
    origin = HERE / 'runs' / folder
    for source in origin.iterdir():
        if source.is_file():
            copy_file(source, packet / 'repo/experiments/long-task/runs' / folder / source.name)
for arm in ['V', 'H', 'S1', 'S0']:
    root = Path('/private/tmp/ch-research-pilot-20261027-1') / arm
    session_id = load(root / 'evidence/launch.json')['session_id']
    # Retain exactly these owned run records, never the rest of the profile.
    import re
    project = Path('/Users/jaesolshin/.claude-reserach/projects') / re.sub(r'[^a-zA-Z0-9_-]', '-', str((root / 'task').resolve()))
    source = project / (session_id + '.jsonl')
    if not source.is_file():
        raise ValueError('Owned native session record missing: ' + session_id)
    copy_file(source, packet / 'native-session-records' / source.name)
with sqlite3.connect(HERE / 'runs/study-spend.sqlite3') as source:
    with sqlite3.connect(packet / 'study-spend-final.sqlite3') as destination:
        source.backup(destination)
old = HERE / 'runs/pilot-20261026-2/evidence-packet/manifest.json'
write_new(packet / 'dependencies.json', {'unchanged_device_originals': str(old), 'sha256': file_digest(old),
          'scope': 'Original 2026-10-26 device cases and terminal evidence; reused only with unchanged product dependencies and complete artifact verification.'})
files = {path.relative_to(packet).as_posix(): {'sha256': file_digest(path), 'bytes': path.stat().st_size}
         for path in sorted(packet.rglob('*')) if path.is_file() and not path.is_symlink()}
links = {path.relative_to(packet).as_posix(): str(path.readlink()) for path in packet.rglob('*') if path.is_symlink()}
write_new(packet / 'manifest.json', {'version': 1, 'pilot_complete': True, 'valid_pairs': accepted['valid_pairs'],
          'regular_files': len(files), 'bytes': sum(v['bytes'] for v in files.values()), 'files': files, 'symlinks': links,
          'limits': ['Native executables are identified by hash; their bytes are not copied.',
                     'The original failed pilot remains in its separate immutable packet.',
                     'This is local evidence retention, not publication or main-study completion.']})
changed = [name for name, row in files.items() if file_digest(packet / name) != row['sha256']]
if changed:
    raise ValueError('Retained packet verification failed')
print(json.dumps({'files_verified': len(files), 'bytes': sum(v['bytes'] for v in files.values()), 'manifest_sha256': file_digest(packet / 'manifest.json')}))
