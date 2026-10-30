"""Integer-cent ledger with exact rounding and ordered statements."""
from __future__ import annotations


def specification(token: str):
    a, b = "acct_z_" + token, "acct_a_" + token
    rows = [{"id": "tx_" + token + str(i), "account": account, "cents": amount}
            for i, (account, amount) in enumerate([(a, 125), (b, -50), (a, 75)])]
    totals = {a: 200, b: -50}
    statement = [{"account": a, "cents": 200}, {"account": b, "cents": -50}]
    amounts = [{"account": a, "amount": "0.145"}, {"account": a, "amount": "-0.005"}, {"account": b, "amount": "1.005"}]
    bad = rows + [{"id": "bad", "account": a, "cents": True}, {"id": "missing", "cents": 1}]
    summary = {"totals": totals, "statement": statement, "invalid": [3, 4]}
    def feature(name, instruction, source, cases):
        return {"name": name, "instruction": instruction, "source": source, "cases": cases}
    features = {
        1: feature("normalize", "Implement normalize(rows): each row has id, account and cents. Return new dictionaries with str(id), str(account), int(cents), in input order. Do not change the input.",
                   "def normalize(rows):\n    return [dict(id=str(r['id']), account=str(r['account']), cents=int(r['cents'])) for r in rows]\n",
                   [{"args": [rows], "expected": rows, "unchanged_args": True}, {"args": [[{"id": 4, "account": b, "cents": "9"}]], "expected": [{"id": "4", "account": b, "cents": 9}]}, {"args": [[]], "expected": []}]),
        2: feature("totals", "Implement totals(rows): normalize the rows, then return a dictionary of total integer cents by account. An empty input returns {}.",
                   "def totals(rows):\n    out = {}\n    for r in normalize(rows): out[r['account']] = out.get(r['account'], 0) + r['cents']\n    return out\n",
                   [{"args": [rows], "expected": totals}, {"args": [[]], "expected": {}}]),
        4: feature("money", "D1: Use round-half-up at two decimal places; do not use ties-to-even rounding. Implement money(value) for decimal text, returning a string with exactly two fractional digits.",
                   "def money(value):\n    return format(Decimal(str(value)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP), '.2f')\n",
                   [{"args": ["2.675"], "expected": "2.68"}, {"args": ["-0.005"], "expected": "-0.01"}, {"args": ["0"], "expected": "0.00"}]),
        5: feature("balances", "Implement balances(rows) for rows with account and amount (decimal text): sum each account exactly and format the result using money. Return {} for no rows.",
                   "def balances(rows):\n    out = {}\n    for r in rows: out[r['account']] = out.get(r['account'], Decimal(0)) + Decimal(r['amount'])\n    return {a: money(v) for a, v in out.items()}\n",
                   [{"args": [amounts], "expected": {a: "0.14", b: "1.01"}}, {"args": [[]], "expected": {}}]),
        6: feature("statement", "D2: Use first-seen account order; do not sort account IDs. Implement statement(rows), returning a list of {account, cents} totals under that decision.",
                   "def statement(rows):\n    return [dict(account=a, cents=v) for a, v in totals(rows).items()]\n",
                   [{"args": [rows], "expected": statement}, {"args": [[]], "expected": []}]),
        7: feature("convert", "Implement convert(cents, numerator, denominator): multiply by the rational rate, use the previously selected rounding behavior at the integer-cent boundary, and return an int. A nonpositive denominator raises ValueError.",
                   "def convert(cents, numerator, denominator):\n    if denominator <= 0: raise ValueError('denominator')\n    return int((Decimal(cents) * Decimal(numerator) / Decimal(denominator)).quantize(Decimal(1), rounding=ROUND_HALF_UP))\n",
                   [{"args": [5, 1, 2], "expected": 3}, {"args": [-5, 1, 2], "expected": -3}, {"args": [4, 3, 2], "expected": 6}, {"args": [1, 1, 0], "raises": "ValueError"}]),
        9: feature("audit", "Implement audit(rows): return invalid row indexes in input order. A valid row has an id, a nonempty string account and cents whose exact type is int (bool is invalid). Do not alter rows.",
                   "def audit(rows):\n    return [i for i,r in enumerate(rows) if 'id' not in r or not isinstance(r.get('account'), str) or not r['account'] or type(r.get('cents')) is not int]\n",
                   [{"args": [bad], "expected": [3, 4], "unchanged_args": True}, {"args": [rows], "expected": []}]),
        11: feature("reconcile", "Implement reconcile(rows): exclude indexes returned by audit; return {totals, statement, invalid, policy}. policy merges early_config() and middle_config(). Reuse the earlier decisions.",
                    "def reconcile(rows):\n    invalid = audit(rows)\n    valid = [r for i,r in enumerate(rows) if i not in invalid]\n    return dict(totals=totals(valid), statement=statement(valid), invalid=invalid, policy={**early_config(), **middle_config()})\n",
                    [{"args": [bad], "expected": summary, "policy_expected": True}]),
        12: feature("report", "Implement report(rows): return {ledger: reconcile(rows), configuration: merged early_config/middle_config/late_config}. Verify the full API with tests and document its callable functions in README.md.",
                    "def report(rows):\n    return dict(ledger=reconcile(rows), configuration={**early_config(), **middle_config(), **late_config()})\n",
                    [{"args": [bad], "expected": {"ledger": summary}, "report_expected": "ledger"}]),
    }
    return {"title": "Ledger " + token, "header": "from decimal import Decimal, ROUND_HALF_UP\n", "features": features,
            "decision_functions": {"D1": ["money", "balances", "convert"], "D2": ["statement", "reconcile", "report"]}}
