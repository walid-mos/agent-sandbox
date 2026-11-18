import fcntl
import json
import os
from pathlib import Path
import subprocess
import time

from managed_receiver import Receiver
from managed_update import Blocked, checkout_revision
from receiver_state import CONTROL, PROTOCOL, STATUS, admission, read_state, write_state

SERVICES = ('pots-gateway', 'pots-router', 'pots-watcher', 'pots-sources')
HEALTH_SECONDS = 60
COMMAND_SECONDS = 120
ROUTER_RESTART_PENDING = 'router-restart-pending'


class VmReceiver(Receiver):
    def __init__(self, root, launch, bundle, environment, *, fetch_endpoint=None):
        super().__init__(root, launch['POTS_SOURCE_URL'])
        self.vm = VmSession(root, launch, bundle, environment)
        self.fetch_endpoint = fetch_endpoint

    def poll(self, descriptor):
        if self.fetch_endpoint is not None:
            return super().poll(descriptor, *self.fetch_endpoint)
        return super().poll(descriptor)

    def call_runtime(self, operation, checkout, revision, descriptor, arguments=()):
        if operation == 'idle':
            self.vm.require_idle()
            self.require_gateway_drain()
            return b''
        if operation == 'restart':
            self.vm.restart(checkout, revision, descriptor)
            return b''
        if operation == 'health':
            self.vm.require_health(checkout, revision)
            return json.dumps({'protocol': PROTOCOL, 'loaded': revision}).encode()
        raise Blocked('vm-dispatch-requires-session-admission')

    def require_gateway_drain(self):
        raise Blocked('gateway-drain-unavailable')

    def initialize(self, descriptor):
        if os.path.lexists(self.root / CONTROL / STATUS):
            raise Blocked('receiver-already-initialized')
        revision = checkout_revision(self.root / 'checkout', self.origin)
        checkout = self.require_release(revision)
        self.vm.require_idle()
        self.vm.restart(checkout, revision, descriptor)
        return super().initialize(descriptor)

    def keep(self):
        with admission(self.root, fcntl.LOCK_EX) as descriptor:
            state = read_state(self.root)
            if state['phase'] != 'ready':
                raise Blocked('admission-closed')
            revision = state['known_good']
            checkout = self.require_release(revision)
            try:
                self.vm.require_health(checkout, revision)
            except Blocked:
                self.vm.require_idle()
                self.repair_runtime(state, 'session-restart-pending', lambda: self.vm.restart(checkout, revision, descriptor))
            container = self.vm.name()
            if not self.vm.router_current(container):
                self.repair_runtime(state, ROUTER_RESTART_PENDING,
                                    lambda: self.vm.restart_router(container, checkout, revision, descriptor))
            return container

    def restore(self, state, reason, descriptor):
        if state['phase'] != 'restoring' or reason != ROUTER_RESTART_PENDING:
            return super().restore(state, reason, descriptor)
        revision = state['known_good']
        try:
            checkout = self.require_release(revision)
            self.vm.recover_router(checkout, revision, descriptor)
        except (Blocked, OSError) as problem:
            failure = str(problem) if isinstance(problem, Blocked) else 'receiver-io-failed'
            return write_state(self.root, {**state, 'recovery_failure': failure})
        recovered = {**state, 'phase': 'ready', 'blocked': None, 'filesystem': revision, 'loaded': revision}
        recovered.pop('recovery_failure', None)
        return write_state(self.root, recovered)

    def repair_runtime(self, state, reason, restart):
        pending = write_state(self.root, {**state, 'phase': 'restoring', 'blocked': reason, 'loaded': None})
        try:
            restart()
        except Blocked as failure:
            write_state(self.root, {**pending, 'recovery_failure': str(failure)})
            raise
        write_state(self.root, state)


class VmSession:
    def __init__(self, root, launch, bundle, environment):
        self.root = root
        self.launch = launch
        self.launcher = bundle / 'bin/pots-session'
        self.environment = {**environment, 'POTS_TRANSPORT': 'local'}

    def command(self, *command, selection=None, pass_fds=()):
        try:
            return subprocess.check_output(command, env={**self.environment, **(selection or {})},
                                           text=True, timeout=COMMAND_SECONDS, pass_fds=pass_fds).strip()
        except (OSError, subprocess.SubprocessError) as error:
            raise Blocked(f'vm-command-failed:{Path(command[0]).name}:{command[1]}') from error

    def router_current(self, container):
        try:
            self.command(self.launcher, 'router-current', container)
        except Blocked:
            return False
        return True

    def name(self):
        containers = self.command(self.launcher, 'name-all').splitlines()
        if len(containers) > 1:
            raise Blocked('runtime-ambiguous-container')
        return containers[0] if containers else ''

    def require_idle(self):
        container = self.name()
        if not container:
            return
        try:
            raw = self.command(self.launcher, 'inventory', container)
            terminals = json.loads(raw)['terminals']
        except (Blocked, ValueError, KeyError, TypeError) as error:
            raise Blocked('runtime-inventory-unavailable') from error
        if not isinstance(terminals, list) or any(not isinstance(item, dict) or item.get('state') != 'finished'
                                                   for item in terminals):
            raise Blocked('runtime-busy')
        self.require_idle_bots(container)

    def require_idle_bots(self, container):
        status = self.command(self.launcher, 'bot-status', container)
        if ', working, ' in status:
            raise Blocked('runtime-busy')
        config = self.launch['POTS_SESSION_CONFIGURATION']
        try:
            bot = json.loads((Path(config) / 'sandbox.json').read_text())['bot'].lower()
        except (OSError, ValueError, AttributeError, KeyError, TypeError) as error:
            raise Blocked('runtime-inventory-unavailable') from error
        line = next((line for line in status.splitlines() if line.startswith(f'{bot}: ')), '')
        if ', idle, ' not in line:
            raise Blocked('runtime-inventory-unavailable')

    def marker(self, revision):
        return self.root / CONTROL / f'revision-{revision}'

    def restart(self, checkout, revision, descriptor):
        marker = self.marker(revision)
        if not marker.exists():
            with marker.open('x') as output:
                os.fchmod(output.fileno(), 0o644)
                output.write(f'{revision}\n')
        selection = {'POTS_RELEASE_CHECKOUT': str(checkout), 'POTS_RELEASE_CONTROL': str(self.root / CONTROL),
                     'POTS_RELEASE_MARKER': str(marker)}
        self.command(self.launcher, 'select-release', selection=selection, pass_fds=(descriptor,))
        self.await_health(checkout, revision)

    def recover_router(self, checkout, revision, descriptor):
        try:
            self.require_health(checkout, revision)
        except Blocked:
            container = self.require_selection(checkout, revision)
            self.restart_router(container, checkout, revision, descriptor)

    def restart_router(self, container, checkout, revision, descriptor):
        self.command(self.launcher, 'restart-router', container, pass_fds=(descriptor,))
        self.await_health(checkout, revision)

    def await_health(self, checkout, revision):
        deadline = time.monotonic() + HEALTH_SECONDS
        while True:
            try:
                self.require_health(checkout, revision)
                return
            except Blocked:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(1)

    def require_health(self, checkout, revision):
        container = self.require_selection(checkout, revision)
        self.command(self.launcher, 'health', container, revision, *SERVICES)

    def require_selection(self, checkout, revision):
        container = self.name()
        if not container:
            raise Blocked('runtime-no-container')
        try:
            mounts = json.loads(self.command('docker', 'inspect', '--format', '{{json .Mounts}}', container))
            self.require_mounts(mounts, checkout, revision)
        except (ValueError, TypeError, KeyError) as error:
            raise Blocked('runtime-health-invalid') from error
        return container

    def require_mounts(self, mounts, checkout, revision):
        expected = {self.launch['POTS_SESSION_REPOSITORY']: checkout,
                    '/custom-services.d': checkout / 'session/services.d',
                    self.launch['POTS_ADMISSION']: self.root / CONTROL,
                    self.launch['POTS_RELEASE_ID']: self.marker(revision)}
        actual = {item['Destination']: item['Source'] for item in mounts if item['RW'] is False and item['Type'] == 'bind'}
        if any(actual.get(path) != str(source) for path, source in expected.items()):
            raise Blocked('runtime-version-mismatch')
