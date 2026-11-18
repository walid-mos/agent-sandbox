import json
import os
from pathlib import Path
import stat
import sys
import tempfile

from guards import AREA, private_directory, require
from git_boundary import prove_fixture_git

FORBIDDEN_GIT = {'push', 'fetch', 'pull', 'ls-remote', 'send-email', 'clone', '-S', '--gpg-sign'}


def install_boundary(root, commands):
    require(root.parent == Path(tempfile.gettempdir()).resolve(), 'fixtures must live directly in OS temporary storage')
    private_directory(root)
    commands.fixture_home = root
    def audit(event, arguments):
        if event.startswith('socket.') or event in ('os.system', 'os.posix_spawn', 'os.exec'):
            raise RuntimeError('fixture network or alternate execution denied')
        if event != 'subprocess.Popen':
            return
        executable, argv, _, _ = arguments
        validate_launch(root, list(argv), executable)

    sys.addaudithook(audit)


def validate_launch(root, arguments, executable):
    is_git = executable == 'git' and not FORBIDDEN_GIT.intersection(arguments)
    is_store = (executable == sys.executable and arguments[1:] ==
                ['-I', str(AREA / 'fixture_store.py'), str(root)])
    is_supervisor = executable == sys.executable and arguments[1:3] == ['-I', str(AREA / 'mutation_worker.py')]
    require(is_git or is_store or is_supervisor, 'fixture attempted an unapproved executable')
    if is_git:
        prove_fixture_git(arguments, root)
    if is_supervisor:
        require(len(arguments) == 4, 'fixture supervisor arguments differ')
        directory = Path(arguments[3])
        require(directory.is_relative_to(root) and directory.parent.name == 'mutations',
                'fixture supervisor escaped ownership root')
        private_directory(directory)
    kind = 'git' if is_git else ('pinned-store-config' if is_store else 'mutation-supervisor')
    descriptor = os.open(root / 'fixture-audit.jsonl',
                         os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(descriptor, 'a') as output:
        info = os.fstat(output.fileno())
        require(info.st_uid == os.getuid() and info.st_nlink == 1 and stat.S_ISREG(info.st_mode),
                'fixture audit file is not exclusively owned')
        output.write(json.dumps({'executable': kind, 'networkAllowed': False}) + '\n')
