from pathlib import Path
import shutil
import subprocess
import sys
import unittest

from fixture import AREA
from ownership import OwnedFixture


class HelperSourceTests(unittest.TestCase):
    def test_fixture_store_refuses_changed_source_before_execution(self):
        self.assert_changed_helper_refused('_fixture-store', 'fixture_store.py')

    def test_mutation_worker_refuses_changed_source_before_execution(self):
        self.assert_changed_helper_refused('_mutation-worker', 'mutation_worker.py')

    def assert_changed_helper_refused(self, command, script):
        root = Path(OwnedFixture(self).name)
        area_copy = root / 'runner'
        shutil.copytree(AREA, area_copy)
        marker = Path(OwnedFixture(self).name) / 'UNVERIFIED-HELPER-RAN'
        resources = area_copy / 'resources.json'
        pinned_resources = resources.read_bytes()
        source = area_copy / script
        payload = f"from pathlib import Path\nPath({str(marker)!r}).write_text('ran')\n"
        source.write_bytes(payload.encode() + source.read_bytes())
        result = subprocess.run([sys.executable, '-I', str(area_copy / 'run.py'),
                                 command, str(root / 'absent')], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(resources.read_bytes(), pinned_resources)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(marker.exists(), 'unchecked helper source executed before refusal')
        self.assertIn(b'pinned runner source differs', result.stderr)


if __name__ == '__main__':
    unittest.main()
