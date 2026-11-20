from contextlib import contextmanager
import fcntl
import json
import os
import stat
import tempfile

from managed_update import Blocked, SHA1, require_protected

PROTOCOL = 1
QUIESCING = 'quiescing'
RESUMING = 'resuming'
GATEWAY_PHASES = {QUIESCING, RESUMING}
PHASES = {'ready', 'switching', 'restoring'} | GATEWAY_PHASES
GATEWAY_HOLD_LENGTH = 32
CONTROL = 'control'
STATUS = 'status.json'
LOCK = 'admission.lock'


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def admission(root, mode):
    control = root / CONTROL
    control.mkdir(mode=0o755, exist_ok=True)
    require_protected(control, stat.S_ISDIR, (os.geteuid(),))
    lock = control / LOCK
    descriptor = os.open(lock, os.O_CREAT | os.O_NOFOLLOW | os.O_RDWR, 0o644)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise Blocked('invalid-admission-lock')
        require_protected(lock, stat.S_ISREG, (os.geteuid(),))
        os.fchmod(descriptor, 0o644)
        try:
            fcntl.flock(descriptor, mode | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Blocked('admission-busy') from None
        yield descriptor
    finally:
        os.close(descriptor)


def read_state(root):
    path = root / CONTROL / STATUS
    if not os.path.lexists(path):
        raise Blocked('receiver-not-initialized')
    require_protected(path, stat.S_ISREG, (os.geteuid(),))
    try:
        state = json.loads(path.read_text())
    except ValueError:
        raise Blocked('invalid-receiver-status') from None
    if not isinstance(state, dict) or state.get('protocol') != PROTOCOL or state.get('phase') not in PHASES:
        raise Blocked('incompatible-receiver-status')
    if any(not isinstance(state.get(key), str) or not SHA1.fullmatch(state[key]) for key in ('accepted', 'known_good')):
        raise Blocked('invalid-receiver-status')
    hold = state.get('gateway_hold')
    if hold is None and state['phase'] not in GATEWAY_PHASES:
        return state
    if (state['phase'] == 'ready' or not isinstance(hold, str) or len(hold) != GATEWAY_HOLD_LENGTH
            or any(character not in '0123456789abcdef' for character in hold)):
        raise Blocked('invalid-gateway-hold')
    return state


def write_state(root, state):
    control = root / CONTROL
    descriptor, filename = tempfile.mkstemp(prefix='.status.', dir=control)
    try:
        with os.fdopen(descriptor, 'w') as output:
            os.fchmod(output.fileno(), 0o644)
            json.dump(state, output)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(filename, control / STATUS)
        sync_directory(control)
    finally:
        if os.path.exists(filename):
            os.unlink(filename)
    return state
