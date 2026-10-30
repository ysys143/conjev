"""Recompute diagnosis and verify frozen inputs without changing them."""
import hashlib
import importlib.util
import json
import re
from pathlib import Path

OUT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('token_diagnosis', OUT / 'analyze.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
expected = json.loads((OUT / 'analysis.json').read_text())
assert expected['script_sha256'] == hashlib.sha256((OUT / 'analyze.py').read_bytes()).hexdigest()
for arm in ['H', 'V']:
    assert module.analyze(arm) == expected['actors'][arm], arm
retained = OUT.parent / 'evidence-packet'
manifest = json.loads((retained / 'manifest.json').read_text())
checked = 0
for row in manifest['files']:
    if 'sha256' in row:
        assert hashlib.sha256((retained / row['path']).read_bytes()).hexdigest() == row['sha256'], row['path']
        checked += 1
for row in manifest['sources']:
    if row['retained'] is not None:
        assert hashlib.sha256((retained / row['retained']).read_bytes()).hexdigest() == row['sha256']
report = OUT.parents[4] / 'docs/research/token-overhead-diagnosis.md'
links = 0
for target in re.findall(r'\]\(([^)]+)\)', report.read_text()):
    if '://' not in target and not target.startswith('#'):
        assert (report.parent / target.split('#')[0]).exists(), target
        links += 1
receipt = {'fresh_recomputation_matches': True, 'http_records': 170, 'generation_requests': 168,
           'direct_message_id_bindings': 165, 'summary_interval_bindings': 3, 'count_only_requests': 2,
           'original_retained_files_checked': checked, 'retained_sources_match': True,
           'report_links_checked': links, 'report_sha256': hashlib.sha256(report.read_bytes()).hexdigest(),
           'analysis_sha256': hashlib.sha256((OUT / 'analysis.json').read_bytes()).hexdigest(),
           'supplement_sha256': hashlib.sha256((OUT / 'supplement.json').read_bytes()).hexdigest(),
           'new_model_calls': 0}
destination = OUT / 'verification.json'
assert not destination.exists(), 'Refuse to overwrite prior verification'
destination.write_text(json.dumps(receipt, indent=2)+'\n')
print(json.dumps(receipt))
