#!/usr/bin/env python3
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import runpy
import shlex
import signal
import shutil
import subprocess
import sys
from threading import Thread
import unittest

probe = runpy.run_path(str(Path(__file__).with_name('factory-producer-receiver.py')))
ROOT = probe['ROOT']


class InstalledFixture(probe['ProducerExportFixture']):
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
        self.start_router_probe()
        self.install_bundle()

    def start_router_probe(self):
        fixture_root, receiver = self.root, self.receiver

        class RouterProbe(BaseHTTPRequestHandler):
            def log_message(self, *_arguments):
                pass

            def do_GET(self):
                if self.path != '/api/hello' or self.headers.get('Authorization'):
                    self.send_error(400)
                    return
                if not (fixture_root / 'container.json').exists():
                    self.send_error(503)
                    return
                revision = json.loads((fixture_root / 'container.json').read_text())['revision']
                mark = fixture_root / f'late-router-{revision}'
                is_ready = not mark.exists() and not (fixture_root / f'no-router-{revision}').exists()
                if mark.exists():
                    mark.unlink()
                    try:
                        with probe['admission'](receiver, fcntl.LOCK_SH):
                            (fixture_root / 'admitted-early').touch()
                    except RuntimeError as failure:
                        if str(failure) != 'admission-busy':
                            raise
                self.send_response(200 if is_ready else 503)
                self.end_headers()

        listener = ThreadingHTTPServer(('127.0.0.1', 0), RouterProbe)
        self.router_address = f'{listener.server_address[0]}:{listener.server_address[1]}'
        self.addCleanup(listener.server_close)
        server = Thread(target=listener.serve_forever)
        server.start()
        self.addCleanup(server.join)
        self.addCleanup(listener.shutdown)

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
                      POTS_RELEASE_ID=str(self.root / 'release-id'), POTS_SESSION_LOCK_PATH=str(self.root / 'session.lock'),
                      POTS_ROUTER_DEFAULT_ADDRESS=self.router_address)
        launch_path.write_text(''.join(f'{key}={value}\n' for key, value in launch.items()))
        self.launcher = self.bundle_path / 'lib/trusted_source.py'

    def unit(self, service):
        lines = (ROOT / 'vm' / f'pots-{service}.service').read_text().splitlines()
        command = shlex.split(next(line.removeprefix('ExecStart=') for line in lines if line.startswith('ExecStart=')))
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
receiver_vm.HEALTH_SECONDS = 3 if (Path(fixture) / 'wait-for-router').exists() else 0
factory = commands['vm_receiver'].__globals__
environment = {**commands['run_environment'](), 'PATH': binaries + ':' + commands['TRUSTED_PATH'],
               'RECEIVER_VM_FIXTURE': fixture}
class FixtureReceiver(VmReceiver):
    def require_gateway_drain(self):
        if (Path(fixture) / 'require-gateway-drain').exists():
            super().require_gateway_drain()

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


@unittest.skipUnless(probe['EXPORT'], 'provide a disposable #30 export')
class InstalledReceiver(InstalledFixture):
    def setUp(self):
        super().setUp()
        code, status = self.outcome(self.installed_command('initialize-receiver'))
        self.assertEqual((code, status['loaded']), (0, self.installed))

    def test_timer_preserves_active_work_then_rolls_back_and_retries(self):
        (self.root / 'active-worker').touch()
        self.assertEqual(self.outcome(self.unit('update'))[1]['blocked'], 'runtime-busy')
        self.assertEqual(self.starts(), [self.installed])
        (self.root / 'active-worker').unlink()
        (self.root / 'active-bot').touch()
        self.assertEqual(self.outcome(self.unit('update'))[1]['blocked'], 'runtime-busy')
        self.assertEqual(self.starts(), [self.installed])
        (self.root / 'active-bot').unlink()
        broken = self.root / f'unhealthy-{self.revision}'
        broken.touch()
        status = self.outcome(self.unit('update'))[1]
        self.assertEqual((status['phase'], status['loaded']), ('ready', self.installed))
        self.assertEqual(self.starts(), [self.installed, self.revision, self.installed])
        broken.unlink()
        self.assertEqual(self.outcome(self.unit('update'))[1]['loaded'], self.revision)
        self.assertEqual(self.starts()[-1], self.revision)

    def test_live_gateway_blocks_activation_after_verification_without_advancing_admission(self):
        (self.root / 'require-gateway-drain').touch()
        for _attempt in range(2):
            code, state = self.outcome(self.unit('update'))
            self.assertEqual((code, state['blocked']), (1, 'gateway-drain-unavailable'))
            self.assertEqual((state['desired'], state['verified']['revision']), (self.revision, self.revision))
            self.assertEqual((state['phase'], state['accepted'], state['loaded']), ('ready', self.installed, self.installed))
            self.assertEqual(self.starts(), [self.installed])

    def test_timer_rejects_an_untrusted_candidate_before_restarting(self):
        shutil.copyfile(self.export / 'operator-public.asc', self.receiver / 'factory-signers.asc')
        self.assertEqual(self.outcome(self.unit('update'))[1]['blocked'], 'factory-signature-unverified')
        self.assertEqual(self.starts(), [self.installed])

    def test_timer_restores_after_interruption_and_keeper_does_not_start_pending_release(self):
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

    def test_timer_restores_if_candidate_listener_is_unavailable(self):
        unavailable = self.root / f'no-router-{self.revision}'
        unavailable.touch()
        status = self.outcome(self.unit('update'))[1]
        self.assertEqual((status['phase'], status['loaded']), ('ready', self.installed))
        self.assertEqual(self.starts(), [self.installed, self.revision, self.installed])
        unavailable.unlink()
        self.assertEqual(self.outcome(self.unit('update'))[1]['loaded'], self.revision)

    def test_router_only_restart_waits_under_admission_for_a_late_listener(self):
        (self.root / 'wait-for-router').touch()
        (self.root / 'router-outdated').touch()
        (self.root / 'router-after-restart').write_text('late')
        result = self.unit('keeper')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / f'late-router-{self.installed}').exists())
        self.assertFalse((self.root / 'admitted-early').exists())
        self.assertEqual(self.starts(), [self.installed])

    def test_timer_recovers_the_router_without_interrupting_active_work(self):
        for marker in ('router-outdated', 'active-worker', 'active-bot'):
            (self.root / marker).touch()
        (self.root / 'router-after-restart').write_text('no')
        self.assertNotEqual(self.unit('keeper').returncode, 0)
        code, status = self.outcome(self.unit('update'))
        self.assertEqual((code, status['phase'], status['loaded']), (1, 'restoring', None))
        self.assertEqual(status['blocked'], 'router-restart-pending')
        self.assertEqual(self.starts(), [self.installed])
        (self.root / f'no-router-{self.installed}').unlink()
        code, status = self.outcome(self.unit('update'))
        self.assertEqual((code, status['phase'], status['loaded']), (0, 'ready', self.installed))
        self.assertEqual((self.root / 'router-restarts').read_text().splitlines(), [self.installed] * 2)
        self.assertEqual(self.starts(), [self.installed])

    def test_keeper_preserves_router_pin_maintenance_on_the_loaded_release(self):
        (self.root / 'router-outdated').touch()
        result = self.unit('keeper')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / 'router-outdated').exists())
        self.assertEqual((self.root / 'router-restarts').read_text().splitlines(), [self.installed])
        self.assertEqual(self.starts(), [self.installed])

    def test_keeper_does_not_reopen_admission_after_an_unready_session_restart(self):
        (self.root / 'container.json').unlink()
        unavailable = self.root / f'no-router-{self.installed}'
        unavailable.touch()
        self.assertNotEqual(self.unit('keeper').returncode, 0)
        status = self.outcome(self.installed_command('status-receiver'))[1]
        self.assertEqual((status['phase'], status['loaded']), ('restoring', None))
        unavailable.unlink()
        self.assertEqual(self.outcome(self.unit('update'))[1]['loaded'], self.installed)

    def test_keeper_shares_the_lock_and_restarts_only_the_known_good_release(self):
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
