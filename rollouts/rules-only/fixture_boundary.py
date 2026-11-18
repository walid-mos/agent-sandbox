import json
import os
from pathlib import Path
import sys
import tempfile

from guards import AREA, private_directory, require
from git_boundary import prove_fixture_git

FORBIDDEN_GIT = {'push', 'fetch', 'pull', 'ls-remote', 'send-email', 'clone', '-S', '--gpg-sign'}


def install_boundary(root, commands):
    require(root.parent == Path(tempfile.gettempdir()).resolve(), 'fixtures must live directly in OS temporary storage')
    private_directory(root)
    commands.fixture_home = root
    audit_path = root / 'fixture-audit.jsonl'

    def audit(event, arguments):
        if event.startswith('socket.') or event in ('os.system', 'os.posix_spawn', 'os.exec'):
            raise RuntimeError('fixture network or alternate execution denied')
        if event != 'subprocess.Popen':
            return
        executable, argv, _, _ = arguments
        is_git = executable == 'git' and not FORBIDDEN_GIT.intersection(argv)
        is_store = (executable == sys.executable and argv[1:] ==
                    ['-I', str(AREA / 'fixture_store.py'), str(root)])
        require(is_git or is_store, 'fixture attempted an unapproved executable')
        if is_git:
            prove_fixture_git(list(argv), root)
        with audit_path.open('a') as output:
            output.write(json.dumps({'executable': 'git' if is_git else 'pinned-store-config',
                                     'networkAllowed': False}) + '\n')

    sys.addaudithook(audit)
