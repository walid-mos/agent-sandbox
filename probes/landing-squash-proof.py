#!/usr/bin/env python3
import argparse
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest import mock

SERIES = runpy.run_path(str(Path(__file__).with_name('landing-series.py')))
POLICY = SERIES['POLICY']
run = POLICY['run']
ROOT = POLICY['REPOSITORY']
HEAD_REF = SERIES['HEAD_REF_PREFIX']
TAG_NAME = 'factory-release/'
TAG_REF = 'refs/tags/' + TAG_NAME
FORMAT = 'Factory squash evidence v1'


def binding(request, squash):
    return {**request, 'squash': squash}


def merged_facts(request, squash):
    return {key: request[key] for key in ('repository', 'number', 'head', 'ref')} | {'state': 'MERGED', 'squash': squash}


def require_landed(git, original, landed, facts):
    squash = facts['squash']
    if facts != merged_facts(original, squash):
        raise ValueError('PR readback does not match the reviewed repository, PR, head and target')
    if git('show', '-s', '--format=%P%n%T', squash).splitlines() != [landed['base'], landed['tree']]:
        raise ValueError('squash differs from the checked base or tree')
    order = git('rev-list', '--first-parent', original['ref']).splitlines()
    if squash not in order:
        raise ValueError('squash is outside target first-parent history')


def require_reviewed_tree(git, request):
    git('merge-base', '--is-ancestor', request['base'], request['head'])
    if git('rev-parse', f"{request['head']}^{{tree}}") != request['tree']:
        raise ValueError('reviewed head tree differs')


def sign_checkpoint(fixture, request, facts):
    require_landed(fixture.git, request, request, facts)
    require_reviewed_tree(fixture.git, request)
    return sign_evidence(fixture, facts['squash'], FORMAT, binding(request, facts['squash']))


def sign_evidence(fixture, squash, subject, payload):
    tag = TAG_NAME + squash
    message = subject + '\n\n' + json.dumps(payload, sort_keys=True, separators=(',', ':'))
    signing = {**POLICY['FIXED_ENVIRONMENT'], 'GNUPGHOME': str(fixture.factory)}
    fixture.git('-c', 'gpg.format=openpgp', 'tag', '-u', fixture.factory_key, '-m', message, tag, squash, environment=signing)
    return fixture.git('rev-parse', TAG_REF + squash)


def publish_checkpoint(fixture, receipt):
    squash, signed, reviewed = receipt['squash'], receipt['tagObject'], receipt['request']['head']
    tag, head = TAG_REF + squash, HEAD_REF + squash
    remote = str(fixture.remote)
    expected = {f'{signed}\t{tag}', f'{reviewed}\t{head}'}
    observed = set(fixture.git('ls-remote', '--refs', remote, tag, head).splitlines())
    if observed == expected:
        return
    if observed:
        raise ValueError('release refs are partial or conflicting')
    fixture.git('push', '--quiet', '--atomic', f'--force-with-lease={tag}:', f'--force-with-lease={head}:',
                remote, f'{signed}:{tag}', f'{reviewed}:{head}')
    if set(fixture.git('ls-remote', '--refs', remote, tag, head).splitlines()) != expected:
        raise ValueError('publication readback mismatch')


def create_squash(fixture, request, live_base):
    squash = fixture.git('commit-tree', request['tree'], '-p', live_base, '-m', f"native squash #{request['number']}")
    fixture.git('update-ref', request['ref'], squash, live_base)
    fixture.git('push', '--quiet', str(fixture.remote), f"{squash}:{request['ref']}")
    return merged_facts(request, squash)


def require_bound_review(request, squash, checkpoint):
    require_review_verdict(request, checkpoint)
    review = checkpoint['review']
    if review['stage'] != 'merged' or review['mergeCommit'] != squash:
        raise ValueError('merged record differs from the bound checked review')


def require_review_verdict(request, checkpoint):
    review = checkpoint['review']
    fields = ('repository', 'number', 'head', 'generation')
    identity = [request[field] for field in fields]
    review_id = hashlib.sha256(json.dumps(identity, separators=(',', ':')).encode()).hexdigest()
    if (checkpoint['reviewId'] != review_id or [review[field] for field in fields] != identity
            or review['mergeBase'] != request['base'] or 'refs/heads/' + review['base'] != request['ref']
            or review['verdict'] != 'PASS' or not review['checks']
            or not all(check['isPassed'] is True for check in review['checks'])):
        raise ValueError('merged record differs from the bound checked review')


def next_checkpoint(fixture, request, review_source):
    test = unittest.TestCase()
    fixture.git('update-ref', request['ref'], request['base'])
    facts = create_squash(fixture, request, request['base'])
    squash = facts['squash']
    for change in ({'state': 'OPEN'}, {'ref': 'refs/heads/other'}, {'number': request['number'] + 1},
                   {'repository': 'other/repository'}, {'head': request['base']}):
        with test.assertRaisesRegex(ValueError, 'PR readback'):
            sign_checkpoint(fixture, request, {**facts, **change})
    with test.assertRaisesRegex(ValueError, 'checked base or tree'):
        sign_checkpoint(fixture, {**request, 'base': request['head']}, facts)
    with test.assertRaisesRegex(ValueError, 'checked base or tree'):
        sign_checkpoint(fixture, {**request, 'tree': fixture.git('rev-parse', f"{request['base']}^{{tree}}")}, facts)
    checked = POLICY['run_release'](fixture, review_source, 'squash-record', merge_commit=squash)
    require_bound_review(request, squash, checked)
    with test.assertRaisesRegex(ValueError, 'bound checked review'):
        require_bound_review({**request, 'generation': request['generation'] + 1}, squash, checked)
    signed = sign_checkpoint(fixture, request, facts)
    receipt = {**checked, 'request': request, 'squash': squash, 'tagObject': signed}
    return publish_receipt(fixture, receipt)


def publish_receipt(fixture, receipt):
    test = unittest.TestCase()
    saved = fixture.root / f"{receipt['squash']}.json"
    saved.write_text(json.dumps(receipt))
    publish_checkpoint(fixture, receipt)
    with mock.patch.object(fixture, 'git', wraps=fixture.git) as git:
        publish_checkpoint(fixture, json.loads(saved.read_text()))
        test.assertFalse(any(call.args[0] == 'push' for call in git.call_args_list))
    return receipt


def reject_raced_squash(fixture):
    request = fixture.request
    live_base = fixture.git('commit-tree', request['tree'], '-p', request['base'], '-m', 'intervening target update')
    fixture.git('update-ref', request['ref'], live_base, request['base'])
    facts = create_squash(fixture, request, live_base)
    with unittest.TestCase().assertRaisesRegex(ValueError, 'checked base or tree'):
        sign_checkpoint(fixture, request, facts)
    unittest.TestCase().assertEqual(fixture.git('ls-remote', '--refs', str(fixture.remote), request['ref']).split('\t')[0], facts['squash'])
    unittest.TestCase().assertEqual(fixture.git('tag', '--list', TAG_NAME + '*'), '')


def export_proof(fixture, output, review_source):
    checkpoints = []
    for index in range(SERIES['RELEASE_COUNT']):
        checkpoint = next_checkpoint(fixture, fixture.request, review_source)
        checkpoints.append(checkpoint)
        if index + 1 < SERIES['RELEASE_COUNT']:
            fixture.request = SERIES['next_review'](fixture, checkpoint['squash'], fixture.request['number'] + 1)
    return export_checkpoints(fixture, output, review_source, checkpoints)


def export_checkpoints(fixture, output, review_source, checkpoints):
    output.mkdir()
    refs = [prefix + row['squash'] for row in checkpoints for prefix in (TAG_REF, HEAD_REF)]
    run('git', '--git-dir', str(fixture.remote), 'bundle', 'create', str(output / 'squashes.bundle'), fixture.request['ref'], *refs)
    (output / 'factory-public.asc').write_text(fixture.public_key(fixture.factory, fixture.factory_key))
    (output / 'operator-public.asc').write_text(fixture.public_key(fixture.operator, fixture.operator_key))
    return {'producerSource': run('git', '-C', str(ROOT), 'rev-parse', 'HEAD'), 'reviewSource': review_source, 'anchor': fixture.base,
            'target': fixture.request['ref'], 'tip': checkpoints[-1]['squash'], 'checkpoints': checkpoints}


def verify_evidence(git, env, squash, expected_subject, expected_payload):
    ref = TAG_REF + squash
    git('verify-tag', ref, environment=env)
    raw = git('cat-file', 'tag', ref)
    header, _, message = raw.partition('\n\n')
    subject, _, payload = message.partition('\n\n')
    expected = json.dumps(expected_payload, sort_keys=True, separators=(',', ':'))
    if (header.splitlines()[:3] != [f'object {squash}', 'type commit', f'tag {TAG_NAME}{squash}']
            or subject != expected_subject or payload.partition('\n-----BEGIN PGP SIGNATURE-----')[0] != expected):
        raise ValueError('signed tag does not bind the squash and review')


def require_contiguous(git, original, landed, squash, base):
    if landed['base'] != base or git('rev-parse', HEAD_REF + squash) != original['head']:
        raise ValueError('discontinuous base or conflicting reviewed head')
    require_landed(git, original, landed, merged_facts(original, squash))
    require_reviewed_tree(git, original)


def verify_row(git, env, row, base):
    request, squash = row['request'], row['squash']
    require_bound_review(request, squash, row)
    verify_evidence(git, env, squash, FORMAT, binding(request, squash))
    require_contiguous(git, request, request, squash, base)


def verify_proof(output, proof, verifier=verify_row):
    with tempfile.TemporaryDirectory(prefix='factory-squash-proof-') as work:
        store, home = Path(work) / 'objects.git', Path(work) / 'keys'
        home.mkdir(mode=0o700)
        env = {**POLICY['FIXED_ENVIRONMENT'], 'GNUPGHOME': str(home)}
        run('gpg', '--batch', '--import', str(output / 'factory-public.asc'), environment=env)
        try:
            verify_bundle(store, output, proof, env, verifier)
        finally:
            subprocess.run(['gpgconf', '--homedir', str(home), '--kill', 'all'], check=True)


def verify_bundle(store, output, proof, env, verifier):
    run('git', 'init', '--bare', str(store))
    def git(*args, **options):
        return run('git', '--no-replace-objects', '--git-dir', str(store), *args, **options)

    target, anchor = proof['target'], proof['anchor']
    if target != SERIES['FIXTURE_TARGET']:
        raise ValueError('unexpected fixture target')
    git('fetch', '--no-tags', str(output / 'squashes.bundle'), f'{target}:{target}',
        f'{TAG_REF}*:{TAG_REF}*', f'{HEAD_REF}*:{HEAD_REF}*')
    run('python3', '-I', str(ROOT / 'lib/signed_commit.py'), 'verify', str(store), anchor, str(output / 'operator-public.asc'))
    tip = git('rev-parse', target)
    git('merge-base', '--is-ancestor', anchor, tip)
    chain = git('rev-list', '--first-parent', '--reverse', f'{anchor}..{tip}').splitlines()
    if chain != [row['squash'] for row in proof['checkpoints']] or tip != proof['tip']:
        raise ValueError('incomplete squash chain')
    base = anchor
    for squash, row in zip(chain, proof['checkpoints'], strict=True):
        if git('rev-parse', TAG_REF + squash) != row['tagObject']:
            raise ValueError('signed tag ID differs from the export receipt')
        request = row['request']
        if (request['repository'], request['ref']) != (SERIES['FIXTURE_REPOSITORY'], target):
            raise ValueError('unexpected fixture repository or target')
        verifier(git, env, row, base)
        base = squash
    reject_tag_substitutions(git, env, proof, verifier)


def reject_tag_substitutions(git, env, proof, verifier):
    middle = proof['checkpoints'][1]
    base = proof['checkpoints'][0]['squash']
    ref = TAG_REF + middle['squash']
    git('update-ref', '-d', ref, middle['tagObject'])
    with unittest.TestCase().assertRaises(subprocess.CalledProcessError):
        verifier(git, env, middle, base)
    git('update-ref', ref, proof['checkpoints'][0]['tagObject'])
    with unittest.TestCase().assertRaisesRegex(ValueError, 'signed tag does not bind'):
        verifier(git, env, middle, base)


def main():
    parser = argparse.ArgumentParser()
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument('--export', type=Path)
    operation.add_argument('--verify', type=Path)
    parser.add_argument('--review-source', metavar='COMMIT')
    args = parser.parse_args()
    if args.verify:
        output = args.verify.resolve()
        proof = json.loads((output / 'squashes.json').read_text())
    else:
        if not args.review_source:
            parser.error('--export requires --review-source')
        review_source = run('git', '-C', str(ROOT), 'rev-parse', '--verify', f'{args.review_source}^{{commit}}')
        output = args.export.resolve()
        fixture = POLICY['LandingPolicy']()
        try:
            fixture.setUp()
            reject_raced_squash(fixture)
        finally:
            fixture.doCleanups()
        fixture = POLICY['LandingPolicy']()
        try:
            fixture.setUp()
            proof = export_proof(fixture, output, review_source)
        finally:
            fixture.doCleanups()
        (output / 'squashes.json').write_text(json.dumps(proof, indent=2) + '\n')
    verify_proof(output, proof)
    print('verified three simulated native squash checkpoints, exact retry, and refusal of wrong PR, base, tree, and missing or swapped evidence')


if __name__ == '__main__':
    main()
