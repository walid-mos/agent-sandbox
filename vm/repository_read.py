import base64
from contextlib import contextmanager
import json
import os
import pwd
import signal
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
from repository_git import BUNDLE_LIMIT, environment
from repository_process import CleanupUnconfirmed, READ_SECONDS, terminate_and_reap, wait_for_exit, worker_input
from vault_policy import GITHUB_PATH, Refused, WRITABLE_BY_OTHERS, read_grant

FETCH_ACCOUNT = 'pots-repository-read'
READ_LOCK = threading.Lock()
STATE_DIRECTORY_FORBIDDEN = WRITABLE_BY_OTHERS | stat.S_IRGRP | stat.S_IROTH
CLEANUP_REFUSAL = 'Repository reads are blocked because worker cleanup could not be confirmed. Ask the VM operator to recover the broker.'
WORKER = Path(__file__).resolve().parents[1] / 'lib/repository_bundle.py'


@contextmanager
def pending_read(marker):
    try:
        state = marker.parent.lstat()
        if not stat.S_ISDIR(state.st_mode) or state.st_uid != os.geteuid() or state.st_mode & STATE_DIRECTORY_FORBIDDEN:
            raise OSError('Repository read state directory is not private to the broker.')
        with marker.open('xb'):
            pass
    except OSError:
        raise Refused(CLEANUP_REFUSAL) from None
    is_cleanup_confirmed = True
    try:
        yield
    except CleanupUnconfirmed:
        is_cleanup_confirmed = False
        raise Refused(CLEANUP_REFUSAL) from None
    finally:
        if is_cleanup_confirmed:
            remove_marker(marker)


def remove_marker(marker):
    try:
        marker.unlink()
    except OSError:
        raise Refused(CLEANUP_REFUSAL) from None


def bundle_for(request, sandbox, read_secret, marker):
    name = read_grant(request, sandbox)
    if not READ_LOCK.acquire(blocking=False):
        raise Refused('Another repository read is running. Retry after it finishes.')
    try:
        with pending_read(marker):
            bundle = fetch_grant(request, name, read_secret, marker.parent)
        return {'ok': True, 'bundle': base64.b64encode(bundle).decode('ascii')}
    finally:
        READ_LOCK.release()


def fetch_grant(request, name, read_secret, state_directory):
    token = read_secret(GITHUB_PATH, name)
    if not token or any(character in token for character in '\r\n\0'):
        raise Refused('The configured repository credential is empty or multiline. Ask the operator to replace it.')
    try:
        return fetch(request, token, state_directory)
    except Refused as error:
        raise Refused(f"{error} Repository {request['repository']}, credential {name}.") from None
    except (OSError, ValueError):
        raise Refused('Repository read could not prepare or run the worker. Ask the VM operator to check the broker.') from None


def fetch(request, token, state_directory):
    try:
        account = pwd.getpwnam(FETCH_ACCOUNT)
    except KeyError:
        raise Refused('The VM fetch account is missing. Ask the operator to run bin/vm-up.') from None
    if account.pw_uid == 0:
        raise Refused('The VM fetch account must not be root.')
    with fetch_workspace(state_directory) as directory:
        os.chown(directory, account.pw_uid, account.pw_gid)
        return run_worker(directory, account, request, token)


@contextmanager
def fetch_workspace(state_directory):
    directory = tempfile.mkdtemp(prefix='repository-read-', dir=state_directory)
    is_cleanup_confirmed = True
    try:
        yield directory
    except CleanupUnconfirmed:
        is_cleanup_confirmed = False
        raise
    finally:
        if is_cleanup_confirmed:
            remove_workspace(directory)


def remove_workspace(directory):
    try:
        shutil.rmtree(directory)
    except OSError:
        raise CleanupUnconfirmed() from None


def refusal_text(errors, returncode):
    errors.seek(0)
    text = errors.read(4096).decode('utf8', errors='replace')
    allowed = ('GitHub refused this token', 'Commit ', 'Git read failed', 'Repository bundle exceeds', 'Repository read failed')
    if text.startswith(allowed):
        return text
    if returncode < 0 and -returncode in (signal.SIGKILL, signal.SIGXFSZ, signal.SIGTERM):
        return 'Repository read stopped before finishing. No credential fallback was attempted.'
    return 'Repository read failed within its resource limits.'


def run_worker(directory, account, request, token):
    payload = json.dumps({'repository': request['repository'], 'commits': request['commits'], 'token': token}).encode()
    with worker_input(payload) as reader, tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(['/usr/bin/python3', '-I', str(WORKER)], cwd=directory, env=environment(directory),
                                   stdin=reader, stdout=output, stderr=errors, start_new_session=True,
                                   user=account.pw_uid, group=account.pw_gid, extra_groups=(), umask=0o077)
        try:
            wait_for_exit(process.pid, READ_SECONDS)
        except subprocess.TimeoutExpired:
            raise Refused('Repository read timed out. No credential fallback was attempted.') from None
        except OSError:
            raise Refused('Repository worker exit could not be observed. No credential fallback was attempted.') from None
        finally:
            returncode = terminate_and_reap(process)
        if returncode:
            raise Refused(refusal_text(errors, returncode))
        if output.tell() > BUNDLE_LIMIT:
            raise Refused('Repository bundle exceeds the read size limit.')
        output.seek(0)
        return output.read(BUNDLE_LIMIT)
