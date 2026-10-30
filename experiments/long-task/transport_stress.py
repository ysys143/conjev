"""Exercise repeated large native subscription uploads before another pilot."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from driver import DEFAULT_MODEL, PersistentSession, assistant_text
from grading import check_subscription, file_digest, load, write_new


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--claude', type=Path, default=Path.home() / '.local/share/claude/versions/2.1.309')
    parser.add_argument('--turns', type=int, default=24)
    args = parser.parse_args()
    version = check_subscription(args.claude, args.config)
    task = args.root / 'task'
    task.mkdir(parents=True, exist_ok=False)
    runtime = Path(__file__).resolve().parent
    sources = {str(runtime / (name + '.py')): file_digest(runtime / (name + '.py'))
               for name in ['capture', 'curl_transport', 'driver', 'grading', 'transport_stress']}
    write_new(args.root / 'source-before.json', sources)
    session = PersistentSession(binary=args.claude, config=args.config, model=DEFAULT_MODEL,
                                workspace=task, evidence=args.root / 'evidence', plugin=None,
                                settings={'alwaysThinkingEnabled': True, 'enabledPlugins': {}})
    turns = []
    try:
        padding = 'transport load padding; ignore this diagnostic data.\n' * 22000
        for index in range(args.turns):
            prompt = ('Ignore the following diagnostic padding; do not summarize or quote it.\n<data>\n'
                      + padding + '\n</data>\nReply with exactly OK. Do not use tools.'
                      if index == 0 else 'Reply with exactly OK. Do not use tools.')
            events = session.stage(prompt, timeout=600)
            row = {'turn': index + 1, 'answer': assistant_text(events)}
            write_new(args.root / 'turns' / f'{index + 1:02}.json', row)
            turns.append(row)
        closure = session.close(drain_seconds=2.5)
        records = [load(p) for p in (args.root / 'evidence/requests').glob('*.json')]
        messages = [r for r in records if r.get('path', '').split('?', 1)[0] == '/v1/messages']
        checks = {'all_turns_answered': len(turns) == args.turns and all(r['answer'] == 'OK' for r in turns),
                  'closed_with_complete_capture': closure['runner_observed_end'] and closure['evidence_complete'],
                  'large_uploads_exercised': len(messages) >= args.turns and all(r.get('request_bytes', 0) >= 1_000_000 for r in messages),
                  'all_uploads_sent_exactly': all(r.get('body_bytes_sent') == r.get('request_bytes') for r in messages),
                  'pooled_connections_exercised': bool(messages) and all(r.get('upstream_backend') == 'stdlib-pooled' for r in messages)
                      and sum(r.get('upstream_connection_reused') is True for r in messages) >= len(messages) * .9,
                  'actual_model_effort_match': bool(messages) and all(
                      (b := json.loads(r['request_body'])).get('model') == DEFAULT_MODEL
                      and b.get('output_config', {}).get('effort') == 'max'
                      and b.get('thinking', {}).get('type') == 'adaptive' for r in messages),
                  'sources_unchanged': all(file_digest(Path(p)) == expected for p, expected in sources.items())}
        write_new(args.root / 'probe.json', {'passed': all(checks.values()), 'checks': checks,
                  'cli': version, 'closure': closure, 'request_count': len(messages),
                  'upstream_connections': len({r.get('upstream_connection_id') for r in messages}),
                  'connection_reuses': sum(r.get('upstream_connection_reused') is True for r in messages),
                  'failures': [{k: r.get(k) for k in ['id', 'error', 'error_phase', 'request_bytes', 'body_bytes_sent', 'status']}
                               for r in messages if not r.get('complete')],
                  'limits': ['A transport stress probe, not a scored task or pilot.', 'No Jev calls.']})
        if not all(checks.values()):
            raise RuntimeError('Large-upload transport probe failed; preserve every request')
    except BaseException:
        if session.process.poll() is None:
            session.abort()
        raise


if __name__ == '__main__':
    main()
