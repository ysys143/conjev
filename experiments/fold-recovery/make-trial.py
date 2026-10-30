# Usage: make-trial.py <trial dir> <truth json>
# Writes config.yaml and gen.py into the trial dir, and the answers to <truth json>.
import json, os, random, string, sys
trial, truth_path = sys.argv[1], sys.argv[2]
os.makedirs(trial, exist_ok=True)
rng = random.Random(os.urandom(16))
words = ['alpha', 'bravo', 'cache', 'delta', 'echo', 'fetch', 'grid', 'hash', 'index', 'jitter', 'kernel', 'ledger', 'mirror', 'node', 'orbit', 'pool']
keys = set()
while len(keys) < 118:
    keys.add(f'{rng.choice(words)}_{rng.choice(words)}_{rng.randint(1, 99)}')
values = {k: rng.randint(100, 99999) for k in sorted(keys)}
retry, timeout_old, timeout_new = rng.randint(2, 97), rng.randint(1000, 4999), rng.randint(5000, 9999)
lines = [f'{k}: {v}' for k, v in values.items()]
lines.insert(37, f'retry_limit: {retry}')
lines.insert(81, f'timeout_ms: {timeout_old}')
open(f'{trial}/config.yaml', 'w').write('# service settings\n' + '\n'.join(lines) + '\n')
open(f'{trial}/gen.py', 'w').write('''import os, random, string
rng = random.Random(os.urandom(16))
out = [f"{i:03d}: " + "".join(rng.choice(string.ascii_lowercase + string.digits) for _ in range(10)) for i in range(1, 301)]
print("\\n".join(out))
truth = os.environ.get("GEN_TRUTH")
if truth:
    if os.path.exists(truth):
        with open(truth + ".reruns", "a") as fh: fh.write("rerun\\n")
    else:
        with open(truth, "w") as fh: fh.write("\\n".join(out) + "\\n")
''')
json.dump({'retry_limit': retry, 'timeout_old': timeout_old, 'timeout_new': timeout_new}, open(truth_path, 'w'))
