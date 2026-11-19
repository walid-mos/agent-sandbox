from functools import partial
import os
from pathlib import Path
import stat
import tempfile

from factory_candidate import LANDING_REF, REVIEW_TAG_ROOT, verify_checkpoint
from factory_squash import EVIDENCE_ROOT, SQUASH_TAG_ROOT, evidence_id, is_landing, verify_squash
from managed_update import TRACKING_REF, Blocked, read_git, require_protected, require_repository, staged_candidate
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


def fetch_review(stage, endpoint, protocol, candidate, head):
    destination = 'refs/factory/review'
    fetch_ref(stage, endpoint, protocol, REVIEW_TAG_ROOT + candidate, destination, 'factory-review-fetch-failed')
    direct = read_git(stage, 'rev-parse', '--verify', destination, failure='factory-review-ref-mismatch')
    if direct != head:
        raise Blocked('factory-review-ref-mismatch')


def fetch_evidence(stage, endpoint, protocol, squash):
    fetch_ref(stage, endpoint, protocol, SQUASH_TAG_ROOT + squash, EVIDENCE_ROOT + squash, 'factory-evidence-fetch-failed')
    return evidence_id(stage, squash, 'factory-evidence-fetch-failed')


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
        if 'evidence' in verified:
            keep_evidence(checkout, root / 'candidate.git', revision, verified['evidence'])
        checkout.replace(target)


def keep_evidence(checkout, stage, revision, tag_id):
    destination = EVIDENCE_ROOT + revision
    fetch_ref(checkout, str(stage), 'file', destination, destination, 'release-fetch-failed')
    if evidence_id(checkout, revision, 'release-fetch-failed') != tag_id:
        raise Blocked('release-fetch-failed')


def verify_series(root, origin, installed, tip, endpoint, protocol):
    stage = staged_candidate(root, origin, installed, tip)
    revisions = read_git(stage, 'rev-list', '--first-parent', '--reverse', f'{installed}..{tip}').splitlines()
    fetch = partial(fetch_review, stage, endpoint, protocol)
    fetch_squash_evidence = partial(fetch_evidence, stage, endpoint, protocol)
    checkpoints = []
    for revision in revisions:
        if is_landing(stage, revision):
            checkpoints.append(verify_checkpoint(root, origin, stage, installed, revision, fetch))
        else:
            checkpoints.append(verify_squash(root, origin, stage, installed, revision, fetch_squash_evidence, fetch))
        installed = revision
    return checkpoints
