#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import runpy
import selectors
import shutil
import subprocess
import sys
import unittest
from contextlib import contextmanager

RECOVERY = runpy.run_path(str(Path(__file__).with_name('landing-squash-recovery.py')))
SQUASH = RECOVERY['SQUASH']
POLICY = RECOVERY['POLICY']
REPOSITORY = RECOVERY['SERIES']['FIXTURE_REPOSITORY']
REVIEW_SOURCE = 'ea7e71c64d3e8da83b82bb6c52e8bb7d097651b6'


class LandingEntry(POLICY['LandingPolicy']):
    def __init__(self, output=None):
        super().__init__()
        self.output = output

    def runTest(self):
        self.prepare_entry()
        self.command('scan', enrollment_refusal=True, isolated='0')
        self.assertFalse((self.root / 'wakes.jsonl').exists())
        with self.service('landing'), self.service('reports'):
            self.prove_gate_refuses_requests()
            self.prove_first_release()
            self.prove_race_and_continuation()
            if self.output:
                self.export_checkpoints()
            self.prove_failed_landed_check()

    def prepare_entry(self):
        shutil.copytree(POLICY['REPOSITORY'] / 'session', self.source / 'session', dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns('__pycache__', 'launch.env'))
        self.node = shutil.which('node')
        commands = self.root / 'commands'
        commands.mkdir()
        for binary in ('gh', 'pots', 'docker'):
            command = commands / binary
            shutil.copyfile(Path(__file__).with_name('landing-entry-adapter.py'), command)
            command.chmod(0o700)
        launch = self.source / 'session/launch.env'
        with launch.open('a') as stream:
            stream.write(f'POTS_LANDING_SQUASH_ENROLLED=1\nPOTS_LANDING_SOCKET={self.root}/sign/socket\n'
                         f'POTS_FACTORY_REPORT_SOCKET={self.root}/report/socket\nPOTS_FACTORY_REPORT_SOURCE=pr-factory\n')
        (self.root / 'loader.mjs').write_text("""import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './sandbox.mjs') return { url: 'data:text/javascript,export const botId=%22fixture%22,owners=[%22probe%22],sandbox={};', shortCircuit: true };
  return next(specifier, context);
} });
""")
        (self.source / 'session/factory-repositories.json').write_text(json.dumps({REPOSITORY: [
            {'name': 'fixture', 'run': ['sh', 'check-fixture.sh', '{base}']},
        ]}))
        self.env = {**POLICY['FIXED_ENVIRONMENT'], 'HOME': str(self.root), 'PATH': f'{commands}:/usr/bin:/bin',
                    'LANDING_TEST_ROOT': str(self.root), 'LANDING_TEST_NODE': self.node, 'POTS_ISOLATED_FACTORY': '1',
                    'GIT_CONFIG_COUNT': '2', 'GIT_CONFIG_KEY_0': f'url.{self.remote}.insteadOf',
                    'GIT_CONFIG_VALUE_0': f'https://github.com/{REPOSITORY}.git',
                    'GIT_CONFIG_KEY_1': 'protocol.allow', 'GIT_CONFIG_VALUE_1': 'never',
                    'GIT_ALLOW_PROTOCOL': 'file', 'PYTHONDONTWRITEBYTECODE': '1'}
        self.write_hook('post-update', '#!/bin/sh\n/usr/bin/git update-server-info\n')
        self.open_pull(30, self.base, 'first')

    @contextmanager
    def service(self, name):
        directory = 'sign' if name == 'landing' else 'report'
        process = subprocess.Popen([sys.executable, '-B', str(Path(__file__).with_name('landing-entry-service.py')),
                                    str(self.source), str(self.root), name], stdout=subprocess.PIPE, text=True)
        try:
            with selectors.DefaultSelector() as ready:
                ready.register(process.stdout, selectors.EVENT_READ)
                self.assertTrue(ready.select(10), f'{name} did not start')
                self.assertIn('ready', process.stdout.readline())
            self.assertTrue((self.root / directory / 'socket').is_socket())
            yield
        finally:
            process.terminate()
            process.wait(timeout=10)
            process.stdout.close()

    def write_hook(self, name, contents):
        hook = self.remote / 'hooks' / name
        with hook.open('x') as output:
            output.write(contents)
        hook.chmod(0o700)
        return hook

    def open_pull(self, number, parent, filename):
        self.git('fetch', '-q', str(self.remote), 'refs/heads/main')
        self.git('checkout', '-q', '--detach', parent)
        (self.clone / 'check-fixture.sh').write_text('set -eu\ngit diff --check "$1" HEAD\n! test -f left || ! test -f right\n')
        (self.clone / filename).write_text(f'{filename}\n')
        self.git('add', 'check-fixture.sh', filename)
        self.git('commit', '-qm', filename)
        head = self.git('rev-parse', 'HEAD')
        self.git('push', '-q', str(self.remote), f'+{head}:refs/pull/{number}/head')
        self.git('checkout', '-q', 'main')
        POLICY['run']('git', '--git-dir', str(self.remote), 'update-server-info')
        facts = {'number': number, 'headRefOid': head, 'headRefName': filename, 'baseRefName': 'main',
                 'isDraft': False, 'mergeable': 'MERGEABLE', 'state': 'OPEN', 'body': '', 'title': filename}
        (self.root / f'pull-{number}.json').write_text(json.dumps(facts))
        return head

    def command(self, *args, error=None, enrollment_refusal=False, isolated='1'):
        result = subprocess.run([self.node, '--import', str(self.root / 'loader.mjs'),
                                 str(self.source / 'session/factory.mjs'), *args], text=True, capture_output=True,
                                env={**self.env, 'POTS_ISOLATED_FACTORY': isolated}, timeout=40)
        if enrollment_refusal:
            error = 'explicit native squash enrollment'
        self.assertEqual(result.returncode, 1 if error else 0, result.stderr + result.stdout)
        if error:
            self.assertIn(error, result.stderr)
        return result.stdout

    def events(self, filename):
        path = self.root / f'{filename}.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def review(self, number, head=None):
        wakes = [wake for wake in self.events('wakes') if wake['number'] == number and (head is None or wake['head'] == head)]
        return wakes[-1]['commands']['verdict'].split()[-4]

    def squash(self, number):
        return json.loads((self.root / f'pull-{number}.json').read_text())['mergeCommit']['oid']

    def require_tag(self, squash, subject):
        ref = f'refs/tags/factory-release/{squash}'
        tag = POLICY['run']('git', '--git-dir', str(self.remote), 'rev-parse', ref)
        env = {**POLICY['FIXED_ENVIRONMENT'], 'GNUPGHOME': str(self.factory)}
        POLICY['run']('git', '--git-dir', str(self.remote), 'verify-tag', tag, environment=env)
        raw = POLICY['run']('git', '--git-dir', str(self.remote), 'cat-file', 'tag', tag)
        self.assertIn(f'\n\n{subject}\n\n', raw)
        return tag

    def prove_gate_refuses_requests(self):
        launch = self.source / 'session/launch.env'
        enabled = launch.read_text()
        launch.write_text(enabled.replace('POTS_LANDING_SQUASH_ENROLLED=1', 'POTS_LANDING_SQUASH_ENROLLED=0'))
        try:
            self.command('scan', enrollment_refusal=True)
        finally:
            launch.write_text(enabled)
        channel = self.source / 'session/factory-channel'
        attempted = subprocess.run([sys.executable, str(channel), 'landing'], input=json.dumps(self.request),
                                   env=self.env, capture_output=True, text=True, check=False, timeout=10)
        self.assertEqual(attempted.returncode, 1)
        self.assertIn('expected the enrolled native squash evidence operation', attempted.stderr)
        self.assertFalse((self.root / 'state/squash-release.json').exists())
        self.assertEqual(self.events('merges'), [])

    def prove_first_release(self):
        self.command('scan')
        hook = self.write_hook('pre-receive', '#!/bin/sh\nexit 1\n')
        (self.root / 'lose-merge-response').touch()
        self.command('review', self.review(30), 'verdict', 'PASS', error='pre-receive hook declined')
        self.assertEqual(self.events('reports'), [])
        receipt = json.loads((self.root / 'state/squash-release.json').read_text())
        hook.unlink()
        (self.root / 'lose-merge-response').unlink()
        (self.root / 'lose-report-response').touch()
        self.command('scan', error='lost the report response')
        first = self.squash(30)
        self.assertEqual(self.events('merges'), [first])
        self.assertEqual(self.require_tag(first, 'Factory squash evidence v1'), receipt['tag'])
        self.assertEqual(len(self.events('reports')), 1)
        self.command('scan')
        self.assertEqual(len(self.events('reports')), 1)

    def prove_race_and_continuation(self):
        base = self.squash(30)
        original = self.open_pull(31, base, 'original')
        self.open_pull(32, base, 'intervening')
        self.command('scan')
        (self.root / 'race').write_text(self.review(32))
        self.command('review', self.review(31, original), 'verdict', 'PASS')
        landed, parent = self.squash(31), self.squash(32)
        self.command('scan')
        self.assertEqual(self.events('checks')[-1], {'head': landed, 'base': parent})
        self.assertEqual(len(self.events('reports')), 2)
        fresh = self.review(31, landed)
        self.assertNotEqual(fresh, self.review(31, original))
        pull_path = self.root / 'pull-31.json'
        original_facts = json.loads(pull_path.read_text())
        pull_path.write_text(json.dumps({**original_facts, 'baseRefName': 'elsewhere'}))
        self.command('review', fresh, 'verdict', 'PASS', error='merged PR or landed recovery tuple changed')
        pull_path.write_text(json.dumps(original_facts))
        self.assertIn('original', self.command('review', fresh, 'show'))
        self.command('review', fresh, 'verdict', 'PASS')
        self.command('scan')
        tag = self.require_tag(landed, 'Factory squash recovery v1')
        receipt = json.loads((self.root / 'state/squash-release.json').read_text())
        self.assertEqual(receipt['tag'], tag)
        self.assertEqual(receipt['request']['original']['head'], original)
        self.assertEqual(receipt['request']['landed'], {'head': landed, 'base': parent, 'generation': 0,
                         'tree': POLICY['run']('git', '--git-dir', str(self.remote), 'rev-parse', f'{landed}^{{tree}}')})
        self.open_pull(33, landed, 'next')
        self.command('scan')
        self.command('review', self.review(33), 'verdict', 'PASS')
        self.require_tag(self.squash(33), 'Factory squash evidence v1')
        self.assertEqual(len(self.events('reports')), 4)
        self.assertEqual(len(self.events('merges')), 4)

    def prove_failed_landed_check(self):
        base = self.squash(33)
        self.open_pull(34, base, 'left')
        self.open_pull(35, base, 'right')
        self.command('scan')
        (self.root / 'race').write_text(self.review(35))
        self.command('review', self.review(34), 'verdict', 'PASS')
        self.command('scan')
        landed, parent = self.squash(34), self.squash(35)
        self.assertEqual(self.events('checks')[-1], {'head': landed, 'base': parent})
        self.assertFalse(any(wake['head'] == landed for wake in self.events('wakes')))
        self.assertEqual(self.git('ls-remote', '--refs', str(self.remote), f'refs/tags/*/{landed}'), '')
        self.assertIn('landed tree checks did not pass', self.events('reports')[-1]['text'])

    def saved_review(self, number, head=None):
        review_id = self.review(number, head)
        store = self.root / '.config/agent-sandbox/factory'
        binding = json.loads((store / 'reviews' / f'{review_id}.json').read_text())
        key = f"{binding['repository'].replace('/', '-')}-{number}-{binding['head']}"
        record = json.loads((store / 'heads' / f'{key}.json').read_text())
        return {'reviewId': review_id, 'review': record}

    def checkpoint(self, number):
        bound = self.saved_review(number, json.loads((self.root / f'pull-{number}.json').read_text())['headRefOid'])
        record = bound['review']
        self.assertEqual(record['stage'], 'published')
        publication = record.pop('squashPublication')
        record['stage'] = 'merged'
        tag = publication['release']
        row = {**bound, 'request': publication['request'], 'squash': record['mergeCommit'], 'tagObject': tag['tag']}
        if 'landed' in tag['request']:
            row.update(landed=tag['request']['landed'], recovery=self.saved_review(number, row['squash']))
        return row

    def export_checkpoints(self):
        checkpoints = [self.checkpoint(number) for number in (30, 32, 31, 33)]
        proof = SQUASH['export_checkpoints'](self, self.output, REVIEW_SOURCE, checkpoints)
        (self.output / 'squashes.json').write_text(json.dumps(proof, indent=2) + '\n')
        SQUASH['verify_proof'](self.output, proof, RECOVERY['verify_row'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--export', type=lambda value: Path(value).resolve())
    args = parser.parse_args()
    suite = unittest.TestSuite([LandingEntry(args.export)])
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
