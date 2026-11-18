#!/usr/bin/env python3
import fcntl
import json
import os
from pathlib import Path
import runpy
import shutil
import signal
import sys
import unittest

probe = runpy.run_path(str(Path(__file__).with_name('factory-receiver.py')))
ROOT = probe['fixture']['ROOT']
sys.path.insert(0, str(ROOT / 'lib'))
from receiver_state import admission

EXPORT = os.environ.get('FACTORY_RELEASE_EXPORT')
FIXTURE_REPOSITORY = 'probe/factory'
FIXTURE_ORIGIN = f'https://github.com/{FIXTURE_REPOSITORY}.git'


@unittest.skipUnless(EXPORT, 'provide a disposable #30 export')
class ProducerExport(probe['ActivationFixture']):
    def setUp(self):
        super().setUp()
        self.export = Path(EXPORT)
        self.bundle = self.export / 'candidate.bundle'
        self.receipt = json.loads((self.export / 'receipt.json').read_text())
        self.candidate = self.receipt['candidate']
        self.revision = self.candidate['commit']
        self.installed = self.candidate['request']['base']
        self.git(self.checkout, 'fetch', '-q', str(self.bundle), 'refs/heads/main')
        self.git(self.checkout, 'reset', '--hard', self.installed)
        self.git(self.checkout, 'remote', 'set-url', 'origin', FIXTURE_ORIGIN)
        self.git(self.stage, 'remote', 'set-url', 'origin', FIXTURE_ORIGIN)
        shutil.copyfile(self.export / 'operator-public.asc', self.receiver / 'trusted-signers.asc')
        shutil.copyfile(self.export / 'factory-public.asc', self.receiver / 'factory-signers.asc')
        (self.receiver / 'releases').mkdir()
        self.initialize_runtime()

    def command(self, operation, *arguments):
        script = '\n'.join([
            'import sys', f'sys.path.insert(0, {str(ROOT / "lib")!r})', 'from managed_receiver import Receiver, main, run',
            'class LocalReceiver(Receiver):',
            f'    def __init__(self, root): super().__init__(root, {FIXTURE_ORIGIN!r})',
            f'    def poll(self, descriptor): return super().poll(descriptor, {str(self.bundle)!r}, "file")',
            'sys.exit(main(lambda arguments: run(arguments, LocalReceiver)))',
        ])
        return self.run_receiver(operation, *arguments, entry=['-c', script])

    def test_poll_activates_exact_producer_candidate_and_matches_checked_round(self):
        request, review = self.candidate['request'], self.receipt['review']
        self.assertEqual((request['repository'], request['number'], request['generation'], request['head'], request['base']),
                         (review['repository'], review['number'], review['generation'], review['head'], review['mergeBase']))
        code, status = self.activate('poll')
        self.assertEqual((code, status['loaded'], status['known_good']), (0, self.revision, self.revision))
        self.assertEqual(status['verified']['review'], request)
        self.assertEqual(status['verified']['signer'], self.candidate['fingerprint'])
        self.assertEqual(status['verified']['tree'], request['tree'])
        self.assertEqual(self.activate('poll')[0], 0)
        if os.environ.get('FACTORY_RELEASE_DISPATCH') == '1':
            self.assert_dispatches_from_loaded_release(self.revision)
        self.report('activated', status)

    def test_rejected_signature_preserves_previous_release(self):
        shutil.copyfile(self.export / 'operator-public.asc', self.receiver / 'factory-signers.asc')
        code, status = self.activate('poll')
        self.assertEqual((code, status['blocked'], status['loaded']), (1, 'factory-signature-unverified', self.installed))
        self.assertEqual(status['desired'], self.revision)
        self.assertIsNone(status['verified'])
        self.assertFalse((self.receiver / 'releases' / self.revision).exists())
        self.report('rejected signature', status)

    def test_interruption_refuses_both_launches_until_restored_and_retried(self):
        interrupt = self.receiver / f'interrupt-{self.revision}'
        interrupt.touch()
        self.assertEqual(self.command('poll').returncode, -signal.SIGKILL)
        state = self.activate('status')[1]
        self.assertEqual((state['phase'], state['loaded']), ('switching', None))
        for operation in ('fresh', 'resumed'):
            self.assertEqual(self.activate('dispatch', operation), (1, {'blocked': 'admission-closed'}))
        code, status = self.activate('poll')
        self.assertEqual((code, status['blocked'], status['loaded']), (1, 'activation-interrupted', self.installed))
        self.report('restored after interruption', status)
        interrupt.unlink()
        code, status = self.activate('poll')
        self.assertEqual((code, status['loaded']), (0, self.revision))
        self.report('retried', status)

    def test_failed_candidate_health_restores_previous_checkout(self):
        (self.receiver / f'unhealthy-{self.revision}').touch()
        before = probe['fixture']['snapshot'](self.checkout)
        code, status = self.activate('poll')
        self.assertEqual((code, status['blocked'], status['known_good']), (1, 'runtime-health-failed', self.installed))
        self.assertEqual(self.activate('status')[1]['loaded'], self.installed)
        self.assertEqual(probe['fixture']['snapshot'](self.checkout), before)
        self.report('rolled back', status)

    def test_failed_rollback_keeps_admission_closed_until_previous_release_is_healthy(self):
        interrupt = self.receiver / f'interrupt-{self.revision}'
        unhealthy_base = self.receiver / f'unhealthy-{self.installed}'
        interrupt.touch()
        self.assertEqual(self.command('poll').returncode, -signal.SIGKILL)
        unhealthy_base.touch()
        code, status = self.activate('poll')
        self.assertEqual((code, status['phase'], status['loaded'], status['blocked']),
                         (1, 'restoring', None, 'activation-interrupted'))
        self.assertEqual(status['recovery_failure'], 'runtime-health-failed')
        self.assertEqual(self.activate('status')[1]['recovery_failure'], 'runtime-health-failed')
        for operation in ('fresh', 'resumed'):
            self.assertEqual(self.activate('dispatch', operation), (1, {'blocked': 'admission-closed'}))
        unhealthy_base.unlink()
        self.assertEqual(self.activate('poll')[1]['loaded'], self.installed)

    def test_failed_fetch_does_not_use_a_cached_candidate(self):
        busy = self.receiver / 'busy'
        busy.touch()
        self.assertEqual(self.activate('poll')[1]['blocked'], 'runtime-busy')
        busy.unlink()
        self.bundle = self.receiver / 'absent.bundle'
        code, status = self.activate('poll')
        self.assertEqual((code, status['blocked'], status['loaded']), (1, 'candidate-fetch-failed', self.installed))
        self.assertIsNone(status['desired'])

    def test_poll_leaves_the_candidate_unstaged_while_a_launch_holds_admission(self):
        with admission(self.receiver, fcntl.LOCK_SH):
            self.assertEqual(self.activate('poll'), (1, {'blocked': 'admission-busy'}))
        self.assertFalse((self.receiver / 'releases' / self.revision).exists())

    def report(self, outcome, status):
        print(json.dumps({'outcome': outcome, 'candidate': self.revision, 'base': self.installed,
                          'loaded': status['loaded'], 'reviewId': self.receipt['reviewId'], 'blocked': status['blocked']}))


if __name__ == '__main__':
    unittest.main(verbosity=2)
