#!/usr/bin/python3 -I
import argparse
from hashlib import sha1
import json
import os
from pathlib import Path
import re
import stat
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from agent_sources import source_catalog
from signed_commit import Untrusted, commit_object, require_signed
from source_refresh import BRANCH, SAFE_CONFIG, git

SANDBOX = 'agent-sandbox'
TRACKING_REF = f'refs/remotes/origin/{BRANCH}'
SHA1 = re.compile(r'[0-9a-f]{40}')
WRITABLE_BY_OTHERS = stat.S_IWGRP | stat.S_IWOTH
UNSUPPORTED_METADATA = (
    'commondir', 'gitdir', 'worktrees', 'shallow', 'info/grafts', 'objects/info/alternates',
    'objects/info/http-alternates', 'objects/info/commit-graph', 'objects/info/commit-graphs',
    'index.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer',
)
GIT_READ_OPTIONS = (
    '--no-optional-locks', '--no-replace-objects', '-c', 'protocol.allow=never',
    '-c', 'core.attributesFile=/dev/null', '-c', 'core.excludesFile=/dev/null',
    '-c', 'core.filemode=true', '-c', 'core.commitGraph=false',
)


class Blocked(RuntimeError):
    pass


def source_origin(source):
    if source == SANDBOX:
        launch = Path(__file__).resolve().parents[1] / 'session/launch.env'
        return dict(line.split('=', 1) for line in launch.read_text().splitlines() if line)['POTS_SOURCE_URL']
    if source in source_catalog():
        raise Blocked('source-not-enrolled')
    raise Blocked('unknown-source')


def require_protected(path, kind, owners):
    info = path.lstat()
    if not kind(info.st_mode):
        raise Blocked('unsafe-path-type')
    if info.st_uid not in owners or info.st_mode & WRITABLE_BY_OTHERS:
        raise Blocked('unsafe-owner-or-mode')
    return info.st_mode


def require_receiver(root, source):
    if not root.is_absolute() or '..' in root.parts:
        raise Blocked('invalid-receiver-path')
    owner = os.geteuid()
    for parent in reversed(root.parents):
        require_receiver_parent(parent, owner)
    require_protected(root, stat.S_ISDIR, (owner,))
    if os.path.lexists(root / '.git'):
        raise Blocked('receiver-inside-checkout')
    marker = root / 'source'
    if not os.path.lexists(marker):
        raise Blocked('receiver-not-enrolled')
    require_protected(marker, stat.S_ISREG, (owner,))
    with marker.open('rb') as enrollment:
        if enrollment.read(len(source) + 2) != (source + '\n').encode():
            raise Blocked('receiver-not-enrolled')


def require_receiver_parent(path, owner):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise Blocked('unsafe-path-type')
    is_root_sticky = info.st_uid == 0 and info.st_mode & stat.S_ISVTX
    if info.st_uid not in (0, owner) or (info.st_mode & WRITABLE_BY_OTHERS and not is_root_sticky):
        raise Blocked('unsafe-owner-or-mode')
    if os.path.lexists(path / '.git'):
        raise Blocked('receiver-inside-checkout')


def require_owned_tree(root):
    pending = [root]
    while pending:
        path = pending.pop()
        mode = require_protected(path, lambda mode: stat.S_ISREG(mode) or stat.S_ISDIR(mode), (os.geteuid(),))
        if stat.S_ISDIR(mode):
            pending.extend(path.iterdir())


def read_git(directory, *arguments, failure='git-read-failed'):
    try:
        return git(directory, *GIT_READ_OPTIONS, *arguments)
    except RuntimeError:
        raise Blocked(failure) from None


def require_repository(directory, metadata, origin):
    require_protected(directory, stat.S_ISDIR, (os.geteuid(),))
    is_bare = directory == metadata
    if not stat.S_ISDIR(metadata.lstat().st_mode) or (is_bare and os.path.lexists(directory / '.git')):
        raise Blocked('invalid-git-layout')
    require_owned_tree(directory)
    if any(os.path.lexists(metadata / name) for name in UNSUPPORTED_METADATA):
        raise Blocked('unsupported-git-metadata')
    keys = read_git(directory, 'config', '--local', '--no-includes', '--null', '--name-only', '--list')
    if any(not SAFE_CONFIG.fullmatch(key) for key in keys.split('\0') if key):
        raise Blocked('unsafe-git-config')
    if read_git(directory, 'rev-parse', '--absolute-git-dir') != str(metadata):
        raise Blocked('invalid-git-layout')
    if read_git(directory, 'rev-parse', '--is-bare-repository') != str(is_bare).lower():
        raise Blocked('invalid-git-layout')
    urls = read_git(directory, 'config', '--local', '--null', '--get-regexp', r'^remote\.origin\.url$', failure='wrong-origin')
    if urls != f'remote.origin.url\n{origin}\0':
        raise Blocked('wrong-origin')


def checkout_revision(checkout, origin):
    require_repository(checkout, checkout / '.git', origin)
    branch = read_git(checkout, 'symbolic-ref', '--quiet', 'HEAD', failure='wrong-checkout-branch')
    if branch != f'refs/heads/{BRANCH}':
        raise Blocked('wrong-checkout-branch')
    entries = read_git(checkout, 'ls-files', '-v', '--stage', '-z').split('\0')
    if any(entry and not entry.startswith(('H 100644 ', 'H 100755 ')) for entry in entries):
        raise Blocked('masked-checkout')
    if read_git(checkout, 'status', '--porcelain', '--untracked-files=all', '--ignored'):
        raise Blocked('dirty-checkout')
    revision = read_git(checkout, 'rev-parse', '--verify', 'HEAD')
    require_exact_commit(checkout, revision, 'installed-not-commit')
    return revision


def require_exact_commit(directory, revision, failure):
    if not SHA1.fullmatch(revision) or read_git(directory, 'cat-file', '-t', revision, failure=failure) != 'commit':
        raise Blocked(failure)
    commit = commit_object(directory, revision, GIT_READ_OPTIONS)
    if sha1(f'commit {len(commit)}\0'.encode() + commit, usedforsecurity=False).hexdigest() != revision:
        raise Blocked(failure)


def verify_signature(directory, revision, signers, failure):
    try:
        return require_signed(directory, revision, signers, GIT_READ_OPTIONS)
    except (Untrusted, OSError, UnicodeError):
        raise Blocked(failure) from None


def staged_candidate(root, origin, installed, desired):
    stage = root / 'candidate.git'
    require_repository(stage, stage, origin)
    observed = read_git(stage, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)', TRACKING_REF,
                        failure='candidate-ref-mismatch')
    if observed != f'{TRACKING_REF} {desired}':
        raise Blocked('candidate-ref-mismatch')
    require_exact_commit(stage, desired, 'candidate-not-commit')
    require_exact_commit(stage, installed, 'installed-base-unavailable')
    read_git(stage, 'merge-base', '--is-ancestor', installed, desired, failure='candidate-not-fast-forward')
    return stage


def verify_candidate(root, origin, installed, desired):
    signers = root / 'trusted-signers.asc'
    verify_signature(root / 'checkout', installed, signers, 'installed-signature-unverified')
    stage = staged_candidate(root, origin, installed, desired)
    return {'revision': desired, 'signer': verify_signature(stage, desired, signers, 'candidate-signature-unverified')}


def preflight(root, source, revision, verify=verify_candidate):
    desired = revision if SHA1.fullmatch(revision) else None
    receipt = {
        'source': source if source == SANDBOX or source in source_catalog() else None,
        'origin': None, 'ref': TRACKING_REF, 'desired': desired, 'checkout': None, 'verified': None,
        'provisioned': None, 'executables': None, 'process_starts': None, 'active': None,
        'applied_rules': None, 'known_good': None, 'blocked': None,
    }
    try:
        origin = source_origin(source)
        receipt['origin'] = origin
        if desired is None:
            raise Blocked('invalid-candidate')
        require_receiver(root, source)
        installed = checkout_revision(root / 'checkout', origin)
        receipt['checkout'] = installed
        receipt['verified'] = verify(root, origin, installed, desired)
    except Blocked as problem:
        receipt['blocked'] = str(problem)
    except (OSError, Untrusted, UnicodeError):
        receipt['blocked'] = 'unreadable-receiver-state'
    return receipt


def restrict_environment():
    os.environ.clear()
    os.environ.update(PATH=os.defpath, LC_ALL='C')


def main():
    parser = argparse.ArgumentParser(description='Read an enrolled managed checkout and an already staged candidate. Emit one JSON preflight receipt.')
    parser.add_argument('receiver', type=Path, help='absolute path of the protected enrolled receiver')
    parser.add_argument('source', help='source catalog ID')
    parser.add_argument('revision', help='full staged commit SHA-1')
    parser.add_argument('--factory', action='store_true', help='verify a signed Factory landing with scoped trust')
    arguments = parser.parse_args()
    restrict_environment()
    verifier = verify_candidate
    if arguments.factory:
        from factory_candidate import verify_publication
        verifier = verify_publication
    receipt = preflight(arguments.receiver, arguments.source, arguments.revision, verifier)
    print(json.dumps(receipt))
    return int(receipt['blocked'] is not None)


if __name__ == '__main__':
    sys.modules['managed_update'] = sys.modules[__name__]
    sys.exit(main())
