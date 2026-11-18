import importlib.util
import marshal
from pathlib import Path
import struct
import unittest

from fixture import EXPECTED, Fixture
from ownership import OwnedFixture


class FixtureBytecodeTests(unittest.TestCase):
    def test_matching_header_cache_cannot_write_outside_fixture_root(self):
        fixture = Fixture(self)
        other = Path(OwnedFixture(self).name)
        marker = other / 'UNVERIFIED-CACHE-RAN'
        source = fixture.vm / 'lib/client_rules.py'
        source_bytes = source.read_bytes()
        cache = Path(importlib.util.cache_from_source(str(source)))
        cache.parent.mkdir(mode=0o700)
        payload = (f"from pathlib import Path\nPath({str(marker)!r}).write_text('ran')\n"
                   f"exec(compile({source_bytes!r}, {str(source)!r}, 'exec'))\n")
        timestamp = int(source.stat().st_mtime) & 0xffffffff
        header = importlib.util.MAGIC_NUMBER + struct.pack('<III', 0, timestamp, len(source_bytes))
        cache.write_bytes(header + marshal.dumps(compile(payload, str(cache), 'exec')))
        result = fixture.run()
        self.assertEqual(source.read_bytes(), source_bytes)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(marker.exists(), 'unchecked fixture bytecode wrote outside its owned root')
        self.assertEqual((fixture.private / 'rules/AGENTS.md').read_bytes(), EXPECTED)
        fixture.scratch.cleanup()


if __name__ == '__main__':
    unittest.main()
