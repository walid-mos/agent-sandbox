import importlib.util
import marshal
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import unittest

from fixture import AREA
from ownership import OwnedFixture


class RunnerBytecodeTests(unittest.TestCase):
    def test_manifest_ignores_matching_header_guards_cache(self):
        runner_copy = Path(OwnedFixture(self).name) / 'copy'
        area_copy = runner_copy / 'rollouts/rules-only'
        area_copy.mkdir(parents=True)
        shutil.copytree(AREA, area_copy, dirs_exist_ok=True)
        second_root = Path(OwnedFixture(self).name)
        marker = second_root / 'UNVERIFIED-RUNNER-CACHE-RAN'
        entrypoint = area_copy / 'run.py'
        command = [sys.executable, '-I', str(entrypoint), 'manifest']
        baseline = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        source = area_copy / 'guards.py'
        source_bytes = source.read_bytes()
        cache = Path(importlib.util.cache_from_source(str(source)))
        cache.parent.mkdir(mode=0o700)
        payload = (f"from pathlib import Path\nPath({str(marker)!r}).write_text('ran')\n"
                   f"exec(compile({source_bytes!r}, {str(source)!r}, 'exec'))\n")
        timestamp = int(source.stat().st_mtime) & 0xffffffff
        header = importlib.util.MAGIC_NUMBER + struct.pack('<III', 0, timestamp, len(source_bytes))
        cache.write_bytes(header + marshal.dumps(compile(payload, str(cache), 'exec')))
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(source.read_bytes(), source_bytes)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, baseline.stdout)
        self.assertFalse(marker.exists(), 'unchecked runner bytecode wrote outside its owned root')


if __name__ == '__main__':
    unittest.main()
