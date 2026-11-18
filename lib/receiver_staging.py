import os
from pathlib import Path
import stat
import tempfile

from factory_candidate import LANDING_REF, signed_landing, verify_publication
from managed_update import TRACKING_REF, Blocked, read_git, require_exact_commit, require_protected, require_repository
from source_refresh import BRANCH, git


def staging_git(directory, *arguments, failure):
    try:
        return git(directory, '--no-replace-objects', *arguments)
    except RuntimeError:
        raise Blocked(failure) from None


def fetch_ref(stage, endpoint, protocol, ref, destination, failure):
    staging_git(stage, '-c', 'protocol.allow=never', '-c', f'protocol.{protocol}.allow=always',
                '-c', 'http.followRedirects=false', '-c', 'fetch.fsckObjects=true',
                'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
                '--', endpoint, f'+{ref}:{destination}', failure=failure)


def fetch_tip(root, origin, endpoint, protocol):
    stage = root / 'candidate.git'
    require_repository(stage, stage, origin)
    fetch_ref(stage, endpoint, protocol, LANDING_REF, TRACKING_REF, 'candidate-fetch-failed')
    return read_git(stage, 'rev-parse', '--verify', TRACKING_REF)


def fetch_review(root, origin, candidate, endpoint, protocol):
    stage = root / 'candidate.git'
    require_exact_commit(stage, candidate, 'candidate-not-commit')
    _, request = signed_landing(root, origin, stage, candidate)
    try:
        require_exact_commit(stage, request['head'], 'factory-review-object-missing')
    except Blocked:
        fetch_ref(stage, endpoint, protocol, f"refs/pull/{request['number']}/head", 'refs/factory/review',
                  'factory-review-fetch-failed')


def materialize(root, origin, verified):
    releases = root / 'releases'
    require_protected(releases, stat.S_ISDIR, (os.geteuid(),))
    revision = verified['revision']
    target = releases / revision
    if os.path.lexists(target):
        return
    with tempfile.TemporaryDirectory(dir=releases, prefix='.staging-') as temporary:
        checkout = Path(temporary) / 'checkout'
        staging_git(releases, 'init', '--quiet', '--template=', '--initial-branch', BRANCH, str(checkout), failure='release-init-failed')
        staging_git(checkout, 'remote', 'add', 'origin', origin, failure='release-origin-failed')
        fetch_ref(checkout, str(root / 'candidate.git'), 'file', TRACKING_REF, TRACKING_REF, 'release-fetch-failed')
        staging_git(checkout, 'checkout', '--quiet', '-B', BRANCH, revision, failure='release-checkout-failed')
        checkout.replace(target)


def stage_candidate(root, origin, installed, candidate, endpoint, protocol):
    if candidate == installed:
        return
    fetch_review(root, origin, candidate, endpoint, protocol)
    verified = verify_publication(root, origin, installed, candidate)
    materialize(root, origin, verified)
