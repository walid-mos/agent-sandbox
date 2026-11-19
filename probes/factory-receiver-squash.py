#!/usr/bin/env python3
import json
import os
from pathlib import Path
import runpy
import shutil
import signal
import subprocess
import unittest

probe = runpy.run_path(str(Path(__file__).with_name('factory-installed-receiver.py')))
EXPORT = os.environ.get('FACTORY_RELEASE_SQUASH')
RECOVERY_EXPORT = os.environ.get('FACTORY_RELEASE_SQUASH_RECOVERY')
ENTRY_EXPORT = os.environ.get('FACTORY_RELEASE_ENTRY')
SOURCE_REF = 'refs/heads/main'
EVIDENCE_ROOT = 'refs/tags/factory-release/'
REVIEW_ROOT = 'refs/tags/factory-reviewed/'
ANCHOR = 'f086ad2c18ad33337f384905f3e60eae0973125c'
TIP = '656dffe5a77cfa0df02a7c23c56cb98695c36331'


class SquashFixture(probe['InstalledFixture']):
    def prepare_export(self):
        self.export = Path(self.archive)
        self.bundle = self.root / 'publisher.git'
        self.git(self.root, 'init', '-q', '--bare', str(self.bundle))
        self.git(self.bundle, 'fetch', '-q', '--no-tags', str(self.export / 'squashes.bundle'),
                 f'{SOURCE_REF}:{SOURCE_REF}', f'{EVIDENCE_ROOT}*:{EVIDENCE_ROOT}*', f'{REVIEW_ROOT}*:{REVIEW_ROOT}*')
        self.proof = json.loads((self.export / 'squashes.json').read_text())
        self.installed = self.git(self.bundle, 'rev-parse', f'{self.anchor}^{{commit}}')
        self.revision = self.git(self.bundle, 'rev-parse', SOURCE_REF)
        self.checkpoints = [row['squash'] for row in self.proof['checkpoints']]
        self.assertEqual((self.proof['anchor'], self.proof['tip'], self.revision), (self.installed, self.tip, self.tip))

    def setUp(self):
        super().setUp()
        self.assertEqual(self.installed_command('initialize-receiver').returncode, 0)

    def poll(self):
        return self.outcome(self.unit('update'))

    def tag_object(self, squash):
        return self.git(self.bundle, 'rev-parse', EVIDENCE_ROOT + squash)


@unittest.skipUnless(EXPORT, 'provide the disposable #30 native squash export')
class ReceiverSquash(SquashFixture):
    archive, anchor, tip = EXPORT, ANCHOR, TIP

    def append_uncertified(self, parent):
        tree = self.git(self.bundle, 'rev-parse', f'{parent}^{{tree}}')
        raced = self.git(self.bundle, 'commit-tree', tree, '-p', parent, '-m', 'native squash after a base race')
        self.git(self.bundle, 'update-ref', SOURCE_REF, raced)
        return raced

    def publish_fixture_evidence(self, squash, request):
        signers = self.receiver / 'factory-signers.asc'
        public = subprocess.run(['gpg', '--armor', '--export', self.other_fingerprint], env=self.environment,
                                check=True, capture_output=True, text=True).stdout
        signers.write_text(signers.read_text() + public + '\n')
        body = json.dumps({**request, 'squash': squash}, sort_keys=True, separators=(',', ':'))
        self.git(self.bundle, '-c', 'gpg.format=openpgp', 'tag', '-u', self.other_fingerprint, '-m',
                 'Factory squash evidence v1\n\n' + body, 'factory-release/' + squash, squash)
        self.git(self.bundle, 'update-ref', REVIEW_ROOT + squash, self.git(self.bundle, 'rev-parse', REVIEW_ROOT + self.checkpoints[2]))

    def test_signed_evidence_for_a_commit_with_an_extra_parent_is_refused(self):
        _first, middle, last = self.checkpoints
        tree = self.git(self.bundle, 'rev-parse', f'{last}^{{tree}}')
        merge = self.git(self.bundle, 'commit-tree', tree, '-p', middle, '-p', self.installed, '-m', 'squash with a second parent')
        self.git(self.bundle, 'update-ref', SOURCE_REF, merge)
        self.publish_fixture_evidence(merge, self.proof['checkpoints'][2]['request'])
        code, state = self.poll()
        self.assertEqual((code, state['blocked'], state['loaded']), (1, 'factory-base-mismatch', self.installed))
        self.assertEqual(self.starts(), [self.installed])

    def test_native_squash_subject_does_not_select_the_commit_signature_rule(self):
        _first, middle, _last = self.checkpoints
        request = self.proof['checkpoints'][2]['request']
        squash = self.git(self.bundle, 'commit-tree', request['tree'], '-p', middle, '-m', 'Factory landing v1')
        self.git(self.bundle, 'update-ref', SOURCE_REF, squash)
        self.publish_fixture_evidence(squash, request)
        code, state = self.poll()
        self.assertEqual((code, state['loaded']), (0, squash), state)

    def test_timer_activates_every_native_squash_in_order(self):
        code, state = self.poll()
        self.assertEqual(code, 0, state)
        self.assertEqual(self.starts(), [self.installed, *self.checkpoints])
        expected = self.proof['checkpoints'][-1]
        self.assertEqual((state['loaded'], state['known_good'], state['phase']), (TIP, TIP, 'ready'))
        self.assertEqual((state['verified']['review'], state['verified']['evidence']), (expected['request'], expected['tagObject']))
        self.assertRegex(state['verified']['signer'], r'^[0-9A-F]{40}$')
        self.assertEqual(self.outcome(self.installed_command('status-receiver'))[1]['loaded'], TIP)
        self.assertEqual(self.poll()[1]['loaded'], TIP)
        self.assertEqual(self.starts(), [self.installed, *self.checkpoints])

    def test_missing_middle_evidence_blocks_the_series_before_any_switch(self):
        ref = EVIDENCE_ROOT + self.checkpoints[1]
        tag = self.tag_object(self.checkpoints[1])
        self.git(self.bundle, 'update-ref', '-d', ref)
        code, state = self.poll()
        self.assertEqual((code, state['blocked'], state['known_good'], state['loaded']),
                         (1, 'factory-evidence-fetch-failed', self.installed, self.installed))
        self.assertEqual(self.starts(), [self.installed])
        self.git(self.bundle, 'update-ref', ref, tag)
        self.assertEqual(self.poll()[1]['loaded'], TIP)
        self.assertEqual(self.starts(), [self.installed, *self.checkpoints])

    def test_evidence_that_names_another_squash_is_refused(self):
        first, middle, _last = self.checkpoints
        self.git(self.bundle, 'update-ref', EVIDENCE_ROOT + middle, self.tag_object(first))
        code, state = self.poll()
        self.assertEqual((code, state['blocked'], state['loaded']), (1, 'factory-squash-mismatch', self.installed))
        self.assertEqual(self.starts(), [self.installed])

    def test_operator_only_trust_refuses_the_factory_evidence(self):
        shutil.copyfile(self.export / 'operator-public.asc', self.receiver / 'factory-signers.asc')
        code, state = self.poll()
        self.assertEqual((code, state['blocked'], state['loaded']), (1, 'factory-signature-unverified', self.installed))
        self.assertEqual(self.starts(), [self.installed])

    def test_missing_or_swapped_reviewed_head_is_refused(self):
        first, middle, _last = self.checkpoints
        ref = REVIEW_ROOT + middle
        head = self.git(self.bundle, 'rev-parse', ref)
        self.git(self.bundle, 'update-ref', '-d', ref)
        self.assertEqual(self.poll()[1]['blocked'], 'factory-review-fetch-failed')
        self.git(self.bundle, 'update-ref', ref, self.git(self.bundle, 'rev-parse', REVIEW_ROOT + first))
        self.assertEqual(self.poll()[1]['blocked'], 'factory-review-ref-mismatch')
        self.assertEqual(self.starts(), [self.installed])
        self.git(self.bundle, 'update-ref', ref, head)
        self.assertEqual(self.poll()[1]['loaded'], TIP)

    def test_failed_middle_listener_restores_first_checkpoint_and_retries_in_order(self):
        first, middle, last = self.checkpoints
        unavailable = self.root / f'no-router-{middle}'
        unavailable.touch()
        code, state = self.poll()
        self.assertEqual(code, 1, state)
        self.assertEqual((state['desired'], state['known_good'], state['loaded']), (middle, first, first))
        self.assertEqual(self.starts(), [self.installed, first, middle, first])
        unavailable.unlink()
        self.assertEqual(self.poll()[1]['loaded'], last)
        self.assertEqual(self.starts(), [self.installed, first, middle, first, middle, last])

    def test_interrupted_squash_restores_the_previous_checkpoint_and_retries_in_order(self):
        first, middle, last = self.checkpoints
        interrupt = self.root / f'interrupt-{middle}'
        interrupt.touch()
        self.assertEqual(self.unit('update').returncode, -signal.SIGKILL)
        self.assertEqual(self.outcome(self.installed_command('status-receiver'))[1]['phase'], 'switching')
        self.assertIn('admission-closed', self.unit('keeper').stderr)
        interrupt.unlink()
        state = self.poll()[1]
        self.assertEqual((state['phase'], state['loaded'], state['blocked']), ('ready', first, 'activation-interrupted'))
        self.assertEqual(self.poll()[1]['loaded'], last)
        self.assertEqual(self.starts(), [self.installed, first, middle, first, middle, last])

    def test_uncertified_commit_after_the_loaded_tip_leaves_that_release_serving(self):
        self.assertEqual(self.poll()[1]['loaded'], TIP)
        raced = self.append_uncertified(TIP)
        for _attempt in range(2):
            code, state = self.poll()
            self.assertEqual((code, state['blocked']), (1, 'factory-evidence-fetch-failed'))
            self.assertEqual((state['phase'], state['known_good'], state['loaded'], state['desired']), ('ready', TIP, TIP, raced))
        self.assertEqual(self.starts(), [self.installed, *self.checkpoints])

    def test_uncertified_commit_between_certified_squashes_halts_the_series(self):
        first, middle, last = self.checkpoints
        raced = self.append_uncertified(middle)
        tree = self.git(self.bundle, 'rev-parse', f'{last}^{{tree}}')
        after = self.git(self.bundle, 'commit-tree', tree, '-p', raced, '-m', 'native squash on the raced base')
        self.git(self.bundle, 'update-ref', SOURCE_REF, after)
        code, state = self.poll()
        self.assertEqual((code, state['blocked'], state['loaded'], state['desired']),
                         (1, 'factory-evidence-fetch-failed', self.installed, after))
        self.git(self.bundle, 'update-ref', EVIDENCE_ROOT + raced, self.tag_object(last))
        self.assertEqual(self.poll()[1]['blocked'], 'factory-squash-mismatch')
        self.assertEqual(self.starts(), [self.installed])


class RecoveryCases:
    def test_missing_recovery_blocks_then_exact_evidence_allows_ordered_catch_up(self):
        *ordinary, middle, last = self.checkpoints
        self.assertEqual(middle, self.recovered)
        tag = self.tag_object(middle)
        ref = EVIDENCE_ROOT + middle
        self.git(self.bundle, 'update-ref', '-d', ref)
        code, state = self.poll()
        self.assertEqual((code, state['blocked'], state['loaded']), (1, 'factory-evidence-fetch-failed', self.installed))
        self.assertEqual(self.starts(), [self.installed])
        self.git(self.bundle, 'update-ref', ref, tag)
        (self.root / f'no-router-{last}').touch()
        code, state = self.poll()
        self.assertEqual((code, state['known_good'], state['loaded']), (1, middle, middle))
        self.assertEqual(self.starts(), [self.installed, *ordinary, middle, last, middle])
        self.assertEqual(self.outcome(self.installed_command('status-receiver'))[1]['loaded'], middle)
        (self.root / f'no-router-{last}').unlink()
        self.assertEqual(self.poll()[1]['loaded'], last)
        self.assertEqual(self.starts(), [self.installed, *ordinary, middle, last, middle, last])

    def test_gateway_refuses_to_switch_to_a_verified_squash(self):
        (self.root / 'require-gateway-drain').touch()
        code, state = self.poll()
        self.assertEqual((code, state['blocked'], state['loaded']), (1, 'gateway-drain-unavailable', self.installed))
        self.assertEqual(state['verified']['evidence'], self.proof['checkpoints'][0]['tagObject'])
        self.assertEqual(self.starts(), [self.installed])

    def test_keeper_and_status_require_saved_evidence_after_activation(self):
        middle = self.checkpoints[-2]
        self.git(self.bundle, 'update-ref', SOURCE_REF, middle)
        code, state = self.poll()
        self.assertEqual((code, state['loaded']), (0, middle))
        expected = self.proof['checkpoints'][-2]
        self.assertEqual((state['verified']['review'], state['verified']['landed'], state['verified']['tree']),
                         (expected['request'], expected['landed'], expected['landed']['tree']))
        (self.root / 'container.json').unlink()
        self.git(self.bundle, 'update-ref', '-d', EVIDENCE_ROOT + middle)
        self.assertEqual(self.unit('keeper').returncode, 0)
        checkout = self.receiver / 'releases' / middle
        (self.root / 'container.json').unlink()
        for namespace in ('refs/factory/release/', 'refs/factory/review/'):
            with self.subTest(namespace=namespace):
                ref = namespace + middle
                object_id = self.git(checkout, 'rev-parse', ref)
                self.git(checkout, 'update-ref', '-d', ref)
                self.assertIsNone(self.outcome(self.installed_command('status-receiver'))[1]['loaded'])
                self.assertIn('release-signature-unverified', self.unit('keeper').stderr)
                self.git(checkout, 'update-ref', ref, object_id)
        self.assertEqual(self.starts(), [self.installed, *self.checkpoints[:-1], middle])

@unittest.skipUnless(RECOVERY_EXPORT, 'provide the disposable #30 squash recovery export')
class ReceiverSquashRecovery(RecoveryCases, SquashFixture):
    archive = RECOVERY_EXPORT
    anchor = '56e8435a9ab17f33772b5d65041772267c289c08'
    tip = '7a752948f8c4fb4e3b86c0c962a8f8c16ce5d2ab'
    recovered = '4da30cf4d0ae103dfd4acb2177a9dca9714ce5d9'

@unittest.skipUnless(ENTRY_EXPORT, 'provide the disposable #30 entry-point export')
class ReceiverEntry(RecoveryCases, SquashFixture):
    archive = ENTRY_EXPORT
    def prepare_export(self):
        proof = json.loads((Path(self.archive) / 'squashes.json').read_text())
        rows = proof['checkpoints']
        self.assertEqual(len(rows), 4)
        self.assertEqual([row['request']['number'] for row in rows], [30, 32, 31, 33])
        self.assertEqual([row['request']['number'] for row in rows if 'landed' in row], [31])
        self.anchor, self.tip, self.recovered = proof['anchor'], proof['tip'], rows[2]['squash']
        super().prepare_export()

if __name__ == '__main__':
    unittest.main(verbosity=2)
