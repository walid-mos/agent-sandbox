import os
from pathlib import Path
import subprocess

from source_refresh import GIT_OPTIONS

GIT = '/usr/bin/git'
GIT_EXEC_PATH = '/usr/lib/git-core'
GIT_SECONDS = 60
BUNDLE_LIMIT = 64 * 1024 * 1024
ISOLATED_OPTIONS = [*GIT_OPTIONS, '-c', 'init.templateDir=', '-c', 'protocol.allow=never',
                    '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false',
                    '-c', 'credential.helper=', '-c', 'credential.useHttpPath=true',
                    '-c', 'http.proxy=', '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true']


class GitFailure(Exception):
    pass


def environment(home):
    return {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'LANG': 'C', 'LC_ALL': 'C',
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_TERMINAL_PROMPT': '0',
            'GIT_EXEC_PATH': GIT_EXEC_PATH, 'GIT_ATTR_NOSYSTEM': '1', 'GIT_NO_REPLACE_OBJECTS': '1'}


def git(directory, *arguments, credential=None, pass_fds=()):
    options = list(ISOLATED_OPTIONS)
    settings = environment(directory)
    if credential is not None:
        repository, token = credential
        helper = Path(__file__).resolve().parents[1] / 'vm/read_credential.py'
        options += ['-c', f'credential.helper=!/usr/bin/python3 -I {helper}']
        settings.update(REPOSITORY_READ_KEY=repository, REPOSITORY_READ_TOKEN=token)
    try:
        result = subprocess.run([GIT, *options, '-C', str(directory), *arguments], env=settings,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=GIT_SECONDS, pass_fds=pass_fds)
    except (OSError, subprocess.TimeoutExpired):
        raise GitFailure('Git read failed or timed out.') from None
    if result.returncode:
        refusal = any(marker in result.stderr for marker in (b'Authentication failed', b'could not read Username', b'error: 401', b'error: 403', b'not found'))
        raise GitFailure('GitHub refused this token for this repository. Ask the operator to replace its configured credential.' if refusal else 'Git read failed. No credential fallback was attempted.')
    return result.stdout
