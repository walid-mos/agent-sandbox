import json
import os
import stat

from managed_update import (BRANCH, SHA1, GIT_READ_OPTIONS, Blocked, commit_object, read_git,
                            require_exact_commit, require_protected, staged_candidate, verify_signature)

LANDING_REF = f'refs/heads/{BRANCH}'
REVIEW_TAG_ROOT = 'refs/tags/factory-reviewed/'
PROVENANCE_HEADER = b'Factory landing v1'
SIGNATURE_UNVERIFIED = 'factory-signature-unverified'
REQUEST_FIELDS = {'repository', 'number', 'generation', 'ref', 'head', 'base', 'tree'}
MAX_SAFE_INTEGER = (1 << 53) - 1


def require_review_request(request, repository):
    if not isinstance(request, dict) or request.keys() != REQUEST_FIELDS:
        raise Blocked('invalid-factory-request')
    if request['repository'] != repository or request['ref'] != LANDING_REF:
        raise Blocked('factory-target-mismatch')
    if not all(type(request[key]) is int and minimum <= request[key] <= MAX_SAFE_INTEGER
               for key, minimum in (('number', 1), ('generation', 0))):
        raise Blocked('invalid-factory-request')
    if any(not isinstance(request[key], str) or not SHA1.fullmatch(request[key]) for key in ('head', 'base', 'tree')):
        raise Blocked('invalid-factory-request')


def landing_request(stage, candidate, repository):
    raw = commit_object(stage, candidate, GIT_READ_OPTIONS)
    _, _, message = raw.partition(b'\n\n')
    subject, separator, payload = message.partition(b'\n\n')
    if subject != PROVENANCE_HEADER or not separator:
        raise Blocked('factory-landing-mismatch')
    try:
        request = json.loads(payload)
    except (ValueError, RecursionError):
        raise Blocked('invalid-factory-request') from None
    require_review_request(request, repository)
    canonical = json.dumps(request, sort_keys=True, separators=(',', ':')).encode() + b'\n'
    if canonical != payload:
        raise Blocked('invalid-factory-request')
    return request


def require_reviewed_head(stage, request):
    base, head, tree = (request[key] for key in ('base', 'head', 'tree'))
    require_exact_commit(stage, head, 'factory-review-object-missing')
    read_git(stage, 'merge-base', '--is-ancestor', base, head, failure='factory-head-not-reviewed-base')
    if read_git(stage, 'rev-parse', f'{head}^{{tree}}') != tree:
        raise Blocked('factory-tree-mismatch')


def require_reviewed_tree(stage, candidate, request):
    require_reviewed_head(stage, request)
    if read_git(stage, 'rev-parse', f'{candidate}^{{tree}}') != request['tree']:
        raise Blocked('factory-tree-mismatch')


def require_landing_parents(stage, candidate, base):
    # The Factory landing v1 parent rule is specified by PR #30.
    if read_git(stage, 'show', '-s', '--format=%P', candidate) != base:
        raise Blocked('factory-base-mismatch')


def signed_landing(root, origin, stage, candidate):
    signers = root / 'factory-signers.asc'
    require_protected(signers, stat.S_ISREG, (os.geteuid(),))
    signer = verify_signature(stage, candidate, signers, SIGNATURE_UNVERIFIED)
    repository = origin.removeprefix('https://github.com/').removesuffix('.git')
    return signer, landing_request(stage, candidate, repository)


def verify_checkpoint(root, origin, stage, installed, candidate, fetch_review=None):
    require_exact_commit(stage, candidate, 'candidate-not-commit')
    signer, request = signed_landing(root, origin, stage, candidate)
    if request['base'] != installed:
        raise Blocked('factory-base-mismatch')
    require_landing_parents(stage, candidate, installed)
    if fetch_review is not None:
        fetch_review(candidate, request['head'])
    require_reviewed_tree(stage, candidate, request)
    return {'revision': candidate, 'signer': signer, 'ref': LANDING_REF,
            'tree': request['tree'], 'review': request}


def verify_publication(root, origin, installed, candidate):
    stage = staged_candidate(root, origin, installed, candidate)
    return verify_checkpoint(root, origin, stage, installed, candidate)
