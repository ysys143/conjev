"""Stable-priority job routing without mutation of caller-owned jobs."""
from __future__ import annotations


def specification(token: str):
    qz, qa = "queue_z_" + token, "queue_a_" + token
    jobs = [{"id": "job_" + name + token, "queue": queue, "priority": p, "enabled": enabled}
            for name, queue, p, enabled in [("z", qz, 2, True), ("a", qa, 2, True), ("h", qz, 5, True), ("off", qa, 9, False)]]
    ready, ranked = jobs[:3], [jobs[2], jobs[0], jobs[1]]
    workers = ["worker_z_" + token, "worker_a_" + token]
    assigned = [dict(j, worker=workers[i % 2]) for i,j in enumerate(ready)]
    retry_jobs = [dict(j, attempts=n) for j,n in zip(jobs, [0, 3, 2, 0])]
    planned = {"assignments": [dict(jobs[2], worker=workers[0]), dict(jobs[0], worker=workers[1])], "queues": {qz: 2}}
    def f(name, instruction, source, cases):
        return {"name": name, "instruction": instruction, "source": source, "cases": cases}
    features = {
        1: f("ready", "Implement ready(jobs): return enabled jobs in input order. Missing enabled means true.",
             "def ready(jobs):\n    return [j for j in jobs if j.get('enabled', True)]\n",
             [{"args": [jobs], "expected": ready}, {"args": [[{"id": "bare"}]], "expected": [{"id": "bare"}]}, {"args": [[]], "expected": []}]),
        2: f("by_queue", "Implement by_queue(jobs): group ready job IDs by queue, retaining input order in each list. Empty input returns {}.",
             "def by_queue(jobs):\n    out = {}\n    for j in ready(jobs): out.setdefault(j['queue'], []).append(j['id'])\n    return out\n",
             [{"args": [jobs], "expected": {qz: [jobs[0]["id"], jobs[2]["id"]], qa: [jobs[1]["id"]]}}, {"args": [[]], "expected": {}}]),
        4: f("rank", "D1: For equal priority, preserve arrival order; do not break ties alphabetically. Implement rank(jobs), returning ready job dictionaries in descending priority (missing priority is 0).",
             "def rank(jobs):\n    return sorted(ready(jobs), key=lambda j: j.get('priority', 0), reverse=True)\n",
             [{"args": [jobs], "expected": ranked}, {"args": [[]], "expected": []}]),
        5: f("dispatch", "Implement dispatch(jobs, capacity): return at most capacity jobs from rank(jobs). A negative capacity raises ValueError.",
             "def dispatch(jobs, capacity):\n    if capacity < 0: raise ValueError('capacity')\n    return rank(jobs)[:capacity]\n",
             [{"args": [jobs, 2], "expected": ranked[:2]}, {"args": [jobs, 0], "expected": []}, {"args": [jobs, -1], "raises": "ValueError"}]),
        6: f("assign", "D2: Do not mutate caller-owned jobs. Return new dictionaries for assignment. Implement assign(jobs, workers), adding worker round-robin in the supplied job order. No workers raises ValueError.",
             "def assign(jobs, workers):\n    if not workers: raise ValueError('workers')\n    return [dict(j, worker=workers[i % len(workers)]) for i,j in enumerate(jobs)]\n",
             [{"args": [ready, workers], "expected": assigned, "unchanged_args": True}, {"args": [[], workers], "expected": [], "unchanged_args": True}, {"args": [ready, []], "raises": "ValueError", "unchanged_args": True}]),
        7: f("retryable", "Implement retryable(jobs): return ready jobs with attempts < 3 (missing attempts is 0), in input order. Follow the earlier ownership decision.",
             "def retryable(jobs):\n    return [j for j in ready(jobs) if j.get('attempts', 0) < 3]\n",
             [{"args": [retry_jobs], "expected": [retry_jobs[0], retry_jobs[2]], "unchanged_args": True}, {"args": [[]], "expected": []}]),
        9: f("stats", "Implement stats(jobs), returning {ready: number of ready jobs, queues: counts of ready jobs per queue}.",
             "def stats(jobs):\n    return dict(ready=len(ready(jobs)), queues={q:len(ids) for q,ids in by_queue(jobs).items()})\n",
             [{"args": [jobs], "expected": {"ready": 3, "queues": {qz: 2, qa: 1}}, "unchanged_args": True}, {"args": [[]], "expected": {"ready": 0, "queues": {}}}]),
        11: f("plan", "Implement plan(jobs, capacity, workers): dispatch, then assign; return {assignments, queues, policy}. queues counts the dispatched jobs. policy merges early_config and middle_config. Reuse the earlier decisions.",
              "def plan(jobs, capacity, workers):\n    selected = dispatch(jobs, capacity)\n    return dict(assignments=assign(selected, workers), queues=stats(selected)['queues'], policy={**early_config(), **middle_config()})\n",
              [{"args": [jobs, 2, workers], "expected": planned, "policy_expected": True, "unchanged_args": True}]),
        12: f("report", "Implement report(jobs, capacity, workers), returning {plan: plan(...), configuration: merged early_config/middle_config/late_config}. Verify all APIs and document callable functions in README.md.",
              "def report(jobs, capacity, workers):\n    return dict(plan=plan(jobs, capacity, workers), configuration={**early_config(), **middle_config(), **late_config()})\n",
              [{"args": [jobs, 2, workers], "expected": {"plan": planned}, "report_expected": "plan", "unchanged_args": True}]),
    }
    return {"title": "Router " + token, "header": "", "features": features,
            "decision_functions": {"D1": ["rank", "dispatch", "plan", "report"], "D2": ["assign", "retryable", "stats", "plan", "report"]}}
