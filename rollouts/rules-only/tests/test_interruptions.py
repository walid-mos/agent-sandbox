from itertools import product
import json
from pathlib import Path
import subprocess
import sys
import unittest

from fixture import AREA, EXPECTED, ORIGINAL, Fixture, digest, git, write_json

STEPS = ('capture-backups', 'canonical-file', 'snapshot', 'pending-state', 'original-link',
         'link-staging', 'private-branch', 'private-index', 'local-commit', 'vm-transfer',
         'vm-confirmation', 'ack-staging', 'acknowledgement', 'loaded-hashes')


class InterruptionTests(unittest.TestCase):
    def test_failures_before_and_after_every_stage_retain_evidence_and_refuse_rerun(self):
        for step, point in product(STEPS, ('before', 'after')):
            with self.subTest(step=step, point=point):
                self.check_stage_failure(step, point)

    def check_stage_failure(self, step, point):
        fixture = Fixture(self)
        fixture.options['fault'] = f'{step}:{point}'
        result = fixture.run()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(fixture.records()[-1], {'step': step, 'status': 'failed-unknown', 'proof': {}})
        self.assertIn(b'RECONCILE', result.stderr)
        self.assertNotIn(ORIGINAL, result.stdout + result.stderr)
        self.assertNotIn(EXPECTED, result.stdout + result.stderr)
        retained = (fixture.journal / 'events.jsonl').read_bytes()
        self.assertNotEqual(fixture.run().returncode, 0)
        self.assertEqual((fixture.journal / 'events.jsonl').read_bytes(), retained)
        if step == 'vm-transfer' and point == 'after':
            state = json.loads((fixture.directory / 'client-rules.json').read_bytes())
            self.assertIs(state['isPending'], True)
            self.assertEqual(fixture.loaded.read_bytes(), EXPECTED)
        fixture.scratch.cleanup()

    def test_process_death_leaves_intent_and_inspect_is_read_only(self):
        for step in ('canonical-file', 'original-link', 'local-commit', 'vm-transfer', 'acknowledgement'):
            with self.subTest(step=step):
                fixture = Fixture(self)
                fixture.options['fault'] = f'{step}:crash-after'
                result = fixture.run()
                self.assertEqual(result.returncode, 86)
                self.assertEqual(fixture.records()[-1], {'step': step, 'status': 'intent', 'proof': {}})
                retained = (fixture.journal / 'events.jsonl').read_bytes()
                command = [sys.executable, '-I', str(AREA / 'run.py'), 'inspect', '--contract',
                           str(fixture.contract_path), '--contract-sha256', digest(fixture.contract_path.read_bytes())]
                inspected = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                self.assertEqual(inspected.returncode, 0, inspected.stdout + inspected.stderr)
                self.assertEqual(json.loads(inspected.stdout)['journal'][-1]['status'], 'intent')
                self.assertEqual((fixture.journal / 'events.jsonl').read_bytes(), retained)
                self.assertNotEqual(fixture.run().returncode, 0)
                fixture.scratch.cleanup()

    def test_git_hook_and_filter_configuration_cannot_run(self):
        fixture = Fixture(self)
        marker = fixture.root / 'ATTACK-RAN'
        git(fixture.private, 'config', 'filter.attack.clean', f'touch {marker}')
        result = fixture.run()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists())
        self.assertFalse(fixture.original.is_symlink())

    def test_torn_journal_is_not_treated_as_resumable(self):
        fixture = Fixture(self)
        fixture.options['fault'] = 'canonical-file:crash-before'
        self.assertEqual(fixture.run().returncode, 86)
        with (fixture.journal / 'events.jsonl').open('ab') as output:
            output.write(b'{"step":')
        self.assertNotEqual(fixture.run().returncode, 0)


if __name__ == '__main__':
    unittest.main()
