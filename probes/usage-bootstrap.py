import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'vm'))
DAY = '2026-11-17'
NOW = dt.datetime(2026, 11, 18, 1, 15, tzinfo=dt.timezone.utc)
ORIGIN = 'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com'
BUCKET = 'synthetic-usage'


def load(name):
    spec = importlib.util.spec_from_file_location(name, REPO / 'vm' / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Bootstrap(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory(prefix='usage-bootstrap-')))
        self.probe = load('usage_probe')
        self.provision = load('usage_setup')
        self.calls = []
        self.first = self.install('first')

    def install(self, name):
        root = self.root / name
        self.provision.provision(root, lambda *command: subprocess.run(
            ['systemctl', f'--root={root}', *command], check=True, capture_output=True))
        return root

    def host(self, root):
        return (self.state(root) / 'host-id').read_text().strip()

    def state(self, root):
        return root / 'var/lib/pots-usage'

    def write(self, root, name, payload):
        path = self.state(root) / name
        path.write_text(json.dumps(payload))
        path.chmod(0o600)
        return path

    def enroll(self, host=None):
        self.write(self.first, 'enrollment.json', {'hostId': host or self.host(self.first), 'endpoint': ORIGIN, 'bucket': BUCKET})

    def grant(self, day=DAY, signed='20261118T011000Z', host=None):
        key = f'usage/v1/{host or self.host(self.first)}/{day}.json'
        return self.write(self.first, f'grants/{DAY}.json', {
            'url': f'{ORIGIN}/{BUCKET}/{key}?X-Amz-Date={signed}&X-Amz-Expires=900&fixture=synthetic',
        })

    def publish(self, state, host, day, grant):
        argv = self.probe.publisher_args(state, host, day, grant)
        self.calls.append(argv)
        return {'hostId': host, 'day': day, 'sha256': 'a' * 64}

    def run_probe(self):
        return self.probe.publish_pending(self.state(self.first), NOW, self.publish)

    def timers(self, root):
        return sorted(path.name for path in (root / 'etc/systemd/system/timers.target.wants').glob('*.timer'))

    def test_new_and_repeated_bootstrap_keep_one_timer_and_durable_distinct_ids(self):
        original = self.host(self.first)
        self.assertRegex(original, '^[a-f0-9]{32}$')
        self.assertEqual(self.timers(self.first), ['pots-usage.timer'])
        self.assertEqual(self.host(self.install('first')), original)
        self.assertEqual(self.timers(self.first), ['pots-usage.timer'])
        second = self.install('second')
        self.assertNotEqual(self.host(second), original)
        self.assertEqual(self.timers(second), ['pots-usage.timer'])

    def test_pot_owner_disables_vm_timer_and_blocks_manual_service_run(self):
        marker = self.state(self.first) / 'schedule-owner'
        marker.write_text('pot\n')
        marker.chmod(0o600)
        self.install('first')
        self.assertEqual(self.timers(self.first), [])
        self.assertEqual(self.run_probe(), 0)
        self.assertEqual(self.calls, [])

    def test_missing_or_wrong_enrollment_blocks_publication(self):
        self.grant()
        self.assertEqual(self.run_probe(), 0)
        self.enroll('f' * 32)
        self.assertEqual(self.run_probe(), 1)
        self.assertEqual(self.calls, [])

    def test_absent_expired_wrong_day_and_wrong_host_grants_block_publication(self):
        self.enroll()
        self.assertEqual(self.run_probe(), 0)
        for options in ({'signed': '20261118T000000Z'}, {'day': '2026-11-16'}, {'host': 'f' * 32}):
            with self.subTest(options=options):
                self.grant(**options)
                self.assertEqual(self.run_probe(), 1)
        self.assertEqual(self.calls, [])

    def test_valid_enrollment_passes_only_paths_and_records_one_success(self):
        self.enroll()
        grant = self.grant()
        self.assertEqual(self.run_probe(), 0)
        root = self.state(self.first)
        host = self.host(self.first)
        self.assertEqual(self.calls, [[
            'pnpm', 'run', 'publish-day', '--host-id', host, '--enrollment', str(root / 'enrollment.json'),
            '--grant', str(grant), '--export', str(root / 'export'), '--day', DAY,
        ]])
        receipt = root / f'receipts/{DAY}.json'
        self.assertEqual(json.loads(receipt.read_text()), {'hostId': host, 'day': DAY, 'sha256': 'a' * 64})
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.run_probe(), 0)
        self.assertEqual(len(self.calls), 1)

    def test_group_readable_or_symlink_grant_is_refused(self):
        self.enroll()
        grant = self.grant()
        grant.chmod(0o640)
        self.assertEqual(self.run_probe(), 1)
        destination = grant.with_suffix('.other')
        grant.rename(destination)
        os.symlink(destination, grant)
        self.assertEqual(self.run_probe(), 1)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
