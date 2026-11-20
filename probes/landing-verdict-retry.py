#!/usr/bin/env python3
import json
from pathlib import Path
import runpy
import unittest

ENTRY = runpy.run_path(str(Path(__file__).with_name('landing-entry.py')))


class VerdictRetry(ENTRY['LandingEntry']):
    def setUp(self):
        super().setUp()
        self.prepare_entry()
        self.enterContext(self.service('landing'))
        self.enterContext(self.service('reports'))
        self.command('scan')
        self.review_id = self.review(30)

    def verdict(self, *args, error=None):
        self.command('review', self.review_id, 'verdict', *(args or ('PASS',)), error=error)

    def require_one_comment_and_merge(self):
        self.assertEqual(len(self.events('comments-30')), 1)
        self.assertEqual(self.events('merges'), [self.squash(30)])

    def test_lost_comment_response_retries_the_same_verdict(self):
        (self.root / 'lose-comment-response').touch()
        self.verdict(error='lost the verdict comment response')
        self.assertEqual(len(self.events('comments-30')), 1)
        self.assertEqual(self.events('merges'), [])
        self.verdict()
        self.require_one_comment_and_merge()

    def test_unconfirmed_readback_refuses_other_authors_and_review_attempts(self):
        (self.root / 'lose-comment-response').touch()
        self.verdict(error='lost the verdict comment response')
        unavailable = self.root / 'fail-comment-readback'
        unavailable.touch()
        self.verdict(error='verdict comment readback unavailable')
        unavailable.unlink()
        notes = self.root / 'notes'
        notes.write_text('A different verdict.')
        self.verdict('FAIL', str(notes), error='retry the same bound verdict and notes')
        comment, = self.events('comments-30')
        self.assertIn(f'factory-verdict:{self.review_id}:', comment['body'])
        previous_attempt = 'a' * len(self.review_id)
        impostors = [{**comment, 'user': {'id': 18}},
                     {**comment, 'body': comment['body'].replace(self.review_id, previous_attempt)}]
        override = self.root / 'comment-readback.json'
        for listing in ({'incomplete': []}, [[]], [impostors, []]):
            override.write_text(json.dumps(listing))
            error = 'unconfirmed' if isinstance(listing, list) else 'invalid verdict comment listing'
            self.verdict(error=error)
        self.assertEqual(self.events('merges'), [])
        self.assertEqual(self.events('comments-30'), [comment])
        override.unlink()
        self.verdict()
        self.require_one_comment_and_merge()

    def test_target_tip_refusal_does_not_repost_a_confirmed_comment(self):
        git = ENTRY['POLICY']['run']
        remote = ('git', '--git-dir', str(self.remote))
        moved = git(*remote, 'commit-tree', f'{self.base}^{{tree}}', '-p', self.base, '-m', 'new target')
        git(*remote, 'update-ref', 'refs/heads/main', moved, self.base)
        for _ in range(2):
            self.verdict(error='target moved after review')
            self.assertEqual(self.events('merges'), [])
            self.assertEqual(len(self.events('comments-30')), 1)
        git(*remote, 'update-ref', 'refs/heads/main', self.base, moved)
        git(*remote, 'update-server-info')
        self.verdict()
        self.require_one_comment_and_merge()


if __name__ == '__main__':
    suite = unittest.TestSuite(VerdictRetry(name) for name in (
        'test_lost_comment_response_retries_the_same_verdict',
        'test_unconfirmed_readback_refuses_other_authors_and_review_attempts',
        'test_target_tip_refusal_does_not_repost_a_confirmed_comment',
    ))
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
