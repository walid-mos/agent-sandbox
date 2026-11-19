#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import runpy
import unittest

SQUASH = runpy.run_path(str(Path(__file__).with_name('landing-squash-proof.py')))
POLICY = SQUASH['POLICY']
SERIES = SQUASH['SERIES']
RECOVERY_FORMAT = 'Factory squash recovery v1'


def recovery_subject(original, landed):
    return {**original, **landed}


def require_recovery(git, original, landed, facts, authorization, previous):
    squash = facts['squash']
    SQUASH['require_bound_review'](original, squash, authorization)
    SQUASH['require_reviewed_tree'](git, original)
    SQUASH['require_landed'](git, original, landed, facts)
    if landed['head'] != squash or landed['base'] != previous:
        raise ValueError('recovery must extend the preceding certified checkpoint')
    recovery = authorization.get('recovery')
    if not recovery or recovery['review']['stage'] != 'judged' or recovery['review']['tree'] != landed['tree']:
        raise ValueError('recovery needs a judged review of the landed tree')
    SQUASH['require_review_verdict'](recovery_subject(original, landed), recovery)


def recover(fixture, original, landed, facts, authorization, previous):
    require_recovery(fixture.git, original, landed, facts, authorization, previous)
    squash = facts['squash']
    payload = {'original': original, 'landed': landed}
    signed = SQUASH['sign_evidence'](fixture, squash, RECOVERY_FORMAT, payload)
    receipt = {**authorization, 'request': original, 'landed': landed, 'squash': squash, 'tagObject': signed}
    return SQUASH['publish_receipt'](fixture, receipt)


def verify_row(git, env, row, base):
    if 'landed' not in row:
        return SQUASH['verify_row'](git, env, row, base)
    request, landed, squash = row['request'], row['landed'], row['squash']
    SQUASH['verify_evidence'](git, env, squash, RECOVERY_FORMAT, {'original': request, 'landed': landed})
    SQUASH['require_contiguous'](git, request, landed, squash, base)
    require_recovery(git, request, landed, SQUASH['merged_facts'](request, squash), row, base)


def intervening_review(fixture, original):
    blob = fixture.git('hash-object', '-w', '--stdin', input=b'intervening checked content\n')
    tree = fixture.git('mktree', input=f'100644 blob {blob}\tbase-change\n'.encode())
    head = fixture.git('commit-tree', tree, '-p', original['base'], '-m', 'intervening reviewed head')
    return {**original, 'number': original['number'] + 1, 'head': head, 'tree': tree}


def assert_refusals(fixture, original, landed, facts, authorization, previous):
    test = unittest.TestCase()
    recovery = authorization['recovery']
    review = recovery['review']
    with test.assertRaisesRegex(ValueError, 'judged review of the landed tree'):
        recover(fixture, original, landed, facts, {**authorization, 'recovery': None}, previous)
    with test.assertRaisesRegex(ValueError, 'preceding certified checkpoint'):
        recover(fixture, original, landed, facts, authorization, original['base'])
    for change in ({'stage': 'checked'}, {'tree': original['tree']}, {'verdict': 'FAIL'}, {'head': original['head']},
                   {'checks': [{'name': 'landed-content', 'isPassed': False}]}):
        invalid = {**authorization, 'recovery': {**recovery, 'review': {**review, **change}}}
        with test.assertRaisesRegex(ValueError, 'bound checked review|judged review of the landed tree'):
            recover(fixture, original, landed, facts, invalid, previous)
    squash = facts['squash']
    test.assertEqual(fixture.git('ls-remote', '--refs', str(fixture.remote),
                                 SQUASH['TAG_REF'] + squash, SQUASH['HEAD_REF'] + squash), '')
    test.assertEqual(fixture.git('tag', '--list', SQUASH['TAG_NAME'] + squash), '')


def review_recovery(fixture, source, original, previous):
    test = unittest.TestCase()
    tree = fixture.git('merge-tree', '--write-tree', previous, original['head'])
    test.assertNotEqual(tree, original['tree'])
    facts = SQUASH['create_squash'](fixture, {**original, 'tree': tree}, previous)
    squash = facts['squash']
    with test.assertRaisesRegex(ValueError, 'checked base or tree'):
        SQUASH['sign_checkpoint'](fixture, original, facts)
    landed = {'head': squash, 'generation': original['generation'], 'base': previous, 'tree': tree}
    old_review = POLICY['run_release'](fixture, source, 'squash-record', merge_commit=squash, request=original)
    fresh = POLICY['run_release'](fixture, source, 'squash-recovery', request=recovery_subject(original, landed))
    test.assertNotEqual(old_review['reviewId'], fresh['reviewId'])
    authorization = {**old_review, 'recovery': fresh}
    assert_refusals(fixture, original, landed, facts, authorization, previous)
    return recover(fixture, original, landed, facts, authorization, previous)


def export_recovery(fixture, output, review_source):
    original = fixture.request
    fixture.request = intervening_review(fixture, original)
    first = SQUASH['next_checkpoint'](fixture, fixture.request, review_source)
    recovered = review_recovery(fixture, review_source, original, first['squash'])
    fixture.request = SERIES['next_review'](fixture, recovered['squash'], fixture.request['number'] + 1)
    last = SQUASH['next_checkpoint'](fixture, fixture.request, review_source)
    return SQUASH['export_checkpoints'](fixture, output, review_source, [first, recovered, last])


def main():
    parser = argparse.ArgumentParser()
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument('--export', type=Path)
    operation.add_argument('--verify', type=Path)
    parser.add_argument('--review-source', metavar='COMMIT')
    args = parser.parse_args()
    if args.export and not args.review_source:
        parser.error('--export requires --review-source')
    output = (args.export or args.verify).resolve()
    manifest = output / 'squashes.json'
    if args.export:
        source = POLICY['run']('git', '-C', str(POLICY['REPOSITORY']), 'rev-parse', '--verify', f'{args.review_source}^{{commit}}')
        fixture = POLICY['LandingPolicy']()
        try:
            fixture.setUp()
            proof = export_recovery(fixture, output, source)
        finally:
            fixture.doCleanups()
        manifest.write_text(json.dumps(proof, indent=2) + '\n')
    SQUASH['verify_proof'](output, json.loads(manifest.read_text()), verify_row)
    print('verified native squash recovery between two ordinary checkpoints')


if __name__ == '__main__':
    main()
