import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import time

AREA = Path(__file__).resolve().parent
COMMAND_SECONDS = 20
MAX_PREFLIGHT_SECONDS = 300
MAX_BYTES = 4 * 1024 * 1024
PRIVATE_MODE = 0o600
SCOPE = 'accor-rules-only-local-commit-no-push'
PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'


class Refused(RuntimeError):
    pass


def require(condition, reason):
    if not condition:
        raise Refused(reason)


def digest(content):
    return hashlib.sha256(content).hexdigest()


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'ambiguous JSON')
        result[key] = value
    return result


def read_json(path):
    return json.loads(regular(path).read_bytes(), object_pairs_hook=unique)


def regular(path):
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path, 'symlink or relative file refused')
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= MAX_BYTES, 'unsupported file')
    return path


def private_file(path):
    path = regular(path)
    info = path.stat()
    require(info.st_uid == os.getuid() and not info.st_mode & 0o077, 'owner-private file required')
    return path


def private_directory(path):
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path, 'symlink or relative directory refused')
    info = path.stat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and not info.st_mode & 0o077, 'owned mode-0700 directory required')
    return path


def environment():
    return {'PATH': PATH, 'HOME': str(Path.home()), 'LANG': 'C.UTF-8',
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
            'GIT_TERMINAL_PROMPT': '0', 'GIT_OPTIONAL_LOCKS': '0',
            'GIT_ATTR_NOSYSTEM': '1', 'PYTHONDONTWRITEBYTECODE': '1'}


class Commands:
    def __init__(self, seconds):
        self.seconds = seconds
        self.deadline = time.monotonic() + seconds
        self.fixture_home = None

    def run(self, arguments, *, input_bytes=b'', mutation=False, extra=None):
        timeout = None if mutation else min(COMMAND_SECONDS, self.deadline - time.monotonic())
        require(mutation or timeout > 0, 'aggregate preflight deadline reached')
        process = subprocess.Popen(list(map(str, arguments)), stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env={**environment(), **({'HOME': str(self.fixture_home)} if self.fixture_home else {}),
                                        **(extra or {})}, start_new_session=True)
        try:
            output, _ = process.communicate(input_bytes, timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            raise Refused('read-only command deadline reached') from None
        if mutation:
            self.deadline = time.monotonic() + self.seconds
        require(process.returncode == 0 and len(output) <= MAX_BYTES,
                'command failed, command output withheld')
        return output

    def git(self, checkout, *arguments, mutation=False):
        return self.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                         '-c', 'submodule.recurse=false', '-c', 'maintenance.auto=false',
                         '-c', 'gc.auto=0', '-c', 'core.attributesFile=/dev/null',
                         '-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync',
                         '-c', 'commit.gpgsign=false', '-C', checkout, *arguments],
                        mutation=mutation).decode().strip()


def artifact():
    paths = sorted([*AREA.glob('*.py'), AREA / 'resources.json'])
    hashes = {path.name: digest(path.read_bytes()) for path in paths}
    return {'artifactSha256': digest(encode(hashes)), 'files': hashes}


def scope_hash(contract):
    return digest(encode({key: value for key, value in contract.items() if key != 'ownerProofSha256'}))


def validate_contract(options):
    contract_path = private_file(options.contract)
    require(digest(contract_path.read_bytes()) == options.contract_sha256, 'contract hash differs')
    contract = read_json(contract_path)
    fields = ('runId review ownerRoute notBefore expires preflightSeconds scope artifactSha256 checkout '
              'runtime privateCheckout privateHead original journal installed loaded sourceHead ownerProofSha256')
    require(set(contract) == set(fields.split()), 'contract fields differ')
    require(contract['scope'] == SCOPE and contract['artifactSha256'] == artifact()['artifactSha256'],
            'scope or runner resources differ')
    require(all(isinstance(contract[key], str) and contract[key] for key in ('runId', 'review', 'ownerRoute')),
            'concrete review and owner route required')
    require(type(contract['preflightSeconds']) is int and 0 < contract['preflightSeconds'] <= MAX_PREFLIGHT_SECONDS,
            'bounded aggregate preflight required')
    check_window(contract, options.owner_proof)
    return contract


def check_window(contract, proof_path):
    now = time.time()
    require(type(contract['notBefore']) is int and type(contract['expires']) is int
            and contract['notBefore'] <= now < contract['expires'], 'reviewed window is closed')
    proof_path = private_file(proof_path)
    require(digest(proof_path.read_bytes()) == contract['ownerProofSha256'], 'owner proof hash differs')
    proof = read_json(proof_path)
    require(set(proof) == {'runId', 'review', 'ownerRoute', 'isHeld', 'notBefore', 'expires', 'scopeSha256'},
            'owner proof fields differ')
    require(all(proof[key] == contract[key] for key in ('runId', 'review', 'ownerRoute'))
            and proof['isHeld'] is True and proof['scopeSha256'] == scope_hash(contract),
            'owner hold does not cover this concrete scope')
    require(type(proof['notBefore']) is int and type(proof['expires']) is int
            and proof['notBefore'] <= now < min(proof['expires'], contract['expires']),
            'owner hold expired')
