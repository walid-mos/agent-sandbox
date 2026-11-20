import base64
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import tempfile

from repository_git import BUNDLE_LIMIT, GitFailure, git
from vault_policy import Refused, read_request

REPLY_LIMIT = BUNDLE_LIMIT * 4 // 3 + 4096
BROKER_SECONDS = 120
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


@contextmanager
def owned_destination(destination):
    if '..' in Path(destination).parts:
        raise Refused('Destination must not contain parent traversal.')
    path = Path(os.path.abspath(destination))
    parent = os.open('/', DIRECTORY_FLAGS)
    created = False
    try:
        for component in path.parent.parts[1:]:
            following = os.open(component, DIRECTORY_FLAGS, dir_fd=parent)
            os.close(parent)
            parent = following
        details = os.fstat(parent)
        if details.st_uid != os.geteuid() or details.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise Refused('Destination parent must be owned by the caller and writable only by its owner.')
        os.mkdir(path.name, mode=0o700, dir_fd=parent)
        created = True
        descriptor = os.open(path.name, DIRECTORY_FLAGS, dir_fd=parent)
        identity = os.fstat(descriptor)
        with close_descriptor(descriptor):
            yield descriptor
    except (OSError, Refused, GitFailure, ValueError):
        if created and 'identity' in locals():
            current = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
            if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                shutil.rmtree(path.name, dir_fd=parent)
        raise
    finally:
        os.close(parent)


@contextmanager
def close_descriptor(descriptor):
    try:
        yield descriptor
    finally:
        os.close(descriptor)


def ask_bundle(endpoint, request):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(BROKER_SECONDS)
        connection.connect(str(endpoint))
        connection.sendall((json.dumps(request) + '\n').encode())
        connection.shutdown(socket.SHUT_WR)
        with connection.makefile('rb') as response:
            encoded = response.read(REPLY_LIMIT + 1)
    if len(encoded) > REPLY_LIMIT:
        raise Refused('Broker reply exceeds the bundle limit.')
    try:
        reply = json.loads(encoded)
    except ValueError:
        raise Refused('Broker returned unreadable JSON.') from None
    if not isinstance(reply, dict) or reply.get('ok') is not True:
        raise Refused(reply.get('error', 'Broker refused repository read.') if isinstance(reply, dict) else 'Broker refused repository read.')
    if set(reply) != {'ok', 'bundle'} or not isinstance(reply['bundle'], str):
        raise Refused('Broker read reply must hold only a bundle, never secrets.')
    try:
        return base64.b64decode(reply['bundle'], validate=True)
    except ValueError:
        raise Refused('Broker returned an invalid bundle encoding.') from None


def import_repository(request, destination, endpoint):
    read_request(request)
    with owned_destination(destination) as descriptor:
        bundle = ask_bundle(endpoint, request)
        with tempfile.TemporaryDirectory(prefix='repository-import-', dir='/tmp') as directory:
            bundle_path = Path(directory) / 'objects.bundle'
            bundle_path.write_bytes(bundle)
            checkout = f'/proc/self/fd/{descriptor}'
            options = {'pass_fds': (descriptor,)}
            git(checkout, 'init', '--bare', '--quiet', '--initial-branch=main', **options)
            git(checkout, '-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--no-recurse-submodules',
                '--', str(bundle_path), '+refs/*:refs/*', **options)
            return [(commit, git(checkout, 'cat-file', '-t', commit, **options).decode().strip()) for commit in request['commits']]
