#!/usr/bin/env python3
import json
import os
from pathlib import Path
import runpy
import subprocess
import unittest

probe = runpy.run_path(str(Path(__file__).with_name('factory-installed-receiver.py')))
EXPORT = os.environ.get('FACTORY_RELEASE_SERIES')
SOURCE_REF = 'refs/heads/main'
TAG_ROOT = 'refs/tags/factory-reviewed/'
ANCHOR = 'f2d1471782af3b27f77aaa7317ef69a431db9c18'
TIP = 'b86dacb7d79864561c3d227a34ba97dfd9e0d487'


@unittest.skipUnless(EXPORT, 'provide the disposable #30 series export')
class ReceiverSeries(probe['InstalledFixture']):
    def prepare_export(self):
        self.export = Path(EXPORT)
        self.bundle = self.root / 'publisher.git'
        self.git(self.root, 'init', '-q', '--bare', str(self.bundle))
        self.git(self.bundle, 'fetch', '-q', '--no-tags', str(self.export / 'candidate.bundle'),
                 f'{SOURCE_REF}:{SOURCE_REF}', f'{TAG_ROOT}*:{TAG_ROOT}*')
        self.installed = self.git(self.bundle, 'rev-parse', f'{ANCHOR}^{{commit}}')
        self.revision = self.git(self.bundle, 'rev-parse', SOURCE_REF)
        self.assertEqual(self.revision, TIP)
        self.series = json.loads((self.export / 'series.json').read_text())
        self.checkpoints = [checkpoint['candidate']['commit'] for checkpoint in self.series['checkpoints']]
        self.assertEqual((self.series['anchor'], self.series['tip']), (self.installed, self.revision))

    def test_timer_activates_every_signed_checkpoint_in_order(self):
        self.assertEqual(self.installed_command('initialize-receiver').returncode, 0)
        code, state = self.outcome(self.unit('update'))
        self.assertEqual(code, 0, state)
        self.assertEqual(self.starts(), [self.installed, *self.checkpoints])
        expected = self.series['checkpoints'][-1]['candidate']
        self.assertEqual(state['verified']['review'], expected['request'])
        self.assertEqual(state['verified']['signer'], expected['fingerprint'])
        self.assertEqual(state['loaded'], self.revision)

    def test_missing_middle_tag_blocks_the_series_before_any_switch(self):
        self.assertEqual(self.installed_command('initialize-receiver').returncode, 0)
        ref = TAG_ROOT + self.checkpoints[1]
        head = self.git(self.bundle, 'rev-parse', ref)
        self.git(self.bundle, 'update-ref', '-d', ref)
        code, state = self.outcome(self.unit('update'))
        self.assertEqual((code, state['blocked'], state['known_good']), (1, 'factory-review-fetch-failed', self.installed))
        self.assertEqual(self.starts(), [self.installed])
        self.git(self.bundle, 'update-ref', ref, head)
        self.assertEqual(self.outcome(self.unit('update'))[1]['loaded'], self.revision)
        self.assertEqual(self.starts(), [self.installed, *self.checkpoints])

    def test_annotated_tag_pointing_to_signed_head_is_refused(self):
        self.assertEqual(self.installed_command('initialize-receiver').returncode, 0)
        name = 'factory-reviewed/' + self.checkpoints[1]
        head = self.git(self.bundle, 'rev-parse', 'refs/tags/' + name)
        self.git(self.bundle, 'tag', '-fa', name, head, '-m', 'Annotated review tag')
        code, state = self.outcome(self.unit('update'))
        self.assertEqual((code, state['blocked']), (1, 'factory-review-ref-mismatch'))
        self.assertEqual(self.starts(), [self.installed])

    def test_failed_middle_listener_restores_first_checkpoint_and_retries_in_order(self):
        self.assertEqual(self.installed_command('initialize-receiver').returncode, 0)
        first, middle, last = self.checkpoints
        unavailable = self.root / f'no-router-{middle}'
        unavailable.touch()
        code, state = self.outcome(self.unit('update'))
        self.assertEqual(code, 1, state)
        self.assertEqual((state['desired'], state['known_good'], state['loaded']), (middle, first, first))
        self.assertEqual(self.starts(), [self.installed, first, middle, first])
        unavailable.unlink()
        self.assertEqual(self.outcome(self.unit('update'))[1]['loaded'], last)
        self.assertEqual(self.starts(), [self.installed, first, middle, first, middle, last])


if __name__ == '__main__':
    unittest.main(verbosity=2)
