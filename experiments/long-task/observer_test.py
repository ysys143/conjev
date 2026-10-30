"""Test the evaluator plugin in its own host, outside the product test scan.

Product `claude plugin test .` recursively loads every *.test.ts using the
product plugin. Keep the evaluator's source tests as *.fixture.ts and copy them
to a fresh evaluator-only plugin before running its tests.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--claude", type=Path, default=Path.home() / ".local/share/claude/versions/2.1.309")
    parser.add_argument("--mutation", choices=["gate-bypassed", "reservation-bypassed"])
    args = parser.parse_args()
    source = Path(__file__).resolve().parent / "observer"
    with tempfile.TemporaryDirectory(prefix="ch-observer-test-") as temporary:
        root = Path(temporary)
        for name in [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/register.ts"]:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, target)
        fixtures = list((source / "tests").glob("*.fixture.ts"))
        if not fixtures:
            raise ValueError("No evaluator tests; zero collected is not a pass")
        (root / "tests").mkdir()
        for fixture in fixtures:
            shutil.copyfile(fixture, root / "tests" / fixture.name.replace(".fixture.ts", ".test.ts"))
        if args.mutation:
            replacements = {
                "gate-bypassed": ("const before = await $.clock.now()\n    const result = await next(e)\n    const after",
                                  "const before = await $.clock.now()\n    const result = {}\n    const after"),
                "reservation-bypassed": ("reserved = await post($, '/reserve', { request, long_context: longContext })", "reserved = { call_id: 'bypassed' }"),
            }
            old, new = replacements[args.mutation]
            path = root / "hooks/register.ts"
            text = path.read_text()
            if text.count(old) != 1:
                raise ValueError("The bounded mutation target changed")
            path.write_text(text.replace(old, new))
        return subprocess.run([str(args.claude), "plugin", "test", str(root)]).returncode


if __name__ == "__main__":
    raise SystemExit(main())
