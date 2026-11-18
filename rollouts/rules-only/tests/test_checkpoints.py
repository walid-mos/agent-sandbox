import fcntl
import json
import os
import shutil
import subprocess
import sys
import time
import unittest

from fixture import AREA, ORIGINAL, Fixture, digest


class CheckpointTests(unittest.TestCase):
    def test_drift_or_owner_revocation_after_backups_stops_before_import(self):
        for target in ('vm-bundle', 'original', 'owner'):
            with self.subTest(target=target):
                fixture = Fixture(self)
                fixture.options.update(driftTarget=target, driftObservation=4)
                result = fixture.run()
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue((fixture.journal / 'private-backups.json').exists())
                self.assertFalse((fixture.private / 'rules/AGENTS.md').exists())
                self.assertEqual(fixture.records()[-1]['step'], 'capture-backups')
                fixture.scratch.cleanup()

    def test_aggregate_deadline_covers_collector_work_before_any_intent(self):
        fixture = Fixture(self)
        fixture.options['pauseRead'] = 2
        started = time.monotonic()
        result = fixture.run(preflightSeconds=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertLess(time.monotonic() - started, 4)
        self.assertFalse(fixture.journal.exists())
        self.assertEqual(fixture.original.read_bytes(), ORIGINAL)
        self.assertIn(b'deadline', result.stderr)

    def test_initialization_intent_without_directory_is_reconcilable_but_not_rerunnable(self):
        fixture = Fixture(self)
        fixture.options['fault'] = 'capture-backups:crash-before'
        self.assertEqual(fixture.run().returncode, 86)
        shutil.rmtree(fixture.journal)
        command = [sys.executable, '-I', str(AREA / 'run.py'), 'inspect', '--contract',
                   str(fixture.contract_path), '--contract-sha256', digest(fixture.contract_path.read_bytes())]
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['journal'], [{'step': 'initialization', 'status': 'intent'}])
        self.assertNotEqual(fixture.run().returncode, 0)

    def test_existing_import_lock_refuses_before_journal_or_writes(self):
        fixture = Fixture(self)
        descriptor = os.open(fixture.directory, os.O_RDONLY)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = fixture.run()
        finally:
            os.close(descriptor)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(fixture.journal.exists())
        self.assertEqual(fixture.original.read_bytes(), ORIGINAL)

    def test_expired_contract_can_inspect_vm_without_mutation(self):
        fixture = Fixture(self)
        fixture.options['fault'] = 'vm-transfer:crash-after'
        self.assertEqual(fixture.run().returncode, 86)
        retained = (fixture.journal / 'events.jsonl').read_bytes()
        command = [sys.executable, '-I', str(AREA / 'run.py'), 'inspect', '--contract',
                   str(fixture.contract_path), '--contract-sha256', digest(fixture.contract_path.read_bytes()),
                   '--vm', '--fixture-root', str(fixture.root)]
        clock = fixture.contract['expires'] + 1
        wrapper = (f'import runpy,sys,time; time.time=lambda: {clock}; '
                   'sys.argv=sys.argv[1:]; runpy.run_path(sys.argv[0],run_name="__main__")')
        command = [sys.executable, '-I', '-c', wrapper, *command[2:]]
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, 0, result.stderr)
        proof = json.loads(result.stdout)
        self.assertTrue(proof['observed']['isPending'])
        self.assertEqual(proof['observed']['vm']['rules']['sha256'], fixture.options['outputSha256'])
        self.assertEqual((fixture.journal / 'events.jsonl').read_bytes(), retained)


if __name__ == '__main__':
    unittest.main()
