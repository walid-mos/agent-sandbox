import json
import subprocess
import sys
import unittest

from fixture import Fixture


class OwnershipTests(unittest.TestCase):
    def test_fixture_receipt_survives_outside_scratch_and_guards_cleanup_identity(self):
        fixture = Fixture(self)
        receipt = fixture.root.parent / f'{fixture.root.name}.ownership.json'
        self.assertTrue(receipt.exists())
        marker = fixture.root / 'fixture-owner.json'
        before = marker.read_bytes()
        try:
            marker.write_text(json.dumps({'runId': 'replacement'}))
            fixture.scratch.cleanup()
            self.assertTrue(fixture.root.exists())
        finally:
            marker.write_bytes(before)
        fixture.scratch.cleanup()
        self.assertFalse(fixture.root.exists())
        self.assertFalse(receipt.exists())

    def test_next_setup_reconciles_only_a_verified_ended_fixture(self):
        fixture = Fixture(self)
        receipt = fixture.root.parent / f'{fixture.root.name}.ownership.json'
        marker = fixture.root / 'fixture-owner.json'
        child = subprocess.Popen([sys.executable, '-I', '-c', 'pass'])
        child.wait(timeout=5)
        ended = {**json.loads(receipt.read_bytes()), 'pid': child.pid, 'pidStart': 'ended-test-process'}
        receipt.write_text(json.dumps(ended))
        marker.write_text(json.dumps(ended))
        following = Fixture(self)
        self.assertFalse(fixture.root.exists())
        self.assertFalse(receipt.exists())
        self.assertTrue(following.root.exists())
        following.scratch.cleanup()


if __name__ == '__main__':
    unittest.main()
