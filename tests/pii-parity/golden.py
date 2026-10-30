"""Reference output of maskingtape (Python) for the parity harness.

Reads JSONL rows with a "text" field and writes one JSON line per input:
detections as (kind, start, end) in code points and in UTF-16 units, and the
masked text.
"""
import json, sys
import maskingtape
from maskingtape import Pipeline

def u16(text, i):
    return len(text[:i].encode('utf-16-le')) // 2

pipe = Pipeline()
with open(sys.argv[-1], 'w', encoding='utf-8') as out:
    for path in sys.argv[1:-1]:
        for n, line in enumerate(open(path, encoding='utf-8')):
            if not line.strip():
                continue
            text = json.loads(line)['text']
            r = pipe.anonymize(text)
            dets = sorted((d.kind, d.start, d.end) for d in r.detections)
            out.write(json.dumps({
                'id': f'{path.rsplit("/", 1)[-1]}:{n}',
                'text': text,
                'detections': [{'kind': k, 'start': s, 'end': e, 'start16': u16(text, s), 'end16': u16(text, e)} for k, s, e in dets],
                'masked': r.text,
            }, ensure_ascii=False) + '\n')
print('maskingtape', getattr(maskingtape, '__version__', '?'), file=sys.stderr)
