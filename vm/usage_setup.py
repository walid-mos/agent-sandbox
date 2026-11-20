import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile

from usage_state import STATE, private_directory, schedule_owner, stored_host

TIMER = 'pots-usage.timer'
SERVICE = 'pots-usage.service'


def create_identity(state):
    destination = state / 'host-id'
    with tempfile.NamedTemporaryFile(dir=state) as pending:
        pending.write(f'{secrets.token_hex(16)}\n'.encode())
        pending.flush()
        os.fsync(pending.fileno())
        try:
            os.link(pending.name, destination)
        except FileExistsError:
            pass
    stored_host(state)


def provision(root, systemctl):
    state = root / STATE.relative_to('/')
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    private_directory(state)
    for name in ('grants', 'receipts', 'export'):
        directory = state / name
        directory.mkdir(mode=0o700, exist_ok=True)
        private_directory(directory)
    create_identity(state)
    units = root / 'etc/systemd/system'
    units.mkdir(parents=True, exist_ok=True)
    for name in (SERVICE, TIMER):
        shutil.copyfile(Path(__file__).with_name(name), units / name)
        (units / name).chmod(0o644)
    verb = 'enable' if schedule_owner(state) == b'vm' else 'disable'
    systemctl(verb, TIMER)


def register_timer(verb, timer):
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', verb, '--now', timer], check=True)


if __name__ == '__main__':
    provision(Path('/'), register_timer)
