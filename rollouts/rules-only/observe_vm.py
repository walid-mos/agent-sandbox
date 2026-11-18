import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

MAX_BYTES = 4 * 1024 * 1024
NAMES = ('sandbox.json', 'vault.json', 'git-identity.json', 'tailnet.json')


def hash_file(path):
    path = Path(path)
    info = path.lstat()
    if path.resolve() != path or not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
        raise ValueError('unsupported VM file')
    return {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'mode': stat.S_IMODE(info.st_mode)}


def prove_sources(root, hashes):
    for relative, expected in hashes.items():
        if hash_file(root / relative)['sha256'] != expected:
            raise ValueError('incompatible VM implementation')


def prove_launcher(request):
    root = Path('/usr/local/lib/agent-sandbox')
    names = ('lib/trusted_source.py', 'lib/source_refresh.py', 'lib/signed_commit.py', 'session/launch.env')
    prove_sources(root, {name: request['files'][name] for name in names})
    for name in names:
        require_root_owned(root / name)
    result = subprocess.run(['/usr/bin/python3', '-I', str(root / 'lib/trusted_source.py'), 'verify'],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15,
                            env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1'})
    if result.returncode or not result.stdout.strip():
        raise ValueError('trusted VM signature proof failed')
    revision = subprocess.run(['git', '-c', 'safe.directory=/opt/agent-sandbox',
                               '-c', 'core.fsmonitor=false', '-C', request['checkout'], 'rev-parse', 'HEAD'],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5,
                              env={'PATH': '/usr/bin:/bin', 'GIT_CONFIG_NOSYSTEM': '1',
                                   'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_OPTIONAL_LOCKS': '0'})
    if revision.returncode or revision.stdout.decode().strip() != request['revision']:
        raise ValueError('trusted VM revision differs')


def require_root_owned(path):
    for entry in (path, *path.parents):
        info = entry.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('VM ownership differs')


def observe(request):
    root = Path(request['checkout'])
    prove_sources(root, request['files'])
    if request['isProduction']:
        prove_launcher(request)
    directory = Path(request['installed'])
    if directory.resolve() != directory or stat.S_IMODE(directory.stat().st_mode) != 0o755:
        raise ValueError('VM configuration directory differs')
    files = {name: hash_file(directory / name) for name in NAMES if (directory / name).exists()
             or (directory / name).is_symlink()}
    rules = hash_file(request['rulesTarget'])
    if request['isProduction']:
        require_root_owned(directory)
        require_root_owned(Path(request['rulesTarget']))
        for name in files:
            require_root_owned(directory / name)
    loaded = Path(request['loaded'])
    return {'files': files, 'rules': rules, 'loadedTarget': str(loaded.resolve()),
            'loadedSha256': hashlib.sha256(loaded.read_bytes()).hexdigest()}


def main():
    try:
        request = json.loads(sys.argv[1])
        print(json.dumps(observe(request)))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print('VM read-only proof refused', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
