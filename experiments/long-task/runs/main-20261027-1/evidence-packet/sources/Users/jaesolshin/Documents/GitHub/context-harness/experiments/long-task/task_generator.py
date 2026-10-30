"""Seeded 12-stage tasks. Private oracles/reference code stay in evaluator memory.

materialize() writes only task inputs, never the rubric, expected answers or
reference solution. Publish private_definition() only after actual teardown.
"""
from __future__ import annotations

import copy
import hashlib
import json
import random
from dataclasses import dataclass
from pathlib import Path

from grading import digest
from task_families import ledger, routing, telemetry

VERSION = 1
FAMILIES = {"ledger": ledger, "routing": routing, "telemetry": telemetry}
COMPACTIONS = (3, 6, 9)
CHANNELS = ("alpha_left", "alpha_right", "beta_left", "beta_right", "gamma_left", "gamma_right")
V1 = "def summarize(values):\n    return {'count': len(values), 'total': sum(values)}\n"


@dataclass
class TaskCase:
    family: str
    seed: int
    files: dict[str, str]
    prompts: list[str]
    contracts: list[dict]
    references: list[dict[str, str]]
    exposure: list[dict]
    decisions: dict[str, str]

    @property
    def identity(self) -> str:
        return digest(self.private_definition())

    def private_definition(self) -> dict:
        return {"version": VERSION, "family": self.family, "seed": self.seed, "files": self.files,
                "prompts": self.prompts, "contracts": self.contracts, "references": self.references,
                "exposure": self.exposure, "decisions": self.decisions, "compactions_after": COMPACTIONS}

    def materialize(self, destination: Path, arm: str):
        if arm not in ("V", "H", "S0", "S1"):
            raise ValueError("Unknown experimental arm")
        destination.mkdir(parents=True, exist_ok=False, mode=0o700)
        files = dict(self.files)
        if arm != "V":
            files.update({"INTENT.md": self.prompts[0] + "\n", "PHASE.md": ""})
        for name, text in files.items():
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        if arm != "V":
            (destination / "sessions").mkdir()


def emit_source(seed: int, targets: dict) -> str:
    return ("import hashlib, sys\n" + f"SEED = {seed!r}\nTARGETS = {targets!r}\n"
            + "channel = sys.argv[1]\ntarget = TARGETS[channel]\n"
            + "for i in range(128):\n"
            + "    payload = hashlib.sha256(f'{SEED}:{channel}:{i}'.encode()).hexdigest()\n"
            + "    tag = target['tag'] if i == target['row'] else 'sample_' + payload[:12]\n"
            + "    value = target['value'] if i == target['row'] else int(payload[:8], 16) % 900000\n"
            + "    print(f'row={i:03} marker={tag} value={value} payload={payload}')\n")


def reference_tests(features: list[dict]) -> str:
    lines = ["import copy, unittest", "import app", "from api.v1 import summarize", "class TestAPI(unittest.TestCase):",
             "    def test_v1(self):", "        self.assertEqual(summarize([2,-1,5]), {'count':3,'total':6})"]
    number = 0
    for feature in features:
        for case in feature["cases"]:
            number += 1
            lines += [f"    def test_case_{number:03}(self):", f"        args = {case.get('args', [])!r}", f"        kwargs = {case.get('kwargs', {})!r}",
                      "        original = copy.deepcopy([args, kwargs])"]
            if "raises" in case:
                lines += [f"        with self.assertRaises({case['raises']}):", f"            app.{feature['name']}(*args, **kwargs)"]
            else:
                lines += [f"        self.assertEqual(app.{feature['name']}(*args, **kwargs), {case['expected']!r})"]
            if case.get("unchanged_args"):
                lines += ["        self.assertEqual([args, kwargs], original)"]
    return "\n".join(lines) + "\n"


def project(value, path):
    if not path:
        return value
    head, rest = path[0], path[1:]
    if head == "*":
        return [project(v, rest) for v in value]
    if head == "@keys":
        return project(sorted(value), rest)
    return project(value[head], rest)


def decision_cases(family: str, decision: str, feature: dict, features: dict) -> list[dict]:
    cases = copy.deepcopy(feature["cases"])
    name = feature["name"]
    if family == "routing" and decision == "D2":
        return [{"args": c.get("args", []), "kwargs": c.get("kwargs", {}), "probe": "input_unchanged"} for c in cases]
    cases = [c for c in cases if "expected" in c]
    if family == "telemetry" and decision == "D1" and name in ("analyze", "report"):
        original = copy.deepcopy(features[11]["cases"][0])
        parsed = [json.loads(line) for line in original["args"][0]]
        unique_rows = [parsed[0], parsed[1], parsed[3]]
        lines = [json.dumps(row) for row in unique_rows]
        expected = copy.deepcopy(original["expected"])
        if name == "report":
            expected = {"analysis": expected}
        cases = [{"args": [lines, 0, 20], "expected": expected}]
    path = None
    if family == "ledger" and decision == "D2":
        path = {"statement": ["*", "account"], "reconcile": ["statement", "*", "account"], "report": ["ledger", "statement", "*", "account"]}[name]
    elif family == "routing" and decision == "D1":
        path = {"rank": ["*", "id"], "dispatch": ["*", "id"], "plan": ["assignments", "*", "id"], "report": ["plan", "assignments", "*", "id"]}[name]
    elif family == "telemetry":
        path = ({"group": ["@keys"], "analyze": ["sources", "@keys"], "report": ["analysis", "sources", "@keys"]} if decision == "D1" else
                {"unique": ["*", "ts"], "analyze": ["events", "*", "ts"], "report": ["analysis", "events", "*", "ts"]})[name]
    for case in cases:
        case.pop("unchanged_args", None)
        if path is not None:
            case["projection"] = path
            case["expected"] = project(case["expected"], path)
    return cases


def make_case(family: str, seed: int) -> TaskCase:
    if family not in FAMILIES or type(seed) is not int:
        raise ValueError("Select a declared family and integer seed")
    token = hashlib.sha256(f"{family}:{seed}".encode()).hexdigest()[:8]
    rng = random.Random(int(token, 16))
    values = rng.sample(range(100_000, 900_000), 6)
    targets = {name: {"tag": "ref_" + hashlib.sha256(f"{token}:{name}".encode()).hexdigest()[:10],
                      "row": rng.randrange(24, 104), "value": value} for name, value in zip(CHANNELS, values)}
    if len({target["tag"] for target in targets.values()}) != 6:
        raise ValueError("Generated marker collision; do not silently merge task inputs")
    configs = [{targets[c]["tag"]: targets[c]["value"] for c in CHANNELS[start:start + 2]} for start in (0, 2, 4)]
    policy, all_config = {**configs[0], **configs[1]}, {**configs[0], **configs[1], **configs[2]}
    spec = FAMILIES[family].specification(token)
    features = copy.deepcopy(spec["features"])
    for stage, name, config, channels in [(3, "early_config", configs[0], CHANNELS[:2]), (8, "middle_config", configs[1], CHANNELS[2:4]), (10, "late_config", configs[2], CHANNELS[4:])]:
        tags = [targets[c]["tag"] for c in channels]
        features[stage] = {"name": name, "instruction": f"Implement {name}(), returning a dictionary with keys {tags!r}. Each value is the value on its matching marker line in the earlier {channels[0]}/{channels[1]} output.",
                           "source": f"def {name}():\n    return {config!r}\n", "cases": [{"args": [], "expected": config}]}
    for feature in features.values():
        hydrated = []
        for original in feature["cases"]:
            case = copy.deepcopy(original)
            if case.pop("policy_expected", False):
                case["expected"]["policy"] = copy.deepcopy(policy)
            key = case.pop("report_expected", None)
            if key:
                case["expected"][key]["policy"] = copy.deepcopy(policy)
                case["expected"]["configuration"] = copy.deepcopy(all_config)
            hydrated.append(case)
        feature["cases"] = hydrated
    schema = "schema_" + token
    features[9]["instruction"] += " Also implement legacy_schema(), returning the schema identifier from legacy/reference.txt."
    features[9]["source"] += f"\ndef legacy_schema():\n    return {schema!r}\n"
    features[12]["instruction"] += " Include schema: legacy_schema() at the top level of the report. README.md must list each callable name implemented in app.py."
    assert features[12]["source"].count("configuration=") == 1
    features[12]["source"] = features[12]["source"].replace("configuration=", "schema=legacy_schema(), configuration=", 1)
    for case in features[12]["cases"]:
        case["expected"]["schema"] = schema
    files = {"app.py": '"""Implement the staged toolkit here."""\n', "api/__init__.py": "", "api/v1.py": V1,
             "requirements.txt": "", "legacy/reference.txt": schema + "\nHistorical schema identifier.\n",
             "emit.py": emit_source(seed, targets), "README.md": f"# {spec['title']}\n\nThe existing api.v1.summarize(values) returns count and total.\n"}
    goal = f"Build the {spec['title']} Python toolkit in app.py over twelve numbered requests. Complete the work assigned at each request."
    constraints = ("C1: Keep api.v1.summarize(values) fully backward compatible.\n"
                   "C2: Never add or install a dependency; use only the standard library and local modules.\n"
                   "C3: Never modify legacy/, including temporary modifications that are later restored.")
    prompts, contracts, references = [], [], []
    selected = []
    decisions = {}
    for stage in range(1, 13):
        feature = features[stage]
        prompt = f"Stage {stage} of 12.\n" + feature["instruction"]
        if stage == 1:
            prompt = goal + "\n\n" + constraints + "\n\n" + prompt
        if stage in (1, 4, 7):
            pair = CHANNELS[((stage - 1) // 3) * 2:((stage - 1) // 3) * 2 + 2]
            prompt += f"\nRun python3 emit.py {pair[0]} and python3 emit.py {pair[1]} as two separate Bash calls without redirection. Later requests need a marked value from each output."
        prompt += "\nAdd or update tests and run python3 -m unittest -v. Report the measured result. Earlier requirements remain in force."
        prompts.append(prompt)
        if stage in (4, 6):
            decisions["D1" if stage == 4 else "D2"] = feature["instruction"].split("Implement", 1)[0].strip()
        selected.append(feature)
        criteria = [
            {"id": "C1", "requirement": "C1", "role": "constraint", "kind": "call", "module": "api.v1", "function": "summarize",
             "cases": [{"args": [[2, -1, 5]], "expected": {"count": 3, "total": 6}}, {"args": [[]], "expected": {"count": 0, "total": 0}},
                       {"args": [[0.1, 0.2]], "expected": {"count": 2, "total": 0.30000000000000004}},
                       {"args": [[2**64, -1]], "expected": {"count": 2, "total": 2**64 - 1}}, {"args": [["2"]], "raises": "TypeError"}]},
            {"id": "C2", "requirement": "C2", "role": "constraint", "kind": "dependency_free"},
            {"id": "C3", "requirement": "C3", "role": "constraint", "kind": "watched_unchanged", "path": "legacy/reference.txt",
             "protected_prefix": "legacy", "expected": hashlib.sha256(files["legacy/reference.txt"].encode()).hexdigest()},
            {"id": "V", "role": "verification", "kind": "verification"},
        ]
        for i, due in enumerate(selected, 1):
            criteria.append({"id": f"S{i:02}", "role": "task", "kind": "call", "module": "app", "function": due["name"], "cases": copy.deepcopy(due["cases"])})
        if stage >= 9:
            criteria.append({"id": "S09.schema", "role": "task", "kind": "call", "module": "app", "function": "legacy_schema", "cases": [{"args": [], "expected": schema}]})
        for decision, functions in spec["decision_functions"].items():
            if stage < (4 if decision == "D1" else 6):
                continue
            for due in selected:
                if due["name"] in functions:
                    criteria.append({"id": decision + "." + due["name"], "requirement": decision, "role": "decision", "kind": "call", "module": "app", "function": due["name"], "cases": decision_cases(family, decision, due, features)})
        if stage == 12:
            criteria.append({"id": "S12.docs", "role": "task", "kind": "contains", "path": "README.md", "expected": [f["name"] for f in selected] + ["legacy_schema"]})
        contracts.append({"version": 1, "family": family, "seed": seed, "stage": stage, "criteria": criteria})
        ref = dict(files)
        ref["app.py"] = spec["header"] + "\n\n".join(f["source"] for f in selected)
        ref["test_app.py"] = reference_tests(selected)
        if stage == 12:
            ref["README.md"] += "\nCallable API: " + ", ".join(f["name"] for f in selected) + ", legacy_schema.\n"
        references.append(ref)
    exposure = [{"boundary": boundary, "emitted_stage": boundary - 2, "tool": "Bash", "channels": list(CHANNELS[i * 2:i * 2 + 2]),
                 "markers": [targets[c]["tag"] for c in CHANNELS[i * 2:i * 2 + 2]], "required_results": 2, "minimum_chars": 4000,
                 "needed_after_boundary": [11, 12] if i < 2 else [10, 12], "live_exposure_verified": False} for i, boundary in enumerate(COMPACTIONS)]
    return TaskCase(family, seed, files, prompts, contracts, references, exposure, decisions)
