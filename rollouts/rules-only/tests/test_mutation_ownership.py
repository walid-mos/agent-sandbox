import json
import os
import signal
import subprocess
import unittest

from fixture import EXPECTED
from inflight import InFlight


class MutationOwnershipTests(unittest.TestCase):
    def test_sigterm_waits_for_mutation_and_journals_outcome_before_stopping(self):
        run = InFlight(self)
        run.process.send_signal(signal.SIGTERM)
        with self.assertRaises(subprocess.TimeoutExpired):
            run.process.wait(timeout=0.3)
        proof = run.inspect()
        self.assertEqual(proof['observed'], {})
        self.assertIn('LIVE', proof['action'])
        self.assertIn('LIVE', {operation['status'] for operation in proof['mutations']})
        run.finish()
        self.assertNotEqual(run.process.returncode, 0)
        self.assertEqual(run.fixture.loaded.read_bytes(), EXPECTED)
        self.assertTrue(json.loads((run.fixture.directory / 'client-rules.json').read_bytes())['isPending'])
        self.assertEqual(run.fixture.records()[-1]['step'], 'vm-transfer')
        self.assertEqual(run.fixture.records()[-1]['status'], 'confirmed')
        self.assertTrue(all(operation['status'] == 'LOCAL-GROUP-ENDED' for operation in run.inspect()['mutations']))

    def test_sigkill_reports_live_continuation_and_retains_unconfirmed_intent(self):
        run = InFlight(self)
        run.process.kill()
        self.assertEqual(run.process.wait(timeout=5), -signal.SIGKILL)
        retained = (run.fixture.journal / 'events.jsonl').read_bytes()
        proof = run.inspect()
        self.assertEqual(proof['observed'], {})
        self.assertIn('LIVE', proof['action'])
        self.assertIn('LIVE', {operation['status'] for operation in proof['mutations']})
        run.finish()
        self.assertEqual(run.fixture.loaded.read_bytes(), EXPECTED)
        self.assertEqual((run.fixture.journal / 'events.jsonl').read_bytes(), retained)
        self.assertEqual(run.fixture.records()[-1]['status'], 'intent')
        self.assertNotEqual(run.fixture.run().returncode, 0)
        self.assertIn('owner', run.inspect()['action'].lower())

    def test_supervisor_loss_never_infers_quiescence_from_released_lease(self):
        run = InFlight(self)
        operations = [json.loads(path.read_bytes()) for path in run.fixture.journal.glob('mutations/*/supervisor.json')]
        self.assertTrue(operations, 'mutation supervisor identity was not durable')
        operation = next(operation for operation in operations if operation['stage'] == 'vm-transfer')
        os.kill(operation['identity']['pid'], signal.SIGKILL)
        run.process.kill()
        run.process.wait(timeout=5)
        self.assertIn('LIVE', run.inspect()['action'])
        run.finish()
        proof = run.inspect()
        self.assertEqual(proof['observed'], {})
        self.assertIn('UNKNOWN', proof['action'])
        self.assertIn('UNKNOWN', {operation['status'] for operation in proof['mutations']})
        self.assertEqual(run.fixture.loaded.read_bytes(), EXPECTED)


if __name__ == '__main__':
    unittest.main()
