# Scores every finished trial: for each question, whether the answer is
# right, and how the model got there (read_coordinate, the file on disk,
# running gen.py again, or nothing).
# Usage: python3 score.py [name pattern, a regular expression]
# CHX_CONFIG_DIR: the Claude Code profile the trials ran in (default ~/.claude).
# CHX_RUNS: the folder run-trial.sh wrote to (default runs/ here).
import glob, json, os, re, sys, collections

X = os.environ.get('CHX_RUNS', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'runs'))
PROJECTS = os.path.join(os.path.expanduser(os.environ.get('CHX_CONFIG_DIR', '~/.claude')), 'projects')
PROBES = ['retry_limit', 'timeout_ms set to when you first read', 'line 217']
prefix = sys.argv[1] if len(sys.argv) > 1 else ''


def transcript_of(name):
    # Claude Code names a project folder after its path, with / and . as -.
    hits = [p for p in glob.glob(f'{PROJECTS}/*/*.jsonl') if p.split('/')[-2].endswith(f'-trials-{name}')]
    return max(hits, key=os.path.getmtime) if hits else None


def route_of(uses):
    routes = []
    for u in uses:
        n, i = u.get('name', ''), u.get('input') or {}
        cmd = str(i.get('command', ''))
        if 'read_coordinate' in n: routes.append('archive')
        # Claude Code's own session record keeps every tool result verbatim.
        elif '/projects/' in json.dumps(i) and '.jsonl' in json.dumps(i): routes.append('transcript')
        elif n == 'Read' and 'config.yaml' in str(i.get('file_path', '')): routes.append('disk')
        elif n == 'Bash' and 'gen.py' in cmd: routes.append('rerun')
        elif n == 'Bash' and 'config.yaml' in cmd: routes.append('disk')
        elif n: routes.append(n)
    return '+'.join(dict.fromkeys(routes)) or 'none'


rows = []
for truth_path in sorted(glob.glob(f'{X}/truth/*.json')):
    name = os.path.basename(truth_path)[:-5]
    if not re.search(prefix, name): continue
    path = transcript_of(name)
    gen_path = f'{X}/truth/{name}-gen.txt'
    if path is None or not os.path.exists(gen_path): continue
    truth = json.load(open(truth_path))
    gen = open(gen_path).read().split('\n')
    token217 = gen[216].split(': ', 1)[1] if len(gen) > 216 else None
    answers = {'retry_limit': str(truth['retry_limit']), 'timeout_ms set to when you first read': str(truth['timeout_old']), 'line 217': token217}
    wrong_hint = {'timeout_ms set to when you first read': str(truth['timeout_new'])}

    # The conversation in order: the person's prompts, tool uses, answers.
    turns = []
    compacted = False
    seen = set()
    for line in open(path, errors='replace'):
        try: r = json.loads(line)
        except Exception: continue
        if r.get('uuid') in seen: continue
        seen.add(r.get('uuid'))
        if r.get('subtype') == 'compact_boundary': compacted = True
        m = r.get('message') or {}; c = m.get('content')
        if r.get('type') == 'user' and not r.get('isMeta') and not r.get('isCompactSummary'):
            text = c if isinstance(c, str) else ' '.join(b.get('text', '') for b in (c or []) if isinstance(b, dict) and b.get('type') == 'text')
            probe = next((p for p in PROBES if p in text), None)
            if probe: turns.append({'probe': probe, 'uses': [], 'text': ''})
        elif r.get('type') == 'assistant' and isinstance(c, list) and turns:
            for b in c:
                if b.get('type') == 'tool_use': turns[-1]['uses'].append(b)
                if b.get('type') == 'text': turns[-1]['text'] = b.get('text', '')
    arm = name.split('-')[0]
    for t in turns:
        text = t['text'].strip()
        if t['probe'] == 'line 217':
            found = re.findall(r'\b[a-z0-9]{10}\b', text)
        else:
            found = re.findall(r'\b\d+\b', text)
        first = found[0] if found else None
        abstain = re.search(r'(알 수 없|확인할 수 없|확인하지 못|확인할 수 못|모르|기억(하지|할 수) 못|답할 수 없|남아 있지 않|볼 수 없|보지 못|I (don.t|cannot|can.t)|unknown|not available)', text[:120], re.I) is not None
        if abstain or first is None: verdict = 'abstain'
        elif first == answers[t['probe']]: verdict = 'right'
        elif t['probe'] in wrong_hint and first == wrong_hint[t['probe']]: verdict = 'stale'
        else: verdict = 'wrong'
        rows.append((arm, name, ['P1 disk', 'P2 changed', 'P3 rerun'][PROBES.index(t['probe'])], verdict, route_of(t['uses']), compacted, text[:40].replace('\n', ' ')))

for r in rows: print(f'{r[0]:3} {r[1]:10} {r[2]:11} {r[3]:6} via {r[4]:16} compacted={r[5]!s:5} | {r[6]}')
summary = collections.defaultdict(collections.Counter)
for arm, name, probe, verdict, route, compacted, _ in rows:
    summary[(arm, probe)][verdict] += 1
    summary[(arm, probe)][f'via {route}'] += 1
print('\n== by arm and question')
for (arm, probe), c in sorted(summary.items()):
    n = c['right'] + c['wrong'] + c['stale'] + c['abstain']
    vias = ', '.join(f'{k[4:]} {v}' for k, v in sorted(c.items()) if k.startswith('via '))
    print(f'{arm:3} {probe:11} right {c["right"]}/{n}  stale {c["stale"]}  wrong {c["wrong"]}  abstain {c["abstain"]} | {vias}')
