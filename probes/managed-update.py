#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = next(line.split('=', 1)[1] for line in (ROOT / 'session/launch.env').read_text().splitlines()
              if line.startswith('POTS_SOURCE_URL='))
MAIN_REF = 'refs/remotes/origin/main'


def invoke(arguments, environment, **options):
    return subprocess.check_output(arguments, env=environment, text=True, **options).strip()


def snapshot(root):
    return {str(path.relative_to(root)): (path.lstat().st_mode, path.read_bytes() if path.is_file() else None)
            for path in root.rglob('*')}


class ManagedUpdate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        keys = tempfile.TemporaryDirectory(prefix='managed-update-keys.')
        cls.addClassCleanup(keys.cleanup)
        cls.environment = {
            'PATH': os.environ['PATH'], 'HOME': keys.name, 'GNUPGHOME': keys.name,
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'LC_ALL': 'C',
        }
        cls.addClassCleanup(invoke, ['gpgconf', '--kill', 'gpg-agent'], cls.environment)
        invoke(['gpg', '--batch', '--quiet', '--passphrase', '', '--quick-generate-key',
                'Receiver Fixture <fixture@example.invalid>', 'ed25519', 'sign', '1d'], cls.environment,
               stderr=subprocess.DEVNULL)
        cls.public_key = invoke(['gpg', '--armor', '--export'], cls.environment)
        listing = invoke(['gpg', '--with-colons', '--list-keys'], cls.environment, stderr=subprocess.DEVNULL)
        cls.fingerprint = next(line.split(':')[9] for line in listing.splitlines() if line.startswith('fpr:'))
        invoke(['gpg', '--batch', '--quiet', '--passphrase', '', '--quick-generate-key',
                'Other Fixture <other@example.invalid>', 'ed25519', 'sign', '1d'], cls.environment,
               stderr=subprocess.DEVNULL)

    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix='managed-update-fixture.')
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.source = self.root / 'fixture-source'
        self.source.mkdir()
        self.receiver = self.root / 'receiver'
        self.receiver.mkdir()
        self.checkout = self.receiver / 'checkout'
        self.stage = self.receiver / 'candidate.git'
        (self.receiver / 'source').write_text('agent-sandbox\n')
        (self.receiver / 'trusted-signers.asc').write_text(self.public_key + '\n')
        self.git(self.source, 'init', '-q', '-b', 'main')
        (self.source / 'tracked').write_text('before\n')
        self.git(self.source, 'add', 'tracked')
        self.git(self.source, 'commit', '-qS', '-m', 'Installed source')
        self.installed = self.git(self.source, 'rev-parse', 'HEAD')
        self.git(self.root, 'clone', '-q', '--no-local', str(self.source), str(self.checkout))
        self.git(self.checkout, 'remote', 'set-url', 'origin', ORIGIN)
        (self.source / 'tracked').write_text('after\n')
        self.git(self.source, 'commit', '-qaS', '-m', 'Candidate source')
        self.desired = self.git(self.source, 'rev-parse', 'HEAD')
        self.git(self.root, 'clone', '-q', '--bare', '--no-local', str(self.source), str(self.stage))
        self.git(self.stage, 'remote', 'set-url', 'origin', ORIGIN)
        self.stage_ref(self.desired)

    def git(self, directory, *arguments, **options):
        return invoke(['git', '-c', 'user.name=Receiver Fixture', '-c', 'user.email=fixture@example.invalid',
                       '-c', f'user.signingkey={self.fingerprint}', '-C', str(directory), *arguments],
                      self.environment, **options)

    def stage_ref(self, revision):
        self.git(self.stage, 'update-ref', MAIN_REF, revision)

    def run_preflight(self, revision=None, source='agent-sandbox', receiver=None):
        result = subprocess.run([sys.executable, '-IB', str(ROOT / 'lib/managed_update.py'),
                                 str(receiver or self.receiver), source, revision or self.desired],
                                env=self.environment, text=True, capture_output=True)
        self.assertTrue(result.stdout, result.stderr)
        return result.returncode, json.loads(result.stdout)

    def assert_blocked(self, reason, **options):
        code, receipt = self.run_preflight(**options)
        self.assertEqual(code, 1, receipt)
        self.assertEqual(receipt['blocked'], reason)
        self.assertIsNone(receipt['verified'])
        return receipt

    def test_signed_candidate_emits_only_source_evidence_and_changes_no_bytes(self):
        (self.receiver / 'provisioned.json').write_text(json.dumps({'revision': self.installed}))
        before = snapshot(self.receiver)
        code, receipt = self.run_preflight()
        self.assertEqual(code, 0, receipt)
        self.assertEqual(receipt['desired'], self.desired)
        self.assertEqual(receipt['checkout'], self.installed)
        self.assertEqual(receipt['verified'], {'revision': self.desired, 'signer': self.fingerprint})
        for field in ('provisioned', 'executables', 'process_starts', 'active', 'applied_rules', 'known_good', 'blocked'):
            self.assertIsNone(receipt[field], field)
        self.assertEqual(snapshot(self.receiver), before)

    def test_unrelated_checkout_remains_byte_for_byte_unchanged(self):
        (self.source / 'tracked').write_text('project edit\n')
        (self.source / 'untracked').write_text('project notes\n')
        before = snapshot(self.source)
        self.assert_blocked('receiver-inside-checkout', receiver=self.source)
        self.assertEqual(snapshot(self.source), before)

    def test_explicit_source_and_protected_enrollment_are_required(self):
        self.assert_blocked('source-not-enrolled', source='pi')
        self.assert_blocked('unknown-source', source='unknown')
        marker = self.receiver / 'source'
        marker.unlink()
        self.assert_blocked('receiver-not-enrolled')
        marker.write_text('agent-sandbox\n')
        marker.chmod(0o666)
        self.assert_blocked('unsafe-owner-or-mode')
        marker.chmod(0o644)
        self.receiver.chmod(0o775)
        self.assert_blocked('unsafe-owner-or-mode')
        self.receiver.chmod(0o755)
        marker.write_text('pi\n')
        self.assert_blocked('receiver-not-enrolled')

    def test_exact_object_must_match_staged_main(self):
        self.assert_blocked('invalid-candidate', revision=self.desired[:12])
        self.assert_blocked('candidate-ref-mismatch', revision=self.installed)
        self.git(self.stage, 'symbolic-ref', MAIN_REF, 'refs/heads/main')
        self.assert_blocked('candidate-ref-mismatch')
        self.git(self.stage, 'symbolic-ref', '--delete', MAIN_REF)
        self.assert_blocked('candidate-ref-mismatch')
        tree = self.git(self.stage, 'rev-parse', 'HEAD^{tree}')
        self.stage_ref(tree)
        self.assert_blocked('candidate-not-commit', revision=tree)

    def test_both_repositories_must_have_canonical_origin(self):
        for directory in (self.checkout, self.stage):
            with self.subTest(directory=directory.name):
                self.git(directory, 'remote', 'set-url', 'origin', 'https://example.invalid/another.git')
                self.assert_blocked('wrong-origin')
                self.git(directory, 'remote', 'set-url', 'origin', ' ' + ORIGIN)
                self.assert_blocked('wrong-origin')
                self.git(directory, 'remote', 'set-url', 'origin', ORIGIN)

    def test_branch_and_hidden_or_visible_checkout_edits_block(self):
        self.git(self.checkout, 'switch', '-qc', 'task')
        self.assert_blocked('wrong-checkout-branch')
        self.git(self.checkout, 'switch', '-q', 'main')
        tracked = self.checkout / 'tracked'
        tracked.write_text('local work\n')
        self.assert_blocked('dirty-checkout')
        self.git(self.checkout, 'update-index', '--assume-unchanged', 'tracked')
        self.assert_blocked('masked-checkout')
        self.git(self.checkout, 'update-index', '--no-assume-unchanged', 'tracked')
        tracked.write_text('before\n')
        (self.checkout / '.git/info/exclude').write_text('ignored\n')
        (self.checkout / 'ignored').touch()
        self.assert_blocked('dirty-checkout')

    def test_linked_worktrees_block_in_both_directions(self):
        linked = self.root / 'linked'
        self.git(self.checkout, 'worktree', 'add', '-qb', 'task', str(linked))
        self.assert_blocked('unsupported-git-metadata')
        self.git(self.checkout, 'worktree', 'remove', str(linked))
        self.checkout.rename(self.root / 'original')
        self.git(self.root / 'original', 'worktree', 'add', '-qb', 'other', str(self.checkout))
        self.assert_blocked('invalid-git-layout')

    def test_git_configuration_cannot_run_checkout_code(self):
        ran = self.root / 'fsmonitor-ran'
        monitor = self.root / 'fsmonitor'
        monitor.write_text(f'#!/bin/sh\ntouch "{ran}"\n')
        monitor.chmod(0o755)
        self.git(self.checkout, 'config', 'core.fsmonitor', str(monitor))
        self.assert_blocked('unsafe-git-config')
        self.assertFalse(ran.exists())

    def test_symlinked_receiver_and_alternate_objects_block(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.receiver, target_is_directory=True)
        self.assert_blocked('unsafe-path-type', receiver=alias)
        (self.stage / 'objects/info/alternates').write_text(str(self.source / '.git/objects') + '\n')
        self.assert_blocked('unsupported-git-metadata')

    def test_unsigned_installed_base_blocks_even_for_a_signed_candidate(self):
        self.git(self.checkout, 'commit', '-q', '--allow-empty', '-m', 'Unsigned installed commit')
        self.assert_blocked('installed-signature-unverified')

    def test_unsigned_candidate_blocks(self):
        tree = self.git(self.stage, 'rev-parse', 'HEAD^{tree}')
        unsigned = self.git(self.stage, 'commit-tree', tree, '-p', self.desired, '-m', 'Unsigned')
        self.stage_ref(unsigned)
        self.assert_blocked('candidate-signature-unverified', revision=unsigned)

    def test_candidate_signed_by_another_key_blocks(self):
        tree = self.git(self.stage, 'rev-parse', 'HEAD^{tree}')
        candidate = self.git(self.stage, 'commit-tree', '-Sother@example.invalid', tree, '-p', self.desired,
                             '-m', 'Signed by another key')
        self.stage_ref(candidate)
        self.assert_blocked('candidate-signature-unverified', revision=candidate)

    def test_unrelated_signed_history_blocks(self):
        tree = self.git(self.stage, 'rev-parse', 'HEAD^{tree}')
        orphan = self.git(self.stage, 'commit-tree', '-S', tree, '-m', 'Unrelated but signed')
        self.stage_ref(orphan)
        self.assert_blocked('candidate-not-fast-forward', revision=orphan)

    def test_signed_rewind_blocks(self):
        self.git(self.checkout, 'fetch', '-q', str(self.stage), MAIN_REF)
        self.git(self.checkout, 'merge', '--ff-only', self.desired)
        self.stage_ref(self.installed)
        self.assert_blocked('candidate-not-fast-forward', revision=self.installed)


if __name__ == '__main__':
    unittest.main()
