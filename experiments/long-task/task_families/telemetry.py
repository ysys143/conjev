"""JSON event analysis with exact source identities and first-occurrence dedup."""
from __future__ import annotations

import json


def specification(token: str):
    upper, lower = "SRC_" + token, "src_" + token
    events = [dict(id="event_z_" + token, source=upper, level="info", ts=4, value=2),
              dict(id="event_a_" + token, source=lower, level="warn", ts=7, value=9),
              dict(id="event_z_" + token, source=upper, level="error", ts=11, value=20),
              dict(id="event_k_" + token, source=lower, level="info", ts=15, value=5)]
    lines = [json.dumps(e) for e in events]
    chosen = [events[0], events[1], events[3]]
    analysis = {"events": chosen, "counts": {"info": 2, "warn": 1}, "sources": {upper: [events[0]["id"]], lower: [events[1]["id"], events[3]["id"]]}}
    def f(name, instruction, source, cases):
        return {"name": name, "instruction": instruction, "source": source, "cases": cases}
    features = {
        1: f("parse", "Implement parse(lines): skip blank strings, parse every other line as a JSON object, and retain order. Invalid JSON or a non-object raises ValueError.",
             "def parse(lines):\n    out = []\n    for line in lines:\n        if not line.strip(): continue\n        try: value = json.loads(line)\n        except ValueError: raise ValueError('invalid JSON') from None\n        if not isinstance(value, dict): raise ValueError('object required')\n        out.append(value)\n    return out\n",
             [{"args": [["", *lines, "  "]], "expected": events}, {"args": [["[1]"]], "raises": "ValueError"}, {"args": [["not JSON"]], "raises": "ValueError"}]),
        2: f("counts", "Implement counts(events), returning counts by the exact level string. An empty input returns {}.",
             "def counts(events):\n    out = {}\n    for e in events: out[e['level']] = out.get(e['level'], 0) + 1\n    return out\n",
             [{"args": [events], "expected": {"info": 2, "warn": 1, "error": 1}}, {"args": [[]], "expected": {}}]),
        4: f("group", "D1: Preserve exact, case-sensitive source identifiers; do not lowercase or case-fold them. Implement group(events), mapping each source to its event IDs in input order.",
             "def group(events):\n    out = {}\n    for e in events: out.setdefault(e['source'], []).append(e['id'])\n    return out\n",
             [{"args": [events], "expected": {upper: [events[0]["id"], events[2]["id"]], lower: [events[1]["id"], events[3]["id"]]}}, {"args": [[]], "expected": {}}]),
        5: f("window", "Implement window(events, start, end): retain events whose ts satisfies start <= ts < end, in input order.",
             "def window(events, start, end):\n    return [e for e in events if start <= e['ts'] < end]\n",
             [{"args": [events, 5, 12], "expected": events[1:3]}, {"args": [events, 4, 7], "expected": events[:1]}, {"args": [events, 20, 30], "expected": []}]),
        6: f("unique", "D2: For duplicate event IDs keep the first occurrence, not the last. Implement unique(events), preserving that occurrence order.",
             "def unique(events):\n    seen, out = set(), []\n    for e in events:\n        if e['id'] not in seen: seen.add(e['id']); out.append(e)\n    return out\n",
             [{"args": [events], "expected": chosen}, {"args": [[]], "expected": []}]),
        7: f("histogram", "Implement histogram(events, width): count ts buckets using integer floor division, with string bucket keys. A nonpositive width raises ValueError.",
             "def histogram(events, width):\n    if width <= 0: raise ValueError('width')\n    out = {}\n    for e in events:\n        key = str(e['ts'] // width)\n        out[key] = out.get(key, 0) + 1\n    return out\n",
             [{"args": [events, 5], "expected": {"0": 1, "1": 1, "2": 1, "3": 1}}, {"args": [events, 0], "raises": "ValueError"}]),
        9: f("anomalies", "Implement anomalies(events, threshold): return IDs with value strictly greater than threshold, in input order, without deduplication.",
             "def anomalies(events, threshold):\n    return [e['id'] for e in events if e['value'] > threshold]\n",
             [{"args": [events, 8], "expected": [events[1]["id"], events[2]["id"]]}, {"args": [events, 20], "expected": []}]),
        11: f("analyze", "Implement analyze(lines, start, end): parse, then window, then unique. Return {events, counts, sources, policy}, reusing counts/group and merging early_config/middle_config into policy. Follow the earlier decisions.",
              "def analyze(lines, start, end):\n    selected = unique(window(parse(lines), start, end))\n    return dict(events=selected, counts=counts(selected), sources=group(selected), policy={**early_config(), **middle_config()})\n",
              [{"args": [lines, 0, 20], "expected": analysis, "policy_expected": True},
               {"args": [lines, 5, 20], "expected": {"events": events[1:], "counts": {"warn": 1, "error": 1, "info": 1}, "sources": {lower: [events[1]["id"], events[3]["id"]], upper: [events[2]["id"]]}}, "policy_expected": True}]),
        12: f("report", "Implement report(lines, start, end), returning {analysis: analyze(...), configuration: merged early_config/middle_config/late_config}. Verify all APIs and document callable functions in README.md.",
              "def report(lines, start, end):\n    return dict(analysis=analyze(lines, start, end), configuration={**early_config(), **middle_config(), **late_config()})\n",
              [{"args": [lines, 0, 20], "expected": {"analysis": analysis}, "report_expected": "analysis"}]),
    }
    return {"title": "Telemetry " + token, "header": "import json\n", "features": features,
            "decision_functions": {"D1": ["group", "analyze", "report"], "D2": ["unique", "analyze", "report"]}}
