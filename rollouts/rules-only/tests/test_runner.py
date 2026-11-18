import json
from pathlib import Path
import subprocess
import sys
import time
import unittest

from fixture import AREA, EXPECTED, ORIGINAL, Fixture, git, write_json


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture(self)

    def assert_refused_without_import(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.fixture.original.read_bytes(), ORIGINAL)
        self.assertFalse((self.fixture.private / 'rules/AGENTS.md').exists())

    def test_exact_recipe_reaches_local_commit_vm_ack_and_loaded_hashes(self):
        result = self.fixture.run()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.fixture.private / 'rules/AGENTS.md').read_bytes(), EXPECTED)
        self.assertTrue(self.fixture.original.is_symlink())
        self.assertEqual(self.fixture.loaded.read_bytes(), EXPECTED)
        state = json.loads((self.fixture.directory / 'client-rules.json').read_bytes())
        self.assertIs(state['isPending'], False)
        self.assertEqual(git(self.fixture.private, 'branch', '--show-current'), 'chore/canonical-client-rules')
        self.assertEqual(git(self.fixture.private, 'diff', '--name-only', 'HEAD^', 'HEAD'), 'rules/AGENTS.md')
        self.assertEqual(git(self.fixture.private, 'for-each-ref', '--format=%(refname)', 'refs/remotes'), '')
        self.assertIn(b'PRIVATE COMMIT LOCAL ONLY', result.stdout)
        self.assertNotIn(ORIGINAL, result.stdout + result.stderr)
        self.assertNotIn(EXPECTED, result.stdout + result.stderr)
        self.assertEqual(self.fixture.records()[-1]['step'], 'loaded-hashes')
        self.assertEqual(self.fixture.records()[-1]['status'], 'confirmed')

    def test_absent_or_expired_window_refuses_before_import(self):
        self.assert_refused_without_import(self.fixture.run(expires=int(time.time()) - 1))

    def test_missing_owner_hold_refuses_before_import(self):
        self.fixture.proof.unlink()
        self.assert_refused_without_import(self.fixture.run())

    def test_incompatible_mac_or_vm_implementation_refuses(self):
        for directory in (self.fixture.checkout, self.fixture.vm):
            with self.subTest(directory=directory.name):
                path = directory / 'lib/client_rules.py'
                before = path.read_bytes()
                path.write_bytes(before + b'\n')
                self.assert_refused_without_import(self.fixture.run())
                path.write_bytes(before)

    def test_unrelated_vm_bytes_and_optional_membership_are_preserved(self):
        before = {path.name: path.read_bytes() for path in self.fixture.installed.glob('*.json')}
        self.assertEqual(self.fixture.run().returncode, 0)
        self.assertEqual({path.name: path.read_bytes() for path in self.fixture.installed.glob('*.json')}, before)
        self.assertFalse((self.fixture.installed / 'tailnet.json').exists())

    def test_unrelated_vm_byte_or_optional_membership_drift_refuses(self):
        path = self.fixture.installed / 'vault.json'
        before = path.read_bytes()
        path.write_bytes(before + b' ')
        self.assert_refused_without_import(self.fixture.run())
        path.write_bytes(before)
        write_json(self.fixture.installed / 'tailnet.json', {'operatorLogin': 'invented'})
        self.assert_refused_without_import(self.fixture.run())

    def test_recipe_and_original_hash_drift_refuse(self):
        self.fixture.options['inputSha256'] = '0' * 64
        self.assert_refused_without_import(self.fixture.run())

    def test_production_has_no_fixture_override(self):
        result = subprocess.run([sys.executable, '-I', str(AREA / 'run.py'), 'execute'],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.fixture.journal.exists())

    def test_nonisolated_python_refuses_before_loading_resources(self):
        result = subprocess.run([sys.executable, str(AREA / 'run.py'), 'manifest'],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(b'artifactSha256', result.stdout)

    def test_existing_journal_never_reapplies(self):
        self.assertEqual(self.fixture.run().returncode, 0)
        head = git(self.fixture.private, 'rev-parse', 'HEAD')
        result = self.fixture.run()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(git(self.fixture.private, 'rev-parse', 'HEAD'), head)
        self.assertIn(b'RECONCILE', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
