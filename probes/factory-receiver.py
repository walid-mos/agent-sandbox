#!/usr/bin/env python3
import json
import os
from pathlib import Path
import runpy
import shutil
import signal
import subprocess
import sys
import tarfile
import unittest

fixture = runpy.run_path(str(Path(__file__).with_name('managed-update.py')))
ManagedFixture = fixture['ManagedFixture']
ORIGIN = fixture['ORIGIN']
DISPATCH_REVISION = os.environ.get('FACTORY_RELEASE_REVISION')
DISPATCH_BASE = os.environ.get('FACTORY_RELEASE_DISPATCH_BASE')
REPOSITORY = ORIGIN.removeprefix('https://github.com/').removesuffix('.git')


class PublicationFixture(ManagedFixture):
    def landing_receipt(self, changes=None):
        tree = self.git(self.stage, 'rev-parse', f'{self.desired}^{{tree}}')
        request = {'repository': REPOSITORY, 'number': 7, 'generation': 1, 'ref': 'refs/heads/main',
                   'head': self.desired, 'base': self.installed, 'tree': tree, **(changes or {})}
        message = 'Factory landing v1\n\n' + json.dumps(request, sort_keys=True, separators=(',', ':'))
        candidate = self.git(self.stage, 'commit-tree', f'-S{self.other_fingerprint}', tree, '-p', self.installed, '-m', message)
        self.stage_ref(candidate)
        return {'commit': candidate, 'request': request}

    def trust_factory(self):
        public = fixture['invoke'](['gpg', '--armor', '--export', self.other_fingerprint], self.environment)
        (self.receiver / 'factory-signers.asc').write_text(public + '\n')


class FactoryReceiver(PublicationFixture):
    def test_signed_landing_binds_exact_review_tuple(self):
        receipt = self.landing_receipt()
        self.trust_factory()
        code, status = self.run_preflight(revision=receipt['commit'], options=('--factory',))
        self.assertEqual(code, 0, status)
        self.assertEqual(status['verified']['review'], receipt['request'])
        self.assertEqual(status['verified']['tree'], self.git(self.stage, 'rev-parse', 'HEAD^{tree}'))

    def test_reviewed_tree_must_equal_landed_tree(self):
        receipt = self.landing_receipt({'head': self.installed})
        self.trust_factory()
        self.assert_blocked('factory-tree-mismatch', revision=receipt['commit'], options=('--factory',))

    def test_factory_signature_cannot_authorize_another_ref(self):
        receipt = self.landing_receipt({'ref': 'refs/heads/elsewhere'})
        self.trust_factory()
        self.assert_blocked('factory-target-mismatch', revision=receipt['commit'], options=('--factory',))

    def test_operator_key_is_not_factory_authority(self):
        receipt = self.landing_receipt()
        (self.receiver / 'factory-signers.asc').write_text(self.public_key + '\n')
        self.assert_blocked('factory-signature-unverified', revision=receipt['commit'], options=('--factory',))


class ActivationFixture(PublicationFixture):
    def command(self, operation, *arguments):
        return self.run_receiver(operation, *arguments, entry=[str(fixture['ROOT'] / 'lib/managed_receiver.py')])

    def run_receiver(self, operation, *arguments, entry):
        return subprocess.run([sys.executable, '-IB', *entry, str(self.receiver), operation, *arguments],
                              env=self.environment, text=True, capture_output=True)

    def activate(self, operation, *arguments):
        result = self.command(operation, *arguments)
        self.assertTrue(result.stdout, result.stderr)
        return result.returncode, json.loads(result.stdout)

    def arrange_activation(self):
        payload = self.landing_receipt()
        self.trust_factory()
        revision = payload['commit']
        releases = self.receiver / 'releases'
        releases.mkdir()
        self.git(self.root, 'clone', '-q', '--no-local', '-b', 'main', str(self.stage), str(releases / revision))
        checkout = releases / revision
        self.git(checkout, 'fetch', '-q', str(self.stage), 'refs/remotes/origin/main')
        self.git(checkout, 'reset', '--hard', revision)
        self.git(checkout, 'remote', 'set-url', 'origin', ORIGIN)
        self.initialize_runtime()
        return revision

    def initialize_runtime(self):
        fake_bin = self.root / 'bin'
        fake_bin.mkdir()
        pi = fake_bin / 'pi'
        pi.write_text('#!/bin/sh\n[ "$1" = --help ]\n')
        pi.chmod(0o700)
        runtime = self.receiver / 'runtime'
        runtime.write_text(f'''#!/usr/bin/python3
import json
from pathlib import Path
import sys
root = Path({str(self.receiver)!r})
verb, path, revision, *arguments = sys.argv[1:]
loaded = root / 'loaded'
if verb == 'restart':
    loaded.write_text(revision)
    if (root / ('interrupt-' + revision)).exists():
        import os, signal
        os.kill(os.getppid(), signal.SIGKILL)
if verb == 'idle' and (root / 'busy').exists():
    sys.exit(1)
if verb == 'health':
    if (root / ('unhealthy-' + revision)).exists():
        sys.exit(1)
    print(json.dumps({{'protocol': 1, 'loaded': loaded.read_text()}}))
if verb == 'dispatch':
    import os, subprocess
    checkout = Path(path)
    if arguments == ['fresh']:
        command = [str(checkout / 'probes/dispatch-branches.mjs')]
    elif arguments == ['resumed']:
        command = ['--experimental-test-module-mocks', '--test', str(checkout / 'session/worker-delivery.test.mjs')]
    elif arguments in (['push-policy', 'before'], ['push-policy', 'after']):
        command = [{str(Path(__file__).with_name('factory-push-policy.mjs'))!r},
                   str(checkout), str(root.parent / 'worker-fixture'), arguments[-1]]
    else:
        sys.exit(1)
    node = {shutil.which('node')!r}
    environment = {{**os.environ, 'PATH': {str(fake_bin)!r} + ':' + str(Path(node).parent) + ':' + os.defpath}}
    result = subprocess.run([node, *command], env=environment, capture_output=True)
    (root / 'dispatch-result').write_bytes(result.stdout + result.stderr)
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    sys.exit(result.returncode)
''')
        runtime.chmod(0o700)
        (self.receiver / 'loaded').write_text(self.installed)
        code, status = self.activate('initialize')
        self.assertEqual(code, 0, status)

    def assert_dispatches_from_loaded_release(self, revision):
        self.assertEqual(self.activate('status')[1]['loaded'], revision)
        fresh = self.command('dispatch', 'fresh')
        self.assertEqual(fresh.returncode, 0, fresh.stderr + fresh.stdout)
        self.assertIn('default and client workers', fresh.stdout)
        resumed = self.command('dispatch', 'resumed')
        self.assertEqual(resumed.returncode, 0, (self.receiver / 'dispatch-result').read_text())
        self.assertIn('resumed launch', resumed.stdout)


class Activation(ActivationFixture):
    def test_busy_receiver_stays_healthy_then_activates_on_retry(self):
        revision = self.arrange_activation()
        busy = self.receiver / 'busy'
        busy.touch()
        code, status = self.activate('advance', revision)
        self.assertEqual((code, status['blocked'], status['loaded']), (1, 'runtime-busy', self.installed))
        busy.unlink()
        code, status = self.activate('advance', revision)
        self.assertEqual((code, status['filesystem'], status['loaded'], status['known_good']), (0, revision, revision, revision))

    def test_status_stops_reporting_a_loaded_revision_when_health_disagrees(self):
        self.arrange_activation()
        (self.receiver / 'loaded').write_text(self.desired)
        code, status = self.activate('status')
        self.assertEqual((code, status['loaded'], status['blocked']), (1, None, 'loaded-revision-unverified'))

    def test_unhealthy_candidate_rolls_back_without_changing_the_previous_checkout(self):
        revision = self.arrange_activation()
        (self.receiver / ('unhealthy-' + revision)).touch()
        before = fixture['snapshot'](self.checkout)
        code, status = self.activate('advance', revision)
        self.assertEqual((code, status['blocked'], status['phase']), (1, 'runtime-health-failed', 'ready'))
        self.assertEqual((status['filesystem'], status['loaded'], status['known_good']), (self.installed,) * 3)
        self.assertEqual(status['accepted'], revision)
        self.assertEqual(fixture['snapshot'](self.checkout), before)

    def test_interruption_closes_admission_until_previous_release_recovers(self):
        revision = self.arrange_activation()
        interrupt = self.receiver / ('interrupt-' + revision)
        interrupt.touch()
        self.assertEqual(self.command('advance', revision).returncode, -signal.SIGKILL)
        self.assertEqual(self.activate('status')[1]['phase'], 'switching')
        self.assertEqual(self.activate('dispatch', 'fresh'), (1, {'blocked': 'admission-closed'}))
        code, status = self.activate('advance', revision)
        self.assertEqual((code, status['phase'], status['blocked']), (1, 'ready', 'activation-interrupted'))
        self.assertEqual((status['filesystem'], status['loaded'], status['accepted']),
                         (self.installed, self.installed, revision))
        interrupt.unlink()
        code, status = self.activate('advance', revision)
        self.assertEqual((code, status['loaded']), (0, revision))

    def commit_dispatch_tree(self, revision):
        archive = self.root / 'release.tar'
        with archive.open('wb') as output:
            subprocess.run(['git', '-C', str(fixture['ROOT']), 'archive', revision],
                           env=self.environment, stdout=output, check=True)
        self.git(self.source, 'rm', '-qr', '--', '.')
        with tarfile.open(archive) as source:
            source.extractall(self.source, filter='data')
        self.git(self.source, 'add', '--force', '--all')
        self.git(self.source, 'commit', '-qS', '-m', 'Dispatcher fixture tree')
        expected_tree = self.git(fixture['ROOT'], 'rev-parse', f'{revision}^{{tree}}')
        self.assertEqual(self.git(self.source, 'rev-parse', 'HEAD^{tree}'), expected_tree)
        return self.git(self.source, 'rev-parse', 'HEAD')

    def install_dispatch_base(self):
        self.installed = self.commit_dispatch_tree(DISPATCH_BASE)
        self.git(self.checkout, 'fetch', '-q', str(self.source), 'refs/heads/main')
        self.git(self.checkout, 'reset', '-q', '--hard', self.installed)

    def assert_policy_launch(self, phase):
        result = self.command('dispatch', 'push-policy', phase)
        self.assertEqual(result.returncode, 0, (self.receiver / 'dispatch-result').read_text())
        print(json.dumps(json.loads(result.stdout)), flush=True)

    @unittest.skipUnless(DISPATCH_REVISION, 'provide the reviewed dispatcher source commit')
    def test_installed_dispatcher_supports_fresh_and_resumed_work(self):
        if DISPATCH_BASE:
            self.install_dispatch_base()
        self.desired = self.commit_dispatch_tree(DISPATCH_REVISION)
        self.git(self.stage, 'fetch', '-q', str(self.source), 'refs/heads/main:refs/heads/main')
        revision = self.arrange_activation()
        if DISPATCH_BASE:
            self.assert_policy_launch('before')
        code, status = self.activate('advance', revision)
        self.assertEqual((code, status['loaded'], status['known_good']), (0, revision, revision))
        self.assert_dispatches_from_loaded_release(revision)
        if DISPATCH_BASE:
            self.assert_policy_launch('after')


if __name__ == '__main__':
    unittest.main()
