#!/usr/bin/env python3
from contextlib import ExitStack
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from repository_read_fixture import POLICY, REPOSITORY
import repository_read
from vault_policy import Refused

REQUEST = {'kind': 'read', 'repository': REPOSITORY, 'commits': []}
BLOCKED = 'Repository reads are blocked because worker cleanup could not be confirmed. Ask the VM operator to recover the broker.'
SPAWN = subprocess.Popen
SIGNAL_GROUP = os.killpg
REMOVE_WORKSPACE = repository_read.shutil.rmtree


class SupervisionTests(unittest.TestCase):
    def setUp(self):
        patches = self.enterContext(ExitStack())
        self.root = Path(patches.enter_context(tempfile.TemporaryDirectory(prefix='repository-supervision-')))
        worker = self.root / 'worker.py'
        worker.write_text('import sys\nsys.stdin.buffer.read()\nsys.stdout.buffer.write(b"fixture-bundle")\n')
        self.processes = []
        self.wait_failure = None
        self.addCleanup(self.reap_fixture_workers)
        patches.enter_context(patch.object(repository_read, 'WORKER', worker))
        patches.enter_context(patch.object(repository_read, 'READ_LOCK', threading.Lock()))
        self.marker = self.root / 'pending'
        self.account = SimpleNamespace(pw_uid=os.getuid() or 1, pw_gid=os.getgid() or 1)
        patches.enter_context(patch.object(repository_read.os, 'chown'))
        patches.enter_context(patch.object(repository_read.pwd, 'getpwnam', return_value=self.account))
        patches.enter_context(patch.object(repository_read.subprocess, 'Popen', side_effect=self.spawn_worker))

    def spawn_worker(self, *arguments, **options):
        self.assertEqual(options.pop('extra_groups'), ())
        self.assertEqual(options.pop('user'), self.account.pw_uid)
        self.assertEqual(options.pop('group'), self.account.pw_gid)
        process = SPAWN(*arguments, **options)
        self.processes.append(process)
        if self.wait_failure:
            self.enterContext(patch.object(process, 'wait', side_effect=self.wait_failure))
        return process

    def reap_fixture_workers(self):
        for process in self.processes:
            if process.stdin:
                process.stdin.close()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)

    def test_group_signal_precedes_leader_reaping_and_workspace_removal(self):
        outcomes = []

        def signal_owned_group(group, sig):
            leader = self.processes[-1]
            self.assertEqual(group, leader.pid)
            self.assertTrue(self.workspaces[0].is_dir())
            self.assertTrue(self.marker.is_file())
            status = os.waitid(os.P_PID, group, os.WEXITED | os.WNOWAIT | os.WNOHANG)
            self.assertEqual(status.si_pid, group)
            outcomes.append('signal')
            SIGNAL_GROUP(group, sig)

        def remove_workspace(directory):
            self.assertEqual(self.processes[-1].returncode, 0)
            self.assertTrue(self.marker.is_file())
            read_secret = Mock()
            with self.assertRaisesRegex(Refused, 'Another repository read is running'):
                repository_read.bundle_for(REQUEST, POLICY, read_secret, self.marker)
            read_secret.assert_not_called()
            outcomes.append('remove')
            REMOVE_WORKSPACE(directory)

        with self.capture_workspaces(), patch('repository_process.os.killpg', side_effect=signal_owned_group), patch.object(repository_read.shutil, 'rmtree', side_effect=remove_workspace):
            reply = repository_read.bundle_for(REQUEST, POLICY, lambda *_: 'fixture', self.marker)
        self.assertEqual(reply, {'ok': True, 'bundle': 'Zml4dHVyZS1idW5kbGU='})
        self.assertEqual(outcomes, ['signal', 'remove'])
        self.assertFalse(self.workspaces[0].exists())
        self.assertFalse(repository_read.READ_LOCK.locked())
        self.assertFalse(self.marker.exists())

    def test_exit_observer_setup_failure_still_reaps_worker(self):
        with self.capture_workspaces(), patch('repository_process.os.pidfd_open', side_effect=OSError('private detail')):
            with self.assertRaisesRegex(Refused, '^Repository worker exit could not be observed\\.'):
                repository_read.bundle_for(REQUEST, POLICY, lambda *_: 'fixture', self.marker)
        self.assertIsNotNone(self.processes[-1].returncode)
        self.assertFalse(self.workspaces[0].exists())
        self.assertFalse(repository_read.READ_LOCK.locked())
        self.assertFalse(self.marker.exists())

    def test_signal_failure_retains_workspace_and_blocks_vault_access(self):
        self.assert_blocked_after(patch('repository_process.os.killpg', side_effect=PermissionError('private detail')))

    def test_unreadable_group_state_retains_workspace_and_blocks_reads(self):
        self.assert_blocked_after(patch('repository_process.has_live_members', side_effect=PermissionError('private detail')))

    def test_live_group_past_deadline_retains_workspace_and_blocks_reads(self):
        with patch('repository_process.TERMINATION_SECONDS', 0):
            self.assert_blocked_after(patch('repository_process.has_live_members', return_value=True))

    def test_workspace_removal_failure_keeps_reads_blocked(self):
        self.assert_blocked_after(patch.object(repository_read.shutil, 'rmtree', side_effect=PermissionError('private detail')))
        self.assertIsNotNone(self.processes[-1].returncode)

    def test_leader_reap_timeout_retains_workspace_and_blocks_reads(self):
        def cannot_reap(timeout=None):
            self.assertGreaterEqual(timeout, 0)
            self.assertLessEqual(timeout, 5)
            raise subprocess.TimeoutExpired('private detail', timeout)

        self.assert_blocked_after(patch.object(self, 'wait_failure', cannot_reap))

    def capture_workspaces(self):
        self.workspaces = []
        make_workspace = tempfile.mkdtemp

        def workspace_in_fixture(suffix=None, prefix=None, dir=None):
            directory = Path(make_workspace(suffix=suffix, prefix=prefix, dir=self.root))
            self.workspaces.append(directory)
            return str(directory)

        return patch.object(tempfile, 'mkdtemp', side_effect=workspace_in_fixture)

    def assert_blocked_after(self, failure):
        with self.capture_workspaces(), failure:
            with self.assertRaises(Refused) as refusal:
                repository_read.bundle_for(REQUEST, POLICY, lambda *_: 'fixture', self.marker)
        self.assertEqual(str(refusal.exception), BLOCKED)
        self.assertEqual(len(self.workspaces), 1)
        self.assertTrue(self.workspaces[0].is_dir())
        self.assertTrue(self.marker.is_file())
        read_secret = Mock()
        with patch.object(repository_read, 'READ_LOCK', threading.Lock()), self.assertRaises(Refused) as refusal:
            repository_read.bundle_for(REQUEST, POLICY, read_secret, self.marker)
        self.assertEqual(str(refusal.exception), BLOCKED)
        read_secret.assert_not_called()


if __name__ == '__main__':
    unittest.main()
