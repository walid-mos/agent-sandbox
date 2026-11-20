#!/usr/bin/env python3
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BUNDLE_FILES = ('lib/signed_commit.py', 'lib/source_refresh.py', 'lib/trusted_source.py', 'session/launch.env')
SIGNATURE_BINARIES = ('gpg', 'gpgconf')


def invoke(arguments, environment, **options):
    return subprocess.check_output(arguments, env=environment, text=True, **options).strip()


class VmBootstrap(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = [binary for binary in SIGNATURE_BINARIES if shutil.which(binary) is None]
        if missing:
            raise unittest.SkipTest(f'{", ".join(missing)} not found on PATH. The Factory image gains gpg at the next install.')
        keys = tempfile.TemporaryDirectory(prefix='vm-bootstrap-keys.')
        cls.addClassCleanup(keys.cleanup)
        cls.environment = {'PATH': os.environ['PATH'], 'HOME': keys.name, 'GNUPGHOME': keys.name,
                           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'LC_ALL': 'C'}
        cls.addClassCleanup(invoke, ['gpgconf', '--kill', 'gpg-agent'], cls.environment)
        invoke(['gpg', '--batch', '--quiet', '--passphrase', '', '--quick-generate-key',
                'Bootstrap Fixture <bootstrap@example.invalid>', 'ed25519', 'sign', '1d'], cls.environment,
               stderr=subprocess.DEVNULL)
        cls.public_key = invoke(['gpg', '--armor', '--export'], cls.environment)

    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix='vm-bootstrap-fixture.')
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.bundle = self.root / 'installed'
        for relative in BUNDLE_FILES:
            target = self.bundle / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, target)
        self.origin = self.root / 'origin.git'
        self.clone = self.root / 'clone'
        self.git(self.root, 'init', '-q', '--bare', '-b', 'main', str(self.origin))
        self.git(self.root, 'clone', '-q', str(self.origin), str(self.clone))
        (self.clone / 'tracked').write_text('installed\n')
        self.git(self.clone, 'add', 'tracked')
        self.git(self.clone, 'commit', '-qS', '-m', 'Installed source')
        self.git(self.clone, 'push', '-q', 'origin', 'main')
        self.installed = self.git(self.clone, 'rev-parse', 'HEAD')
        self.receiver = self.root / 'receiver'
        self.signers = self.root / 'trusted-signers.asc'
        self.signers.write_text(self.public_key + '\n')
        self.write_launch()

    def write_launch(self):
        values = dict(line.split('=', 1) for line in (ROOT / 'session/launch.env').read_text().splitlines() if line)
        values.update(POTS_SESSION_REPOSITORY=str(self.clone), POTS_TRUSTED_SIGNERS=str(self.signers),
                      POTS_SOURCE_URL=str(self.origin), POTS_RECEIVER=str(self.receiver),
                      POTS_TRUSTED_SOURCE=str(self.bundle))
        (self.bundle / 'session/launch.env').write_text(''.join(f'{key}={value}\n' for key, value in values.items()))

    def git(self, directory, *arguments):
        return invoke(['git', '-c', 'user.name=Bootstrap Fixture', '-c', 'user.email=bootstrap@example.invalid',
                       '-C', str(directory), *arguments], self.environment)

    def bootstrap(self, *arguments):
        return subprocess.run([sys.executable, '-I', str(self.bundle / 'lib/trusted_source.py'), 'bootstrap', *arguments],
                              env=self.environment, text=True, capture_output=True)

    def start_sealskin(self):
        mac = self.root / 'mac-source'
        binaries = self.root / 'binaries'
        binaries.mkdir()
        for relative in ('bin/sealskin-up', 'lib/sandbox.sh', 'lib/providers/colima.sh', 'vm/network.env'):
            target = mac / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, target)
        (mac / 'session').mkdir()
        shutil.copy2(self.bundle / 'session/launch.env', mac / 'session/launch.env')
        config = self.root / 'sandboxes' / 'probe'
        config.mkdir(parents=True)
        (config / 'sandbox.json').write_text('{"launcher":"sealskin","serverPort":8443}\n')
        self.stub(mac / 'bin/sealskin-apply', 'printf "unmanaged\n" > "$TEMPLATE"\n')
        self.stub(binaries / 'docker', '[ "$1 $2 $3" = "--context colima-probe compose" ] || exit 2\nprintf "started\n" > "$SERVER"\n')
        self.stub(binaries / 'colima', 'shift 4\n[ "$1 $2 $3" = "sudo env POTS_TRANSPORT=local" ] || exit 2\nshift 3\nexport POTS_TRANSPORT=local\nshift 2\nexec python3 -I "$FIXTURE_LAUNCH" "$@"\n')
        fixture_launch = self.root / 'fixture-launch.py'
        fixture_launch.write_text('import os, runpy, sys\n'
                                  'launcher, *arguments = sys.argv[1:]\n'
                                  'main = runpy.run_path(launcher)["main"]\n'
                                  'main.__globals__["ROOT"] = os.geteuid()\n'
                                  'main.__globals__["require_root_owned"] = lambda: None\n'
                                  'sys.exit(main(arguments))\n')
        environment = {**self.environment, 'PATH': f"{binaries}:{self.environment['PATH']}",
                       'POTS_RUNTIME': str(self.root), 'SANDBOX': 'probe', 'FIXTURE_LAUNCH': str(fixture_launch),
                       'TEMPLATE': str(self.root / 'template'), 'SERVER': str(self.root / 'server')}
        return subprocess.run([str(mac / 'bin/sealskin-up')], env=environment, text=True, capture_output=True)

    @staticmethod
    def stub(path, commands):
        path.write_text('#!/bin/sh\nset -eu\n' + commands)
        path.chmod(0o700)

    def test_enrolled_sealskin_server_start_preserves_the_selected_template(self):
        self.receiver.mkdir()
        template = self.root / 'template'
        template.write_text('selected release\n')
        result = self.start_sealskin()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'server').read_text(), 'started\n')
        self.assertEqual(template.read_text(), 'selected release\n')

    def test_unenrolled_sealskin_server_start_applies_the_operator_template(self):
        (self.clone / 'bin').mkdir()
        self.stub(self.clone / 'bin/sealskin-apply', 'printf "operator template\\n" > "$TEMPLATE"\n')
        self.git(self.clone, 'add', 'bin/sealskin-apply')
        self.git(self.clone, 'commit', '-qS', '-m', 'Operator template')
        result = self.start_sealskin()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'server').read_text(), 'started\n')
        self.assertEqual((self.root / 'template').read_text(), 'operator template\n')

    def test_enrolled_vm_verifies_the_clone_and_keeps_its_revision(self):
        self.receiver.mkdir()
        result = self.bootstrap()
        self.assertEqual(result.returncode, 1)
        self.assertIn('not root-owned', result.stderr)
        self.assertNotIn('owns scheduled updates', result.stderr)
        self.assertEqual(self.git(self.clone, 'rev-parse', 'HEAD'), self.installed)

    def test_unenrolled_vm_still_refreshes_the_clone(self):
        result = self.bootstrap()
        self.assertEqual(result.returncode, 1)
        self.assertIn('update runs as root', result.stderr)

    def test_enrolled_vm_refuses_to_point_the_clone_at_a_branch(self):
        self.receiver.mkdir()
        result = self.bootstrap('--branch', 'feature')
        self.assertEqual(result.returncode, 1)
        self.assertIn('bootstrap takes no branch', result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
