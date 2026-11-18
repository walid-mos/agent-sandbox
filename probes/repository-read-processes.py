#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import pwd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vm'))
import repository_read
from repository_read import bundle_for
from repository_read_fixture import POLICY, REPOSITORY
from vault_policy import Refused

ACCOUNT = 'pots-repository-read'
SETTLE_SECONDS = 2.5
POLL_SECONDS = 0.02

WORKER_TEMPLATE = '''\
import json
import os
import resource
import signal
import sys
from pathlib import Path

RECORDS, READY, MODE = Path({records!r}), Path({ready!r}), {mode!r}


def record(role):
    fields = Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()
    identity = {{'pid': os.getpid(), 'group': int(fields[2]), 'started': fields[19], 'uid': os.getuid()}}
    (RECORDS / f'{{role}}.json').write_text(json.dumps(identity))


def blocked(role, ready, hold):
    record(role)
    os.write(ready, b'1')
    os.read(hold, 1)


request = json.load(sys.stdin)
ready, announce = os.pipe()
blocked_pipe, hold = os.pipe()
child = os.fork()
if child == 0:
    grandchild = os.fork()
    if grandchild == 0:
        blocked('grandchild', announce, blocked_pipe)
        os._exit(0)
    blocked('child', announce, blocked_pipe)
    os.waitpid(grandchild, 0)
    os._exit(0)
record('worker')
acknowledged = b''
while acknowledged.count(b'1') < 2:
    acknowledged += os.read(ready, 2 - len(acknowledged))
with open(READY, 'wb', buffering=0) as notification:
    notification.write(b'1')
os.close(ready)
os.close(announce)
if MODE == 'success':
    sys.stdout.buffer.write(b'fixture-bundle')
    sys.exit(0)
if MODE == 'failure':
    sys.stderr.write('Git read failed. No credential fallback was attempted.')
    sys.exit(1)
if MODE == 'signal':
    os.kill(os.getpid(), signal.SIGKILL)
if MODE == 'resource':
    signal.signal(signal.SIGXFSZ, signal.SIG_DFL)
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    with open('limited-file', 'wb', buffering=0) as limited:
        limited.write(b'x')
if MODE == 'timeout':
    os.read(blocked_pipe, 1)
sys.exit(92)
'''


def fetch_account():
    return pwd.getpwnam(ACCOUNT)


def running_members(uid, group):
    members = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            owner = [line for line in (entry / 'status').read_text().splitlines() if line.startswith('Uid:')]
        except OSError:
            continue
        if int(fields[2]) != group or fields[0] == 'Z' or int(owner[0].split()[1]) != uid:
            continue
        members.append(int(entry.name))
    return members


def settled_members(uid, group):
    end = time.monotonic() + SETTLE_SECONDS
    members = running_members(uid, group)
    while members and time.monotonic() < end:
        time.sleep(POLL_SECONDS)
        members = running_members(uid, group)
    return members


def await_ready(path):
    end = time.monotonic() + SETTLE_SECONDS
    while not path.exists():
        if time.monotonic() >= end:
            raise AssertionError('worker never announced its descendants')
        time.sleep(POLL_SECONDS)


def read_boundary(root, mode):
    records = root / 'records'
    ready = records / 'ready'
    records.mkdir()
    account = fetch_account()
    os.chown(records, account.pw_uid, account.pw_gid)
    os.chmod(root, 0o755)
    directories_before = set(Path('/tmp').glob('repository-read-*'))
    worker = root / f'worker-{mode}.py'
    worker.write_text(WORKER_TEMPLATE.format(records=str(records), ready=str(ready), mode=mode))
    worker.chmod(0o644)
    request = {'kind': 'read', 'repository': REPOSITORY, 'commits': ['a' * 40]}
    slot_free = False
    try:
        with patch.object(repository_read, 'WORKER', worker), patch.object(repository_read, 'READ_SECONDS', 1):
            answer = bundle_for(request, POLICY, lambda path, name: 'invented-credential' if path == '/tools/github' else None)
    except Refused as error:
        answer = error
    finally:
        slot_free = repository_read.READ_LOCK.acquire(blocking=False)
        if slot_free:
            repository_read.READ_LOCK.release()
    await_ready(ready)
    identities = [json.loads((records / f'{role}.json').read_text()) for role in ('worker', 'child', 'grandchild')]
    leftovers = set(Path('/tmp').glob('repository-read-*')) - directories_before
    return {'answer': answer, 'identities': identities, 'uid': fetch_account().pw_uid, 'leftovers': leftovers, 'slot_free': slot_free}


class WorkerTeardownTests(unittest.TestCase):
    def assert_boundary_cleaned(self, found):
        group = found['identities'][0]['group']
        self.assertEqual(len({identity['group'] for identity in found['identities']}), 1, found['identities'])
        self.assertTrue(all(identity['uid'] == found['uid'] for identity in found['identities']), found['identities'])
        self.assertEqual(settled_members(found['uid'], group), [])
        self.assertEqual(found['leftovers'], set())
        self.assertTrue(found['slot_free'])

    def run_boundary(self, mode):
        with tempfile.TemporaryDirectory(prefix='repository-process-') as temporary:
            return read_boundary(Path(temporary), mode)

    def test_dedicated_account_descendants_stop_after_worker_success(self):
        self.assert_boundary_cleaned(self.run_boundary('success'))

    def test_dedicated_account_descendants_stop_after_early_worker_failure(self):
        found = self.run_boundary('failure')
        self.assertIn('Git read failed. No credential fallback was attempted.', str(found['answer']))
        self.assert_boundary_cleaned(found)

    def test_dedicated_account_descendants_stop_after_worker_signal(self):
        found = self.run_boundary('signal')
        self.assertIsInstance(found['answer'], Refused)
        self.assert_boundary_cleaned(found)

    def test_dedicated_account_descendants_stop_after_resource_exhaustion(self):
        found = self.run_boundary('resource')
        self.assertIsInstance(found['answer'], Refused)
        self.assert_boundary_cleaned(found)

    def test_dedicated_account_descendants_stop_after_worker_timeout(self):
        found = self.run_boundary('timeout')
        self.assertIn('Repository read timed out. No credential fallback was attempted.', str(found['answer']))
        self.assert_boundary_cleaned(found)

    def test_teardown_keeps_unrelated_same_account_processes(self):
        account = fetch_account()
        unrelated = subprocess.Popen(['sleep', '10'], preexec_fn=lambda: (os.setgroups([]), os.setgid(account.pw_gid), os.setuid(account.pw_uid)),
                                     start_new_session=True, stdin=subprocess.DEVNULL)
        try:
            with tempfile.TemporaryDirectory(prefix='repository-process-') as temporary:
                found = read_boundary(Path(temporary), 'failure')
                group = found['identities'][0]['group']
                self.assertEqual(settled_members(found['uid'], group), [])
            self.assertIsNone(unrelated.poll())
        finally:
            unrelated.terminate()
            unrelated.wait()


if __name__ == '__main__':
    if os.geteuid() != 0 or os.environ.get('REPOSITORY_READ_DISPOSABLE_VM') != '1':
        sys.exit('Run this probe only in its disposable factory-image container, as documented.')
    subprocess.run(['/usr/sbin/useradd', '--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', ACCOUNT], check=True)
    unittest.main()
