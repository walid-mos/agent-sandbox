#!/usr/bin/env python3
import argparse
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest

POLICY = runpy.run_path(str(Path(__file__).with_name('landing-policy.py')))
ROOT = POLICY['REPOSITORY']
run = POLICY['run']
HEAD_REF_PREFIX = 'refs/tags/factory-reviewed/'
FIXTURE_REPOSITORY = 'probe/factory'
FIXTURE_TARGET = 'refs/heads/main'
RELEASE_COUNT = 3


def next_review(fixture, commit, number):
    blob = fixture.git('hash-object', '-w', '--stdin', input=f'checked change {number}\n'.encode())
    tree = fixture.git('mktree', input=f'100644 blob {blob}\tchange\n'.encode())
    head = fixture.git('commit-tree', tree, '-p', commit, '-m', f'checked review {number}')
    fixture.git('push', '--quiet', str(fixture.remote), f'{head}:refs/pull/{number}/head')
    run('git', '--git-dir', str(fixture.remote), 'update-server-info')
    return {**fixture.request, 'number': number, 'generation': 1, 'base': commit, 'head': head, 'tree': tree}


def export_series(fixture, revision, output):
    checkpoints = []
    for index in range(RELEASE_COUNT):
        result = POLICY['run_release'](fixture, revision, 'series')
        release = result['published']['release']
        checkpoints.append({'reviewId': result['reviewId'], 'review': {key: value for key, value in result['published'].items() if key != 'release'},
                            'candidate': {key: value for key, value in release.items() if key != 'object'}})
        if index + 1 < RELEASE_COUNT:
            fixture.request = next_review(fixture, release['commit'], fixture.request['number'] + 1)
    output.mkdir()
    target = fixture.request['ref']
    refs = [HEAD_REF_PREFIX + checkpoint['candidate']['commit'] for checkpoint in checkpoints]
    run('git', '--git-dir', str(fixture.remote), 'bundle', 'create', str(output / 'candidate.bundle'), target, *refs)
    for name, home, key in (('operator', fixture.operator, fixture.operator_key), ('factory', fixture.factory, fixture.factory_key)):
        (output / f'{name}-public.asc').write_text(fixture.public_key(home, key))
    manifest = {'producerSource': run('git', '-C', str(ROOT), 'rev-parse', 'HEAD'), 'reviewSource': revision,
                'anchor': fixture.base, 'target': target, 'tip': release['commit'], 'checkpoints': checkpoints}
    (output / 'series.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def git_at(store, *args):
    return run('git', '--no-replace-objects', '--git-dir', str(store), *args)


def require_match(observed, expected, failure):
    if observed != expected:
        raise ValueError(failure)


def verify_checkpoint(store, output, checkpoint, base, target):
    candidate, review = checkpoint['candidate'], checkpoint['review']
    commit, request = candidate['commit'], candidate['request']
    signer = run(sys.executable, '-I', str(ROOT / 'lib/signed_commit.py'), 'verify', str(store), commit, str(output / 'factory-public.asc'))
    require_match(signer, candidate['fingerprint'], 'invalid signer')
    require_match(git_at(store, 'show', '-s', '--format=%B', commit),
                  'Factory landing v1\n\n' + json.dumps(request, sort_keys=True, separators=(',', ':')), 'invalid signed request')
    require_match((request['base'], request['ref'], request['repository']),
                  (base, target, FIXTURE_REPOSITORY), 'invalid checkpoint base, ref or repository')
    require_match(git_at(store, 'show', '-s', '--format=%P', commit), base, 'invalid checkpoint parent')
    ref = HEAD_REF_PREFIX + commit
    try:
        head = git_at(store, 'rev-parse', '--verify', ref)
    except subprocess.CalledProcessError as error:
        raise ValueError('missing reviewed-head ref') from error
    require_match(head, request['head'], 'conflicting reviewed-head ref')
    git_at(store, 'merge-base', '--is-ancestor', base, head)
    for revision in (commit, head):
        require_match(git_at(store, 'rev-parse', f'{revision}^{{tree}}'), request['tree'], 'invalid checkpoint tree')
    identity = [request[key] for key in ('repository', 'number', 'head', 'generation')]
    require_match([review[key] for key in ('repository', 'number', 'head', 'generation', 'mergeBase')],
                  [*identity, base], 'invalid checked review')
    review_id = hashlib.sha256(json.dumps(identity, separators=(',', ':')).encode()).hexdigest()
    require_match(checkpoint['reviewId'], review_id, 'invalid review ID')
    return commit


def verify_series(store, output, manifest):
    base, target, tip = (manifest[key] for key in ('anchor', 'target', 'tip'))
    require_match(target, FIXTURE_TARGET, 'invalid target ref')
    run(sys.executable, '-I', str(ROOT / 'lib/signed_commit.py'), 'verify', str(store), base, str(output / 'operator-public.asc'))
    require_match(git_at(store, 'rev-parse', target), tip, 'invalid target tip')
    git_at(store, 'merge-base', '--is-ancestor', base, tip)
    order = git_at(store, 'rev-list', '--first-parent', '--reverse', f'{base}..{tip}').splitlines()
    require_match([row['candidate']['commit'] for row in manifest['checkpoints']], order, 'missing or reordered checkpoint')
    for checkpoint in manifest['checkpoints']:
        base = verify_checkpoint(store, output, checkpoint, base, target)
    require_match(base, tip, 'incomplete release chain')


def check_export(output):
    manifest = json.loads((output / 'series.json').read_text())
    test = unittest.TestCase()
    with tempfile.TemporaryDirectory(prefix='factory-series-check-') as scratch:
        store = Path(scratch) / 'objects.git'
        run('git', 'init', '--bare', str(store))
        target = manifest['target']
        git_at(store, 'fetch', '--no-tags', str(output / 'candidate.bundle'), f'{target}:{target}',
               f'{HEAD_REF_PREFIX}*:{HEAD_REF_PREFIX}*')
        verify_series(store, output, manifest)
        checkpoints = manifest['checkpoints']
        require_match(len(checkpoints), RELEASE_COUNT, 'expected three releases')
        require_match(len({row['candidate']['request']['tree'] for row in checkpoints}), RELEASE_COUNT, 'expected distinct reviewed trees')
        with test.assertRaisesRegex(ValueError, 'missing or reordered checkpoint'):
            verify_series(store, output, {**manifest, 'checkpoints': checkpoints[1:]})
        with test.assertRaisesRegex(ValueError, 'missing or reordered checkpoint'):
            verify_series(store, output, {**manifest, 'checkpoints': list(reversed(checkpoints))})
        middle = checkpoints[1]['candidate']
        ref = HEAD_REF_PREFIX + middle['commit']
        git_at(store, 'update-ref', '-d', ref, middle['request']['head'])
        with test.assertRaisesRegex(ValueError, 'missing reviewed-head ref'):
            verify_series(store, output, manifest)
        git_at(store, 'update-ref', ref, checkpoints[0]['candidate']['request']['head'])
        with test.assertRaisesRegex(ValueError, 'conflicting reviewed-head ref'):
            verify_series(store, output, manifest)
        git_at(store, 'update-ref', ref, middle['request']['head'])
        invalid = {**checkpoints[1], 'candidate': {**middle, 'request': {**middle['request'], 'generation': 2}}}
        with test.assertRaisesRegex(ValueError, 'invalid signed request'):
            verify_series(store, output, {**manifest, 'checkpoints': [checkpoints[0], invalid, checkpoints[2]]})
        verify_series(store, output, manifest)
    print('landing series: verified three releases and rejected missing, reordered, conflicting and invalid evidence')


def main():
    parser = argparse.ArgumentParser()
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument('--release', metavar='REVIEW_SOURCE')
    operation.add_argument('--verify', type=Path)
    parser.add_argument('--export', type=Path)
    args = parser.parse_args()
    if args.verify:
        check_export(args.verify.resolve())
        return
    if not args.export:
        parser.error('--release needs --export')
    revision = run('git', '-C', str(ROOT), 'rev-parse', '--verify', f'{args.release}^{{commit}}')
    fixture = POLICY['LandingPolicy']()
    try:
        fixture.setUp()
        manifest = export_series(fixture, revision, args.export.resolve())
    finally:
        fixture.doCleanups()
    check_export(args.export.resolve())
    print(json.dumps(manifest))


if __name__ == '__main__':
    main()
