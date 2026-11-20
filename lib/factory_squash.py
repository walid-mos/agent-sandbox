import json
import os
import stat

from factory_candidate import (LANDING_REF, PROVENANCE_HEADER, REQUEST_FIELDS, SIGNATURE_UNVERIFIED,
                               repository_name, require_landing_parents, require_review_request, require_reviewed_head)
from managed_update import GIT_READ_OPTIONS, SHA1, Blocked, read_git, require_exact_commit, require_protected, verify_signature
from signed_commit import Untrusted
from signed_tag import require_signed_tag

SQUASH_TAG_ROOT = 'refs/tags/factory-release/'
EVIDENCE_ROOT = 'refs/factory/release/'
EVIDENCE_FORMAT = b'Factory squash evidence v1'
RECOVERY_FORMAT = b'Factory squash recovery v1'
SQUASH_FIELDS = REQUEST_FIELDS | {'squash'}
LANDED_FIELDS = {'head', 'base', 'tree', 'generation'}
REVIEW_ROOT = 'refs/factory/review/'
FACTORY_SIGNERS = 'factory-signers.asc'


def is_landing(stage, revision):
    return read_git(stage, 'show', '-s', '--format=%s', revision).encode() == PROVENANCE_HEADER


def evidence_id(directory, squash, failure):
    return read_git(directory, 'rev-parse', '--verify', EVIDENCE_ROOT + squash, failure=failure)


def signed_squash(root, origin, directory, tag_id, squash):
    signers = root / FACTORY_SIGNERS
    require_protected(signers, stat.S_ISREG, (os.geteuid(),))
    try:
        signer, payload = require_signed_tag(directory, tag_id, signers, GIT_READ_OPTIONS)
    except (Untrusted, OSError, UnicodeError):
        raise Blocked(SIGNATURE_UNVERIFIED) from None
    header, _, message = payload.partition(b'\n\n')
    subject, separator, body = message.partition(b'\n\n')
    if header.splitlines()[:3] != [f'object {squash}'.encode(), b'type commit', f'tag factory-release/{squash}'.encode()]:
        raise Blocked('factory-squash-mismatch')
    if subject not in EVIDENCE_PARSERS or not separator:
        raise Blocked('factory-squash-mismatch')
    try:
        binding = json.loads(body)
    except (ValueError, RecursionError):
        raise Blocked('invalid-factory-request') from None
    checkpoint = EVIDENCE_PARSERS[subject](binding, squash, repository_name(origin))
    if json.dumps(binding, sort_keys=True, separators=(',', ':')).encode() + b'\n' != body:
        raise Blocked('invalid-factory-request')
    return {'revision': squash, 'signer': signer, 'ref': LANDING_REF, 'evidence': tag_id, **checkpoint}


def squash_request(binding, squash, repository):
    if not isinstance(binding, dict) or binding.keys() != SQUASH_FIELDS:
        raise Blocked('invalid-factory-request')
    if binding['squash'] != squash:
        raise Blocked('factory-squash-mismatch')
    request = {key: binding[key] for key in REQUEST_FIELDS}
    require_review_request(request, repository)
    return {'review': request, 'tree': request['tree']}


def recovery_request(binding, squash, repository):
    if not isinstance(binding, dict) or binding.keys() != {'original', 'landed'}:
        raise Blocked('invalid-factory-request')
    original, landed = binding['original'], binding['landed']
    require_review_request(original, repository)
    if not isinstance(landed, dict) or landed.keys() != LANDED_FIELDS:
        raise Blocked('invalid-factory-request')
    if any(not isinstance(landed[key], str) or not SHA1.fullmatch(landed[key]) for key in ('base', 'head', 'tree')):
        raise Blocked('invalid-factory-request')
    if (landed['head'] != squash or original['head'] == squash or type(landed['generation']) is not int
            or landed['generation'] != original['generation']):
        raise Blocked('factory-squash-mismatch')
    return {'review': original, 'landed': landed, 'tree': landed['tree']}


EVIDENCE_PARSERS = {EVIDENCE_FORMAT: squash_request, RECOVERY_FORMAT: recovery_request}


def require_squash_objects(directory, checkpoint, installed):
    squash = checkpoint['revision']
    base = checkpoint.get('landed', checkpoint['review'])['base']
    if base != installed:
        raise Blocked('factory-base-mismatch')
    require_landing_parents(directory, squash, base)
    head = read_git(directory, 'rev-parse', '--verify', REVIEW_ROOT + squash, failure='factory-review-ref-mismatch')
    if head != checkpoint['review']['head']:
        raise Blocked('factory-review-ref-mismatch')
    require_reviewed_head(directory, checkpoint['review'])
    if read_git(directory, 'rev-parse', f'{squash}^{{tree}}') != checkpoint['tree']:
        raise Blocked('factory-tree-mismatch')


def verify_squash(root, origin, stage, installed, squash, fetch_evidence, fetch_review):
    require_exact_commit(stage, squash, 'candidate-not-commit')
    checkpoint = signed_squash(root, origin, stage, fetch_evidence(squash), squash)
    fetch_review(squash, checkpoint['review']['head'])
    require_squash_objects(stage, checkpoint, installed)
    return checkpoint


def verify_factory_release(root, origin, checkout, revision):
    evidence = read_git(checkout, 'for-each-ref', '--format=%(objectname)', EVIDENCE_ROOT + revision)
    if not evidence:
        verify_signature(checkout, revision, root / FACTORY_SIGNERS, 'release-signature-unverified')
        return
    try:
        checkpoint = signed_squash(root, origin, checkout, evidence, revision)
        parent = read_git(checkout, 'show', '-s', '--format=%P', revision)
        require_squash_objects(checkout, checkpoint, parent)
    except Blocked:
        raise Blocked('release-signature-unverified') from None
