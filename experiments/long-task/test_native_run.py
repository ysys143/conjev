import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from native_run import NativeContextUnavailable, launch


class NativeRunTests(unittest.TestCase):
    def test_missing_native_server_cannot_silently_start_a_different_context(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            script = root / "job.py"
            script.write_text("pass\n")
            receipt = root / "new-evidence/native.json"
            with patch("native_run.subprocess.run", return_value=subprocess.CompletedProcess([], 1, "", "no server")) as run:
                with self.assertRaises(NativeContextUnavailable):
                    launch(script, [], cwd=root, receipt=receipt)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0][:3], ["tmux", "-N", "display-message"])
            self.assertFalse(receipt.parent.exists())


if __name__ == "__main__":
    unittest.main()
