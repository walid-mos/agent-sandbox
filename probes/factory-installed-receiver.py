#!/usr/bin/env python3
import fcntl
import json
from pathlib import Path
import runpy
import shlex
import signal
import shutil
import subprocess
import sys
import unittest

probe = runpy.run_path(str(Path(__file__).with_name('factory-producer-receiver.py')))
ROOT = probe['ROOT']


@unittest.skipUnless(probe['EXPORT'], 'provide a disposable #30 export')
class InstalledReceiver(probe['ProducerExportFixture']):
    def setUp(self):
        super().setUp()
        self.bundle_path = self.root / 'installed'
        self.config = self.root / 'configuration'
        self.config.mkdir()
        (self.config / 'sandbox.json').write_text('{"launcher":"docker","bot":"Probe"}\n')
        self.docker_bin = self.root / 'container-bin'
        self.docker_bin.mkdir()
        docker = self.docker_bin / 'docker'
        shutil.copy2(ROOT / 'probes/receiver-vm-docker.py', docker)
        docker.chmod(0o700)
        self.install_bundle()

    def initialize_runtime(self):
        pass

    def install_bundle(self):
        for entry in (ROOT / 'vm/trusted-bundle').read_text().splitlines():
            mode, relative = entry.split()
            target = self.bundle_path / relative
            subprocess.run(['install', '-D', '-m', mode, str(ROOT / relative), str(target)],
                           env=self.environment, check=True)
        launch_path = self.bundle_path / 'session/launch.env'
        launch = dict(line.split('=', 1) for line in launch_path.read_text().splitlines())
        launch.update(POTS_RECEIVER=str(self.receiver), POTS_SESSION_CONFIGURATION=str(self.config),
                      POTS_SOURCE_URL=probe['FIXTURE_ORIGIN'], POTS_ADMISSION=str(self.root / 'session-control'),
                      POTS_RELEASE_ID=str(self.root / 'release-id'), POTS_SESSION_LOCK_PATH=str(self.root / 'session.lock'))
        launch_path.write_text(''.join(f'{key}={value}\n' for key, value in launch.items()))
        self.launcher = self.bundle_path / 'lib/trusted_source.py'

    def unit(self, service):
        unit = (ROOT / 'vm' / f'pots-{service}.service').read_text()
        command = shlex.split(next(line.removeprefix('ExecStart=') for line in unit.splitlines()
                                   if line.startswith('ExecStart=')))
        self.assertEqual(command[:2], ['/usr/bin/python3', '-I'])
        self.assertEqual(Path(command[2]).name, self.launcher.name)
        return self.installed_command(*command[3:])

    def installed_command(self, *arguments):
        script = '''
import os, runpy, signal, sys
from pathlib import Path
launcher, endpoint, fixture, binaries, *argv = sys.argv[1:]
commands = runpy.run_path(launcher)
from receiver_vm import VmReceiver
import receiver_vm
receiver_vm.HEALTH_SECONDS = 0
factory = commands['vm_receiver'].__globals__
environment = {**commands['run_environment'](), 'PATH': binaries + ':' + commands['TRUSTED_PATH'],
               'RECEIVER_VM_FIXTURE': fixture}
class FixtureReceiver(VmReceiver):
    def call_runtime(self, operation, checkout, revision, descriptor, arguments=()):
        response = super().call_runtime(operation, checkout, revision, descriptor, arguments)
        if operation == 'restart' and (Path(fixture) / f'interrupt-{revision}').exists():
            os.kill(os.getpid(), signal.SIGKILL)
        return response
factory['vm_receiver'] = lambda root: FixtureReceiver(root, commands['LAUNCH'], commands['BUNDLE'], environment,
                                                     fetch_endpoint=(endpoint, 'file'))
sys.exit(commands['main'](argv))
'''
        return subprocess.run([sys.executable, '-IB', '-c', script, str(self.launcher), str(self.bundle),
                               str(self.root), str(self.docker_bin), *arguments], env=self.environment,
                              text=True, capture_output=True)

    def outcome(self, result):
        self.assertTrue(result.stdout, result.stderr)
        return result.returncode, json.loads(result.stdout)

    def starts(self):
        return (self.root / 'starts').read_text().splitlines()

    def test_timer_preserves_active_work_then_rolls_back_and_retries(self):
        self.assertEqual(self.outcome(self.installed_command('initialize-receiver'))[1]['loaded'], self.installed)
        active = self.root / 'active-worker'
        active.touch()
        self.assertEqual(self.outcome(self.unit('update'))[1]['blocked'], 'runtime-busy')
        self.assertEqual(self.starts(), [self.installed])
        active.unlink()
        bot = self.root / 'active-bot'
        bot.touch()
        self.assertEqual(self.outcome(self.unit('update'))[1]['blocked'], 'runtime-busy')
        self.assertEqual(self.starts(), [self.installed])
        bot.unlink()
        broken = self.root / f'unhealthy-{self.revision}'
        broken.touch()
        status = self.outcome(self.unit('update'))[1]
        self.assertEqual((status['phase'], status['loaded']), ('ready', self.installed))
        self.assertEqual(self.starts(), [self.installed, self.revision, self.installed])
        broken.unlink()
        self.assertEqual(self.outcome(self.unit('update'))[1]['loaded'], self.revision)
        self.assertEqual(self.starts()[-1], self.revision)

    def test_timer_rejects_an_untrusted_candidate_before_restarting(self):
        self.assertEqual(self.installed_command('initialize-receiver').returncode, 0)
        shutil.copyfile(self.export / 'operator-public.asc', self.receiver / 'factory-signers.asc')
        self.assertEqual(self.outcome(self.unit('update'))[1]['blocked'], 'factory-signature-unverified')
        self.assertEqual(self.starts(), [self.installed])

    def test_timer_restores_after_interruption_and_keeper_does_not_start_pending_release(self):
        self.assertEqual(self.installed_command('initialize-receiver').returncode, 0)
        interrupt = self.root / f'interrupt-{self.revision}'
        interrupt.touch()
        self.assertEqual(self.unit('update').returncode, -signal.SIGKILL)
        self.assertEqual(self.outcome(self.installed_command('status-receiver'))[1]['phase'], 'switching')
        self.assertIn('admission-closed', self.unit('keeper').stderr)
        interrupt.unlink()
        status = self.outcome(self.unit('update'))[1]
        self.assertEqual((status['phase'], status['loaded'], status['blocked']),
                         ('ready', self.installed, 'activation-interrupted'))
        self.assertEqual(self.outcome(self.unit('update'))[1]['loaded'], self.revision)
        self.assertEqual(self.starts(), [self.installed, self.revision, self.installed, self.revision])

    def test_keeper_shares_the_lock_and_restarts_only_the_known_good_release(self):
        self.assertEqual(self.installed_command('initialize-receiver').returncode, 0)
        self.assertEqual(self.outcome(self.unit('update'))[1]['loaded'], self.revision)
        (self.root / 'container.json').unlink()
        with probe['admission'](self.receiver, fcntl.LOCK_EX):
            keeper = self.unit('keeper')
            self.assertEqual(keeper.returncode, 1)
            self.assertIn('admission-busy', keeper.stderr)
            self.assertFalse((self.root / 'container.json').exists())
        self.assertEqual(self.unit('keeper').returncode, 0)
        self.assertEqual(self.starts(), [self.installed, self.revision, self.revision])


if __name__ == '__main__':
    unittest.main(verbosity=2)
