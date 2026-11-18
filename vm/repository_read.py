import base64
import json
import os
import pwd
import signal
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
from repository_git import BUNDLE_LIMIT, environment
from repository_process import READ_SECONDS, WorkerWindow
from vault_policy import GITHUB_PATH, Refused, read_grant

FETCH_ACCOUNT = 'pots-repository-read'
READ_LOCK = threading.Lock()
WORKER = Path(__file__).resolve().parents[1] / 'lib/repository_bundle.py'


def bundle_for(request, sandbox, read_secret):
    name = read_grant(request, sandbox)
    if not READ_LOCK.acquire(blocking=False):
        raise Refused('Another repository read is running. Retry after it finishes.')
    try:
        token = read_secret(GITHUB_PATH, name)
        if not token or any(character in token for character in '\r\n\0'):
            raise Refused('The configured repository credential is empty or multiline. Ask the operator to replace it.')
        try:
            bundle = fetch(request, token)
        except Refused as error:
            raise Refused(f"{error} Repository {request['repository']}, credential {name}.") from None
        return {'ok': True, 'bundle': base64.b64encode(bundle).decode('ascii')}
    finally:
        READ_LOCK.release()


def fetch(request, token):
    try:
        account = pwd.getpwnam(FETCH_ACCOUNT)
    except KeyError:
        raise Refused('The VM fetch account is missing. Ask the operator to run bin/vm-up.') from None
    if account.pw_uid == 0:
        raise Refused('The VM fetch account must not be root.')
    with tempfile.TemporaryDirectory(prefix='repository-read-', dir='/tmp') as directory:
        os.chown(directory, account.pw_uid, account.pw_gid)
        return run_worker(directory, account, request, token)


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
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(['/usr/bin/python3', '-I', str(WORKER)], cwd=directory, env=environment(directory),
                                   stdin=subprocess.PIPE, stdout=output, stderr=errors, start_new_session=True,
                                   user=account.pw_uid, group=account.pw_gid, extra_groups=(), umask=0o077)
        window = WorkerWindow(process, account.pw_uid, process.pid)
        try:
            process.communicate(payload, timeout=READ_SECONDS)
            message = None
        except subprocess.TimeoutExpired:
            message = 'Repository read timed out. No credential fallback was attempted.'
        finally:
            survivors = window.terminate()
            window.release()
            if survivors:
                raise Refused('Repository read descendants survived termination. Ask the operator to inspect the VM.')
        message = message if message is not None else (refusal_text(errors, process.returncode) if process.returncode else None)
        if message:
            raise Refused(message)
        if output.tell() > BUNDLE_LIMIT:
            raise Refused('Repository bundle exceeds the read size limit.')
        output.seek(0)
        return output.read(BUNDLE_LIMIT)
