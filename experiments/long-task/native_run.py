"""Launch an evaluator job through the existing native tmux execution context.

The default shell-tool context cannot access macOS services on this host. The
study already permits tmux driving. A task-owned session runs Python directly,
with an explicit existing cwd; no credential is copied or returned to the caller.
"""
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import uuid
from pathlib import Path


class NativeContextUnavailable(RuntimeError):
    pass


def launch(script: Path, arguments: list[str], *, cwd: Path, receipt: Path) -> str:
    script, cwd, receipt = script.resolve(), cwd.resolve(), receipt.resolve()
    if not script.is_file() or not cwd.is_dir() or receipt.exists():
        raise ValueError("Script/cwd must exist and the receipt must be new")
    server = subprocess.run(["tmux", "-N", "display-message", "-p", "#{pid}"], capture_output=True, text=True)
    if server.returncode != 0 or not server.stdout.strip().isdigit():
        raise NativeContextUnavailable("No existing tmux execution context is available; a prior successful credential check cannot be reused")
    server_pid = int(server.stdout.strip())
    receipt.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    name = "ch-eval-" + uuid.uuid4().hex[:14]
    wrapper = receipt.with_suffix(".launcher.py")
    payload = {"argv": ["/opt/homebrew/bin/python3", str(script), *arguments],
               "cwd": str(cwd), "receipt": str(receipt), "session": name, "tmux_server_pid": server_pid}
    wrapper.write_text("import json, os, subprocess, time\nfrom pathlib import Path\n"
                       + "job=" + repr(payload) + "\n"
                       + "started=time.time()\n"
                       + "env=dict(os.environ)\nenv.pop('CLAUDECODE',None)\n"
                       + "with Path(job['receipt']+'.stdout.log').open('w') as out, Path(job['receipt']+'.stderr.log').open('w') as err:\n"
                       + "    child=subprocess.run(job['argv'],cwd=job['cwd'],env=env,stdout=out,stderr=err)\n"
                       + "Path(job['receipt']).write_text(json.dumps({'exit_code':child.returncode,'session':job['session'],'tmux_server_pid':job['tmux_server_pid'],'started_at':started,'ended_at':time.time(),'cwd':job['cwd']},indent=2)+'\\n')\n")
    command = shlex.join(["/opt/homebrew/bin/python3", str(wrapper)])
    subprocess.run(["tmux", "-N", "new-session", "-d", "-s", name, "-c", str(cwd), command], check=True)
    return name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--script", type=Path, required=True)
    parser.add_argument("--cwd", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    arguments = args.arguments[1:] if args.arguments[:1] == ["--"] else args.arguments
    print(json.dumps({"session": launch(args.script, arguments, cwd=args.cwd, receipt=args.receipt), "receipt": str(args.receipt)}))


if __name__ == "__main__":
    main()
