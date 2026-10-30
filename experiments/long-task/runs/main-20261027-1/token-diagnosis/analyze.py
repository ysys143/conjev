"""Read-only diagnosis of the frozen first main pair. No model requests."""
from __future__ import annotations

import collections
import hashlib
import json
import re
from pathlib import Path

OUT = Path(__file__).resolve().parent
ROOT = OUT.parent / 'evidence-packet/execution'


def load(path):
    return json.loads(path.read_text())


def events(text):
    for part in re.split(r'\r?\n\r?\n', text):
        raw = '\n'.join(line[5:].lstrip() for line in part.splitlines() if line.startswith('data:'))
        if raw and raw != '[DONE]':
            yield json.loads(raw)


def clean(value):
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items() if k != 'cache_control'}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value


def fingerprint(value):
    return hashlib.sha256(json.dumps(clean(value), sort_keys=True).encode()).hexdigest()


def text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return '\n'.join(text(x) for x in value)
    if isinstance(value, dict):
        return text(value.get('text', value.get('content', '')))
    return ''


def body_stats(body):
    counts, chars = collections.Counter(), collections.Counter()
    thinking_hashes, assistant_hashes = set(), set()
    notes = {}
    for message in body['messages']:
        content = message.get('content', [])
        if isinstance(content, str):
            content = [{'type': 'text', 'text': content}]
        if message['role'] == 'assistant':
            assistant_hashes.add(fingerprint(content))
        for block in content:
            kind = block.get('type', 'unknown')
            counts[kind] += 1
            chars[kind] += len(json.dumps(block, ensure_ascii=False))
            if kind == 'thinking':
                chars['thinking_text'] += len(block.get('thinking', ''))
                chars['thinking_signature'] += len(block.get('signature', ''))
                thinking_hashes.add(fingerprint(block))
            if kind == 'text' and block.get('text', '').startswith('[context-harness]'):
                notes[fingerprint(block)] = block['text']
    return {'messages': len(body['messages']), 'block_counts': dict(counts), 'block_json_chars': dict(chars),
            'thinking_hashes': sorted(thinking_hashes), 'assistant_hashes': sorted(assistant_hashes),
            'notes': notes, 'system_json_chars': len(json.dumps(body.get('system'), ensure_ascii=False)),
            'tools_json_chars': len(json.dumps(body.get('tools'), ensure_ascii=False))}


def analyze(arm):
    root = ROOT / arm
    sources = []
    labels = collections.defaultdict(set)
    for stage in range(1, 13):
        path = root / 'stages' / f'{stage:02}.json'
        sources.append((f'stage-{stage:02}', load(path)['events']))
    result = load(root / 'run-result.json')
    sources += [(f'compact-{x["after_stage"]:02}', x['events']) for x in result['compactions']]
    sources += [('restatement', load(root / 'restatement.json')['events'])]
    all_calls = {}
    for label, stream in sources:
        for event in stream:
            message = event.get('message', {})
            if event.get('type') == 'assistant' and message.get('id'):
                labels[message['id']].add(label)
            for block in message.get('content', []) if isinstance(message.get('content'), list) else []:
                if block.get('type') == 'tool_use':
                    all_calls[block['id']] = {**block, 'label': label}
    captures = sorted((load(p) for p in (root / 'evidence/requests').glob('*.json')), key=lambda r: r['started_at'])
    rows, bodies = [], []
    auxiliary = []
    for index, capture in enumerate(captures):
        assert capture['complete'] and capture['status'] == 200
        if capture['path'].split('?')[0] != '/v1/messages':
            auxiliary.append({'capture': capture['id'], 'path': capture['path'], 'usage': capture.get('usage'), 'response': json.loads(capture['response_body'])})
            continue
        assert capture['message_stop']
        body = json.loads(capture['request_body'])
        bodies.append(body)
        response = list(events(capture['response_body']))
        start = next(x['message'] for x in response if x.get('type') == 'message_start')
        assigned = labels[start['id']]
        assert len(assigned) <= 1, (arm, index, assigned)
        label = next(iter(assigned)) if assigned else None
        usage = capture['usage']
        output_chars = collections.Counter()
        for event in response:
            delta = event.get('delta', {})
            for field in ['thinking', 'text', 'signature', 'partial_json']:
                output_chars[field] += len(delta.get(field, ''))
        stats = body_stats(body)
        rows.append({'index': index, 'capture': capture['id'], 'response_message_id': start['id'], 'label': label,
                     'started_at': capture['started_at'], 'seconds': capture['ended_at'] - capture['started_at'],
                     'input_total': sum(usage.get(k, 0) for k in ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']),
                     'usage': usage, 'output_delta_chars': dict(output_chars), **stats})
    for index, row in enumerate(rows):
        if row['label'] is not None:
            row['binding'] = 'captured response message id matched CLI event'
            continue
        previous = next(r['label'] for r in reversed(rows[:index]) if r['label'] and r['label'].startswith('stage-'))
        following = next(r['label'] for r in rows[index+1:] if r['label'] and r['label'].startswith('stage-'))
        boundary = int(previous.split('-')[1])
        assert boundary in [3, 6, 9] and following == f'stage-{boundary+1:02}', (arm, index, previous, following)
        last_text = text(bodies[index]['messages'][-1]['content'])
        assert 'CRITICAL: Respond with TEXT ONLY.' in last_text and 'summary' in last_text.lower(), (arm, index)
        row['label'] = f'compact-{boundary:02}'
        row['binding'] = 'engine-internal summary request between captured preceding/following stage response IDs; summary instruction in original request'
    totals = collections.Counter()
    groups = {}
    for row in rows:
        totals.update(row['usage'])
        group = groups.setdefault(row['label'], {'requests': 0, 'input_total': 0, 'output_tokens': 0, 'input_max': 0})
        group['requests'] += 1
        group['input_total'] += row['input_total']
        group['output_tokens'] += row['usage']['output_tokens']
        group['input_max'] = max(group['input_max'], row['input_total'])
    assert sum(r['input_total'] for r in rows) == result['usage']['input_tokens']
    assert totals['output_tokens'] == result['usage']['output_tokens']
    compact_rows = []
    for compact in result['compactions']:
        boundary = compact['after_stage']
        before = next(r for r in reversed(rows) if r['label'] == f'stage-{boundary:02}')
        after = next(r for r in rows if r['label'] == f'stage-{boundary+1:02}')
        metadata = next(e['compact_metadata'] for e in compact['events'] if e.get('subtype') == 'compact_boundary')
        old_thinking = set(before['thinking_hashes'])
        old_assistant = set(before['assistant_hashes'])
        compact_rows.append({'after_stage': boundary, 'metadata': metadata,
                             'before_index': before['index'], 'after_index': after['index'],
                             'before_capture': before['capture'], 'after_capture': after['capture'],
                             'next_request_input': after['input_total'], 'before_request_input': before['input_total'],
                             'before_messages': before['messages'], 'after_messages': after['messages'],
                             'before_thinking': len(old_thinking), 'after_thinking': after['block_counts'].get('thinking', 0),
                             'old_thinking_retained': len(old_thinking & set(after['thinking_hashes'])),
                             'old_assistant_retained': len(old_assistant & set(after['assistant_hashes'])),
                             'old_assistant_count': len(old_assistant),
                             'after_signature_chars': after['block_json_chars'].get('thinking_signature', 0),
                             'after_thinking_text_chars': after['block_json_chars'].get('thinking_text', 0)})
    counts = collections.Counter(c['name'] for c in all_calls.values())
    canonical = []
    for call in all_calls.values():
        data = call.get('input', {})
        path = str(data.get('file_path', data.get('path', '')))
        if path.endswith(('INTENT.md', 'PHASE.md')) or '/sessions/' in path or 'coordinate' in call['name'] or call['name'] == 'Skill':
            canonical.append({'id': call['id'], 'name': call['name'], 'label': call['label'], 'input': data})
    unique_notes = {key: value for row in rows for key, value in row['notes'].items()}
    return {'arm': arm, 'requests': rows, 'auxiliary_requests': auxiliary, 'http_requests': len(captures), 'groups': groups, 'totals': dict(totals), 'compactions': compact_rows,
            'tool_calls': dict(counts), 'total_tool_calls': len(all_calls), 'canonical_and_recovery_calls': canonical,
            'unique_notes': unique_notes, 'thinking_context_policy': bodies[0]['context_management'],
            'request_model_settings_constant': all((b['model'], b['output_config'], b['thinking'], b['context_management']) ==
                                                  (bodies[0]['model'], bodies[0]['output_config'], bodies[0]['thinking'], bodies[0]['context_management']) for b in bodies)}


def main():
    actors = {arm: analyze(arm) for arm in ['H', 'V']}
    differences = []
    for label in sorted(set(actors['H']['groups']) | set(actors['V']['groups'])):
        h, v = (actors[a]['groups'].get(label, {'requests': 0, 'input_total': 0, 'output_tokens': 0}) for a in ['H', 'V'])
        row = {'label': label, 'H': h, 'V': v, 'input_delta': h['input_total'] - v['input_total'],
               'output_delta': h['output_tokens'] - v['output_tokens']}
        if h['requests'] and v['requests']:
            hn, vn = h['requests'], v['requests']
            hm, vm = h['input_total']/hn, v['input_total']/vn
            row['context_mean_component'] = (hn+vn)/2*(hm-vm)
            row['request_count_component'] = (hm+vm)/2*(hn-vn)
            assert abs(row['context_mean_component'] + row['request_count_component'] - row['input_delta']) < 1e-6
        differences.append(row)
    summary = {'actors': actors, 'stage_differences': differences,
               'scope': 'All 170 immutable first-main-pair executor captures; no model/API calls. Character counts are not component token counts.',
               'script_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    destination = OUT / 'analysis.json'
    assert not destination.exists(), 'Refuse to overwrite prior analysis'
    destination.write_text(json.dumps(summary, indent=2, ensure_ascii=False)+'\n')
    for arm, actor in actors.items():
        print(arm, 'totals', actor['totals'], 'tools', actor['tool_calls'])
        print(arm, 'compactions', actor['compactions'])
        print(arm, 'groups', actor['groups'])
    print('wrote', destination)


if __name__ == '__main__':
    main()
