"""Reject missing real artifacts even when completed-score metadata survives."""
import importlib.util
import json
import os
import shutil
import tempfile
from pathlib import Path

repair = Path(__file__).resolve().parent
source = Path('/private/tmp/ch-research-pilot-scoring-20261027-1')
spec = importlib.util.spec_from_file_location('pilot_completion_audit', repair / 'validate-pilot.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
results = []
with tempfile.TemporaryDirectory(prefix='ch-pilot-acceptance-red-') as temp:
    root = Path(temp) / 'pilot'
    root.mkdir()
    for name in ['pilot-spec.json', 'pilot-scores.json', 'pilot-scores-full-evidence.json', 'pilot-scores-audited.json', 'scoring-manifest.json', 'grading-source-before.json', 'restatement-source-before.json', 'environment-audit-manifest.json', 'environment-source-before.json']:
        shutil.copyfile(source / name, root / name)
    for arm in ['V', 'H', 'S1', 'S0']:
        if arm != 'V':
            (root / arm).symlink_to(source / arm, target_is_directory=True)
            continue
        target = root / arm
        target.mkdir()
        for path in (source / arm).iterdir():
            if path.name == 'stages':
                shutil.copytree(path, target / path.name, copy_function=os.link)
            elif path.name == 'evidence':
                (target / 'evidence').mkdir()
                for child in path.iterdir():
                    if child.name == 'requests':
                        shutil.copytree(child, target / 'evidence/requests', copy_function=os.link)
                    else:
                        (target / 'evidence' / child.name).symlink_to(child, target_is_directory=child.is_dir())
            else:
                (target / path.name).symlink_to(path, target_is_directory=path.is_dir())
    if not audit.inspect(root)['pilot_complete']:
        raise ValueError('The unmodified audit clone did not pass')
    removed = next((root / 'V/evidence/requests').glob('*.json'))
    original = source / 'V/evidence/requests' / removed.name
    removed.unlink()
    result = audit.inspect(root)
    if result['pilot_complete'] or result['arms']['V']['checks']['every_request_start_has_original_capture']:
        raise ValueError('A missing original request record was incorrectly admitted')
    results.append({'mutation': 'one-original-request-record-removed', 'rejected': True})
    os.link(original, removed)
    stage = root / 'V/stages/12.json'
    stage.unlink()
    result = audit.inspect(root)
    if result['pilot_complete'] or result['arms']['V']['checks']['twelve_stage_receipts']:
        raise ValueError('A missing stage was incorrectly admitted')
    results.append({'mutation': 'stage-12-receipt-removed-with-completed-metadata-retained', 'rejected': True})
    os.link(source / 'V/stages/12.json', stage)
    if not audit.inspect(root)['pilot_complete']:
        raise ValueError('Restoring the clone did not recover the valid evidence state')
    full = root / 'V/restatement-judge-full-evidence'
    full.unlink()
    shutil.copytree(source / 'V/restatement-judge-full-evidence', full, copy_function=os.link)
    packet_path = full / 'unsupported_additions/packet.json'
    packet = json.loads(packet_path.read_text())
    packet_path.unlink()
    packet['evidence'] = [e for e in packet['evidence'] if e['id'] != 'original-scripted-instructions']
    packet_path.write_text(json.dumps(packet) + '\n')
    result = audit.inspect(root)
    if result['pilot_complete'] or result['arms']['V']['checks']['same_criterion_and_full_original_instructions']:
        raise ValueError('Missing original instructions were incorrectly admitted')
    results.append({'mutation': 'original-instructions-removed-with-all-grade-counts-retained', 'rejected': True})
    packet_path.unlink()
    os.link(source / 'V/restatement-judge-full-evidence/unsupported_additions/packet.json', packet_path)
    (root / 'S1').unlink()
    shutil.copytree(source / 'S1', root / 'S1', copy_function=os.link)
    continuation = next(p for p in (root / 'S1/observer/candidates').glob('*.json')
                        if json.loads(p.read_text()).get('continuation_of'))
    continuation.unlink()
    try:
        audit.inspect(root)
    except ValueError:
        results.append({'mutation': 'actual-block-continuation-record-removed', 'rejected': True})
    else:
        raise ValueError('A dropped actual continuation was incorrectly admitted')
    os.link(source / 'S1/observer/candidates' / continuation.name, continuation)
    blocked = next(p for p in (root / 'S1/observer/decisions').glob('*.json')
                   if 'block' in json.loads(p.read_text()).get('result', {}))
    snapshot = root / 'S1/observer/snapshots' / blocked.stem / 'snapshot.json'
    snapshot.unlink()
    try:
        audit.inspect(root)
    except (ValueError, FileNotFoundError):
        results.append({'mutation': 'actual-pre-decision-snapshot-receipt-removed', 'rejected': True})
    else:
        raise ValueError('A missing pre-decision snapshot was incorrectly admitted')
output = {'positive_clone_passed': True, 'mutations': results,
          'original_evidence_modified': False, 'temporary_clones_only': True}
(repair / 'negative-acceptance.json').write_text(json.dumps(output, indent=2) + '\n')
print(json.dumps(output))
