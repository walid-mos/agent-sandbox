#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest

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


def require_merge(git, request, facts):
    squash = facts['squash']
    expected = {key: request[key] for key in ('repository', 'number', 'head', 'ref')}
    if facts != {**expected, 'state': 'MERGED', 'squash': squash}:
        raise ValueError('PR readback does not match the reviewed repository, PR, head and target')
    if git('show', '-s', '--format=%P%n%T', squash).splitlines() != [request['base'], request['tree']]:
        raise ValueError('squash differs from the checked base or tree')
    git('merge-base', '--is-ancestor', squash, request['ref'])
    git('merge-base', '--is-ancestor', request['base'], request['head'])
    if git('rev-parse', f"{request['head']}^{{tree}}") != request['tree']:
        raise ValueError('reviewed head tree differs')


def sign_checkpoint(fixture, request, facts):
    require_merge(fixture.git, request, facts)
    squash = facts['squash']
    tag = TAG_NAME + squash
    message = FORMAT + '\n\n' + json.dumps(binding(request, squash), sort_keys=True, separators=(',', ':'))
    signing = {**POLICY['FIXED_ENVIRONMENT'], 'GNUPGHOME': str(fixture.factory)}
    fixture.git('-c', 'gpg.format=openpgp', 'tag', '-u', fixture.factory_key, '-m', message, tag, squash, environment=signing)
    return fixture.git('rev-parse', TAG_REF + squash)


def publish_checkpoint(fixture, request, squash, signed):
    tag, head = TAG_REF + squash, HEAD_REF + squash
    fixture.git('push', '--quiet', '--atomic', f'--force-with-lease={tag}:', f'--force-with-lease={head}:',
                str(fixture.remote), f'{signed}:{tag}', f"{request['head']}:{head}")
    for ref, expected in ((tag, signed), (head, request['head'])):
        if fixture.git('ls-remote', '--refs', str(fixture.remote), ref) != f'{expected}\t{ref}':
            raise ValueError('publication readback mismatch')


def create_squash(fixture, request, live_base):
    squash = fixture.git('commit-tree', request['tree'], '-p', live_base, '-m', f"native squash #{request['number']}")
    fixture.git('update-ref', request['ref'], squash, live_base)
    fixture.git('push', '--quiet', str(fixture.remote), f"{squash}:{request['ref']}")
    return {key: request[key] for key in ('repository', 'number', 'head', 'ref')} | {'state': 'MERGED', 'squash': squash}


def next_checkpoint(fixture, request):
    test = unittest.TestCase()
    fixture.git('update-ref', request['ref'], request['base'])
    facts = create_squash(fixture, request, request['base'])
    squash = facts['squash']
    with test.assertRaisesRegex(ValueError, 'PR readback'):
        sign_checkpoint(fixture, request, {**facts, 'state': 'OPEN'})
    with test.assertRaisesRegex(ValueError, 'PR readback'):
        sign_checkpoint(fixture, request, {**facts, 'ref': 'refs/heads/other'})
    with test.assertRaisesRegex(ValueError, 'checked base or tree'):
        sign_checkpoint(fixture, {**request, 'base': request['head']}, facts)
    with test.assertRaisesRegex(ValueError, 'checked base or tree'):
        sign_checkpoint(fixture, {**request, 'tree': fixture.git('rev-parse', f"{request['base']}^{{tree}}")}, facts)
    signed = sign_checkpoint(fixture, request, facts)
    publish_checkpoint(fixture, request, squash, signed)
    saved = fixture.git('rev-parse', TAG_REF + squash)
    test.assertEqual(saved, signed)
    publish_checkpoint(fixture, request, squash, saved)
    return {'request': request, 'squash': squash, 'tagObject': signed}


def reject_raced_squash(fixture):
    request = fixture.request
    live_base = fixture.git('commit-tree', request['tree'], '-p', request['base'], '-m', 'intervening target update')
    fixture.git('update-ref', request['ref'], live_base, request['base'])
    facts = create_squash(fixture, request, live_base)
    with unittest.TestCase().assertRaisesRegex(ValueError, 'checked base or tree'):
        sign_checkpoint(fixture, request, facts)
    unittest.TestCase().assertEqual(fixture.git('ls-remote', '--refs', str(fixture.remote), request['ref']).split('\t')[0], facts['squash'])
    unittest.TestCase().assertEqual(fixture.git('tag', '--list', TAG_NAME + '*'), '')


def export_proof(fixture, output):
    checkpoints = []
    for index in range(SERIES['RELEASE_COUNT']):
        checkpoint = next_checkpoint(fixture, fixture.request)
        checkpoints.append(checkpoint)
        if index + 1 < SERIES['RELEASE_COUNT']:
            fixture.request = SERIES['next_review'](fixture, checkpoint['squash'], fixture.request['number'] + 1)
    output.mkdir()
    refs = [prefix + row['squash'] for row in checkpoints for prefix in (TAG_REF, HEAD_REF)]
    run('git', '--git-dir', str(fixture.remote), 'bundle', 'create', str(output / 'squashes.bundle'), fixture.request['ref'], *refs)
    (output / 'factory-public.asc').write_text(fixture.public_key(fixture.factory, fixture.factory_key))
    (output / 'operator-public.asc').write_text(fixture.public_key(fixture.operator, fixture.operator_key))
    return {'producerSource': run('git', '-C', str(ROOT), 'rev-parse', 'HEAD'), 'anchor': fixture.base,
            'target': fixture.request['ref'], 'tip': checkpoints[-1]['squash'], 'checkpoints': checkpoints}


def verify_checkpoint(git, env, request, squash, base):
    ref = TAG_REF + squash
    git('verify-tag', ref, environment=env)
    raw = git('cat-file', 'tag', ref)
    header, _, message = raw.partition('\n\n')
    subject, _, payload = message.partition('\n\n')
    expected = json.dumps(binding(request, squash), sort_keys=True, separators=(',', ':'))
    if (header.splitlines()[:3] != [f'object {squash}', 'type commit', f'tag {TAG_NAME}{squash}']
            or subject != FORMAT or payload.partition('\n-----BEGIN PGP SIGNATURE-----')[0] != expected):
        raise ValueError('signed tag does not bind the squash and review')
    if request['base'] != base or git('rev-parse', HEAD_REF + squash) != request['head']:
        raise ValueError('discontinuous base or conflicting reviewed head')
    require_merge(git, request, {key: request[key] for key in ('repository', 'number', 'head', 'ref')} | {'state': 'MERGED', 'squash': squash})


def verify_proof(output, proof):
    with tempfile.TemporaryDirectory(prefix='factory-squash-proof-') as work:
        store, home = Path(work) / 'objects.git', Path(work) / 'keys'
        home.mkdir(mode=0o700)
        env = {**POLICY['FIXED_ENVIRONMENT'], 'GNUPGHOME': str(home)}
        run('gpg', '--batch', '--import', str(output / 'factory-public.asc'), environment=env)
        try:
            verify_bundle(store, output, proof, env)
        finally:
            subprocess.run(['gpgconf', '--homedir', str(home), '--kill', 'all'], check=True)


def verify_bundle(store, output, proof, env):
    run('git', 'init', '--bare', str(store))
    def git(*args, **options):
        return run('git', '--no-replace-objects', '--git-dir', str(store), *args, **options)

    target, anchor = proof['target'], proof['anchor']
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
        verify_checkpoint(git, env, row['request'], squash, base)
        base = squash
    middle = proof['checkpoints'][1]
    ref = TAG_REF + middle['squash']
    git('update-ref', '-d', ref, middle['tagObject'])
    with unittest.TestCase().assertRaises(subprocess.CalledProcessError):
        verify_checkpoint(git, env, middle['request'], middle['squash'], middle['request']['base'])
    git('update-ref', ref, proof['checkpoints'][0]['tagObject'])
    with unittest.TestCase().assertRaisesRegex(ValueError, 'signed tag does not bind'):
        verify_checkpoint(git, env, middle['request'], middle['squash'], middle['request']['base'])


def main():
    parser = argparse.ArgumentParser()
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument('--export', type=Path)
    operation.add_argument('--verify', type=Path)
    args = parser.parse_args()
    if args.verify:
        output = args.verify.resolve()
        proof = json.loads((output / 'squashes.json').read_text())
    else:
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
            proof = export_proof(fixture, output)
        finally:
            fixture.doCleanups()
        (output / 'squashes.json').write_text(json.dumps(proof, indent=2) + '\n')
    verify_proof(output, proof)
    print('verified three simulated native squash checkpoints, exact retry, and refusal of wrong PR, base, tree, and missing or swapped evidence')


if __name__ == '__main__':
    main()
