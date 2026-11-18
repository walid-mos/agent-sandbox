from contextlib import contextmanager
import fcntl
import json
import os
import stat
import tempfile

from managed_update import Blocked, SHA1, require_protected

PROTOCOL = 1
PHASES = {'ready', 'switching', 'restoring'}


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def admission(root, mode):
    descriptor = os.open(root / 'admission.lock', os.O_CREAT | os.O_NOFOLLOW | os.O_RDWR, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise Blocked('invalid-admission-lock')
        require_protected(root / 'admission.lock', stat.S_ISREG, (os.geteuid(),))
        try:
            fcntl.flock(descriptor, mode | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Blocked('admission-busy') from None
        yield descriptor
    finally:
        os.close(descriptor)


def read_state(root):
    path = root / 'status.json'
    require_protected(path, stat.S_ISREG, (os.geteuid(),))
    try:
        state = json.loads(path.read_text())
    except ValueError:
        raise Blocked('invalid-receiver-status') from None
    if not isinstance(state, dict) or state.get('protocol') != PROTOCOL or state.get('phase') not in PHASES:
        raise Blocked('incompatible-receiver-status')
    if any(not isinstance(state.get(key), str) or not SHA1.fullmatch(state[key]) for key in ('accepted', 'known_good')):
        raise Blocked('invalid-receiver-status')
    return state


def write_state(root, state):
    descriptor, filename = tempfile.mkstemp(prefix='.status.', dir=root)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(state, output)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(filename, root / 'status.json')
        sync_directory(root)
    finally:
        if os.path.exists(filename):
            os.unlink(filename)
    return state
