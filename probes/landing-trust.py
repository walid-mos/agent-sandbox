#!/usr/bin/env python3
from pathlib import Path
import runpy
import shutil
import subprocess
import unittest

POLICY = runpy.run_path(str(Path(__file__).with_name('landing-policy.py')))
ROOT = POLICY['REPOSITORY']
ENVIRONMENT = POLICY['FIXED_ENVIRONMENT']
TRANSPORT = '''
POTS_TRANSPORT=provider
sandbox_vm() {
    for destination do :; done
    case "$destination" in
        "$POTS_TRUSTED_SOURCE"/*|"$POTS_TRUSTED_SIGNERS") ;;
        *) return 1 ;;
    esac
    install -D -m 0644 /dev/stdin "$destination"
}
'''


class LandingTrust(unittest.TestCase):
    def setUp(self):
        self.fixture = POLICY['LandingPolicy']()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.setUp()

    def install_launcher(self):
        fixture = self.fixture
        checkout = fixture.root / 'operator'
        (checkout / 'bin').mkdir(parents=True)
        (checkout / 'lib').mkdir()
        provision = checkout / 'bin/vm-trust'
        shutil.copyfile(ROOT / 'bin/vm-trust', provision)
        (checkout / 'lib/sandbox.sh').write_text(TRANSPORT)
        (checkout / 'trusted-signers.asc').write_text(fixture.public_key(fixture.operator, fixture.operator_key))
        (checkout / 'factory-signers.asc').write_text(fixture.public_key(fixture.factory, fixture.factory_key))
        bundle = fixture.root / 'installed'
        installed_signers = bundle / 'trusted-signers.asc'
        POLICY['run']('sh', str(provision), environment={**ENVIRONMENT, 'POTS_REPO': str(ROOT),
                      'POTS_RUNTIME': str(checkout), 'POTS_TRUSTED_SOURCE': str(bundle),
                      'POTS_TRUSTED_SIGNERS': str(installed_signers)})
        return bundle / 'lib/signed_commit.py', installed_signers

    def test_install_keeps_factory_signatures_out_of_legacy_root_trust(self):
        fixture = self.fixture
        verifier, installed_signers = self.install_launcher()
        release = fixture.signer.sign(fixture.request)
        verify = ['python3', '-I', str(verifier), 'verify', str(fixture.signer.store)]
        self.assertEqual(POLICY['run'](*verify, fixture.base, str(installed_signers)), fixture.operator_key)
        refused = subprocess.run([*verify, release['commit'], str(installed_signers)], env=ENVIRONMENT, capture_output=True, text=True)
        self.assertEqual(refused.returncode, 1, refused.stdout)
        self.assertIn('is not signed by a key in', refused.stderr)

    def test_signer_refuses_factory_signed_base_without_its_own_receipt(self):
        fixture = self.fixture
        base = fixture.git('commit-tree', fixture.tree, '-p', fixture.base, f'-S{fixture.factory_key}', '-m', 'unrecorded release',
                           environment={**ENVIRONMENT, 'GNUPGHOME': str(fixture.factory)})
        head = fixture.git('commit-tree', fixture.tree, '-p', base, '-m', 'checked review')
        fixture.publish(base, head)
        with self.assertRaisesRegex(fixture.module.Refused, 'not a trusted signed tip'):
            fixture.signer.sign({**fixture.request, 'base': base, 'head': head})
        self.assertFalse(fixture.signer.receipt.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
