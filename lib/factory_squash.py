import json
import os
import stat

from factory_candidate import LANDING_REF, PROVENANCE_HEADER, REQUEST_FIELDS, require_review_request, require_reviewed_tree
from managed_update import GIT_READ_OPTIONS, Blocked, read_git, require_exact_commit, require_protected, verify_signature
from signed_commit import Untrusted
from signed_tag import require_signed_tag

SQUASH_TAG_ROOT = 'refs/tags/factory-release/'
EVIDENCE_ROOT = 'refs/factory/release/'
EVIDENCE_FORMAT = b'Factory squash evidence v1'
SQUASH_FIELDS = REQUEST_FIELDS | {'squash'}


def repository_name(origin):
    return origin.removeprefix('https://github.com/').removesuffix('.git')


def is_landing(stage, revision):
    return read_git(stage, 'show', '-s', '--format=%s', revision).encode() == PROVENANCE_HEADER


def evidence_id(directory, squash, failure):
    return read_git(directory, 'rev-parse', '--verify', EVIDENCE_ROOT + squash, failure=failure)


def signed_squash(root, origin, directory, tag_id, squash):
    signers = root / 'factory-signers.asc'
    require_protected(signers, stat.S_ISREG, (os.geteuid(),))
    try:
        signer, payload = require_signed_tag(directory, tag_id, signers, GIT_READ_OPTIONS)
    except (Untrusted, OSError, UnicodeError):
        raise Blocked('factory-signature-unverified') from None
    header, _, message = payload.partition(b'\n\n')
    subject, separator, body = message.partition(b'\n\n')
    if header.splitlines()[:3] != [f'object {squash}'.encode(), b'type commit', f'tag factory-release/{squash}'.encode()]:
        raise Blocked('factory-squash-mismatch')
    if subject != EVIDENCE_FORMAT or not separator:
        raise Blocked('factory-squash-mismatch')
    return signer, squash_request(body, squash, repository_name(origin))


def squash_request(body, squash, repository):
    try:
        binding = json.loads(body)
    except (ValueError, RecursionError):
        raise Blocked('invalid-factory-request') from None
    if not isinstance(binding, dict) or binding.keys() != SQUASH_FIELDS:
        raise Blocked('invalid-factory-request')
    if json.dumps(binding, sort_keys=True, separators=(',', ':')).encode() + b'\n' != body:
        raise Blocked('invalid-factory-request')
    if binding.pop('squash') != squash:
        raise Blocked('factory-squash-mismatch')
    require_review_request(binding, repository)
    return binding


def verify_squash(root, origin, stage, installed, squash, fetch_evidence, fetch_review):
    require_exact_commit(stage, squash, 'candidate-not-commit')
    tag_id = fetch_evidence(squash)
    signer, request = signed_squash(root, origin, stage, tag_id, squash)
    if request['base'] != installed or read_git(stage, 'show', '-s', '--format=%P', squash) != installed:
        raise Blocked('factory-base-mismatch')
    fetch_review(squash, request['head'])
    require_reviewed_tree(stage, squash, request)
    return {'revision': squash, 'signer': signer, 'ref': LANDING_REF, 'tree': request['tree'],
            'review': request, 'evidence': tag_id}


def verify_factory_release(root, origin, checkout, revision):
    evidence = read_git(checkout, 'for-each-ref', '--format=%(objectname)', EVIDENCE_ROOT + revision)
    if not evidence:
        return verify_signature(checkout, revision, root / 'factory-signers.asc', 'release-signature-unverified')
    try:
        signer, request = signed_squash(root, origin, checkout, evidence, revision)
    except Blocked:
        raise Blocked('release-signature-unverified') from None
    if read_git(checkout, 'rev-parse', f'{revision}^{{tree}}') != request['tree']:
        raise Blocked('release-tree-mismatch')
    return signer
