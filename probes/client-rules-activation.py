#!/usr/bin/env python3
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from client_rules import RulesRefused, SNAPSHOT_FILE, STATE_FILE, digest, read_json
from client_rules_import import acknowledge_rules, approve_rules, import_rules

ROOT = Path(__file__).resolve().parents[1]


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="rules-activation-proof-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name).resolve()
        self.host = self.root / "sandboxes/synthetic"
        self.source = self.root / "source"
        self.host.mkdir(parents=True)
        self.source.mkdir()
        self.original = self.root / "AGENTS.md"
        original = b"# Synthetic activation\nAlpha.\n"
        self.original.write_bytes(original)
        self.imported = b"# Synthetic activation\nBeta.\n"
        recipe = {"inputSha256": digest(original), "replacements": [{"before": "Alpha.\n", "after": "Beta.\n"}]}
        plan = self.source / "import.json"
        plan.write_text(json.dumps(recipe))
        (self.host / "sandbox.json").write_text(json.dumps({"sources": ["synthetic"], "rules": "/etc/agent-sandbox/synthetic.md"}))
        (self.host / "vault.json").write_text('{}')
        import_rules(self.host, lambda source: self.source, "synthetic", self.original, "AGENTS.md", plan.name, digest(plan.read_bytes()))

    def test_pending_import_blocks_another_approval_without_changing_snapshot(self):
        candidate = b"# Synthetic next version\n"
        (self.source / "AGENTS.md").write_bytes(candidate)
        with self.assertRaisesRegex(RulesRefused, "not reached"):
            approve_rules(self.host, lambda source: self.source, digest(candidate))
        self.assertEqual((self.host / SNAPSHOT_FILE).read_bytes(), self.imported)

    def test_stale_acknowledgement_does_not_unlock_a_new_pending_approval(self):
        acknowledge_rules(self.host, digest(self.imported))
        candidate = b"# Synthetic next version\n"
        (self.source / "AGENTS.md").write_bytes(candidate)
        approve_rules(self.host, lambda source: self.source, digest(candidate))
        acknowledge_rules(self.host, digest(self.imported))
        following = b"# Synthetic later version\n"
        (self.source / "AGENTS.md").write_bytes(following)
        with self.assertRaisesRegex(RulesRefused, "not reached"):
            approve_rules(self.host, lambda source: self.source, digest(following))
        self.assertEqual(self.original.read_bytes(), candidate)
        acknowledge_rules(self.host, digest(candidate))
        approve_rules(self.host, lambda source: self.source, digest(following))
        self.assertEqual(self.original.read_bytes(), following)

    def vm_config(self, exit_code):
        executables = self.root / "bin"
        executables.mkdir(exist_ok=True)
        transport = executables / "colima"
        transport.write_text(f'#!/bin/sh\nwhile IFS= read -r ignored; do :; done\nexit {exit_code}\n')
        transport.chmod(0o700)
        environment = {"HOME": str(self.root), "PATH": f"{executables}:/usr/bin:/bin", "SANDBOX": "synthetic",
                       "POTS_RUNTIME": ".", "PYTHONDONTWRITEBYTECODE": "1"}
        return subprocess.run([str(ROOT / "bin/vm-config")], cwd=self.root, env=environment,
                              capture_output=True, text=True, check=False)

    def test_shell_transfer_failure_keeps_pending_and_success_unlocks_approval(self):
        failed = self.vm_config(1)
        self.assertNotEqual(failed.returncode, 0)
        self.assertTrue(read_json(self.host / STATE_FILE)["isPending"])
        successful = self.vm_config(0)
        self.assertEqual(successful.returncode, 0, successful.stderr)
        self.assertFalse(read_json(self.host / STATE_FILE)["isPending"])
        self.assertNotIn("Beta.", failed.stdout + failed.stderr + successful.stdout + successful.stderr)


if __name__ == "__main__":
    unittest.main()
