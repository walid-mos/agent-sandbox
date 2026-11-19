#!/usr/bin/env python3
from configparser import ConfigParser
from contextlib import ExitStack
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from repository_read_fixture import POLICY, REPOSITORY, ROOT
import repository_process
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

    def test_workspace_and_marker_outlive_private_temp(self):
        private_tmp = self.root / 'private-tmp'
        private_tmp.mkdir()
        make_workspace = tempfile.mkdtemp

        def make_in_fixture(*arguments, dir=None, **options):
            parent = private_tmp if Path(dir) == Path('/tmp') else Path(dir)
            self.assertTrue(parent.is_relative_to(self.root))
            return make_workspace(*arguments, dir=parent, **options)

        with patch.object(tempfile, 'mkdtemp', side_effect=make_in_fixture), patch('repository_process.has_live_members', side_effect=PermissionError):
            with self.assertRaisesRegex(Refused, BLOCKED):
                repository_read.bundle_for(REQUEST, POLICY, lambda *_: 'fixture', self.marker)
        REMOVE_WORKSPACE(private_tmp)
        retained, = self.marker.parent.glob('repository-read-*')
        self.assertEqual(stat.S_IMODE(retained.stat().st_mode), 0o700)
        self.assertTrue(self.marker.is_file())
        read_secret = Mock()
        with patch.object(repository_read, 'READ_LOCK', threading.Lock()), self.assertRaisesRegex(Refused, BLOCKED):
            repository_read.bundle_for(REQUEST, POLICY, read_secret, self.marker)
        read_secret.assert_not_called()

    def test_unprotected_state_directory_refuses_before_vault_access(self):
        self.marker.parent.chmod(0o777)
        read_secret = Mock(return_value='fixture')
        with self.capture_workspaces(), self.assertRaises(Refused):
            repository_read.bundle_for(REQUEST, POLICY, read_secret, self.marker)
        read_secret.assert_not_called()
        self.assertEqual(self.processes, [])

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
            self.assertEqual(dir, self.marker.parent)
            directory = Path(make_workspace(suffix=suffix, prefix=prefix, dir=dir))
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


class TaskInspectionTests(unittest.TestCase):
    def setUp(self):
        self.proc = Path(self.enterContext(tempfile.TemporaryDirectory(prefix='repository-tasks-')))
        self.enterContext(patch.object(repository_process, 'PROC', self.proc))
        self.process = self.proc / '40'
        self.tasks = self.process / 'task'
        self.write_stat(self.process, 'Z')
        self.write_stat(self.tasks / '40', 'Z')

    def write_stat(self, entry, state):
        entry.mkdir(parents=True, exist_ok=True)
        (entry / 'stat').write_text(f'{entry.name} (fixture ) name) {state} 1 40 40\n')

    def test_exited_leader_does_not_hide_live_thread(self):
        self.write_stat(self.tasks / '41', 'D')
        self.assertTrue(repository_process.has_live_members(40))
        self.assertFalse(repository_process.has_live_members(42))

    def test_all_visible_tasks_exited(self):
        self.write_stat(self.tasks / '41', 'X')
        self.assertFalse(repository_process.has_live_members(40))

    def test_missing_or_empty_task_list_is_unconfirmed(self):
        REMOVE_WORKSPACE(self.tasks)
        with self.assertRaises(OSError):
            repository_process.has_live_members(40)
        self.tasks.mkdir()
        with self.assertRaises(OSError):
            repository_process.has_live_members(40)

    def test_visible_task_with_missing_state_is_unconfirmed(self):
        (self.tasks / '41').mkdir()
        with self.assertRaises(OSError):
            repository_process.has_live_members(40)

    def test_process_reaped_during_task_inspection_is_confirmed_gone(self):
        enumerate_directory = Path.iterdir

        def reap_before_task_listing(path):
            if path == self.tasks:
                REMOVE_WORKSPACE(self.process)
            return enumerate_directory(path)

        with patch.object(Path, 'iterdir', reap_before_task_listing):
            self.assertFalse(repository_process.has_live_members(40))

    def test_visible_process_with_missing_state_is_unconfirmed(self):
        (self.process / 'stat').unlink()
        with self.assertRaises(OSError):
            repository_process.has_live_members(40)


class WorkspaceConfigTests(unittest.TestCase):
    def test_systemd_keeps_state_outside_private_tmp_and_session_binds(self):
        unit = ConfigParser(interpolation=None)
        unit.read(ROOT / 'vm/pots-vault.service')
        service = unit['Service']
        self.assertEqual(service['PrivateTmp'], 'yes')
        self.assertEqual(service.get('RuntimeDirectoryPreserve'), 'yes')
        self.assertEqual(int(service['RuntimeDirectoryMode'], 8), 0o711)
        self.assertTrue(service['ExecStart'].endswith('vm/vault-broker'))
        runtime = Path('/run') / service['RuntimeDirectory']
        self.assertEqual(runtime.parent, Path('/run'))
        binds = subprocess.check_output([ROOT / 'bin/render-config', 'binds'], text=True).splitlines()
        for bind in binds:
            self.assertFalse(runtime.is_relative_to(Path(bind.split(':', 1)[0])), bind)


if __name__ == '__main__':
    unittest.main()
