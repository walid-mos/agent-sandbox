import json
import os
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

from fixture import EXPECTED, ORIGINAL, Fixture, digest, git, write_json


class GuardTests(unittest.TestCase):
    def test_snapshot_keeps_the_pinned_read_only_mode_and_backups_are_private(self):
        fixture = Fixture(self)
        result = fixture.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((fixture.directory / 'client-rules.md').stat().st_mode & 0o777, 0o444)
        for path in fixture.journal.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(fixture.journal.stat().st_mode & 0o777, 0o700)

    def test_scope_hold_cutoff_and_pending_destinations_refuse_before_side_effects(self):
        mutations = ('future-window', 'scope', 'hold', 'bad-proof-scope', 'symlink', 'pending', 'identity')
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.check_precondition(mutation)

    def check_precondition(self, mutation):
        fixture = Fixture(self)
        if mutation == 'future-window':
            fixture.contract['notBefore'] = int(time.time()) + 3600
        if mutation == 'scope':
            fixture.contract['scope'] = 'models-too'
        if mutation == 'hold':
            proof = json.loads(fixture.proof.read_bytes())
            proof['isHeld'] = False
            write_json(fixture.proof, proof)
        if mutation == 'bad-proof-scope':
            fixture.contract['ownerRoute'] = ''
        if mutation == 'symlink':
            fixture.original.unlink()
            fixture.original.symlink_to(fixture.target)
        if mutation == 'pending':
            write_json(fixture.directory / 'client-rules.json', {'isPending': True})
        if mutation == 'identity':
            git(fixture.private, 'config', '--unset', 'user.email')
        self.assertNotEqual(fixture.run().returncode, 0)
        self.assertFalse((fixture.private / 'rules/AGENTS.md').exists())
        self.assertFalse(fixture.journal.exists())
        fixture.scratch.cleanup()

    def test_all_observed_executions_are_local_git_or_the_pinned_store(self):
        fixture = Fixture(self)
        self.assertEqual(fixture.run().returncode, 0)
        calls = [json.loads(line) for line in (fixture.root / 'fixture-audit.jsonl').read_text().splitlines()]
        self.assertGreater(len(calls), 10)
        self.assertEqual({call['executable'] for call in calls}, {'git', 'pinned-store-config'})
        self.assertTrue(all(call['networkAllowed'] is False for call in calls))

    def test_hooks_shell_startup_and_inherited_git_commands_cannot_run(self):
        fixture = Fixture(self)
        marker = fixture.root / 'ATTACK-RAN'
        attack = fixture.root / 'attack.sh'
        attack.write_text(f'#!/bin/sh\ntouch {marker}\n')
        attack.chmod(0o700)
        for name in ('pre-commit', 'post-checkout'):
            hook = fixture.private / '.git/hooks' / name
            hook.write_bytes(attack.read_bytes())
            hook.chmod(0o700)
        injected = {'BASH_ENV': str(attack), 'ENV': str(attack), 'GIT_CONFIG_COUNT': '1',
                    'GIT_CONFIG_KEY_0': 'core.hooksPath', 'GIT_CONFIG_VALUE_0': str(fixture.private / '.git/hooks')}
        with patch.dict(os.environ, injected):
            result = fixture.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(marker.exists())

    def test_recipe_with_matching_hash_but_invalid_anchors_still_refuses(self):
        fixture = Fixture(self)
        recipe_path = fixture.private / 'rules/import.json'
        recipe = json.loads(recipe_path.read_bytes())
        recipe['replacements'][0]['before'] = 'missing anchor\n'
        write_json(recipe_path, recipe)
        git(fixture.private, 'add', '.')
        git(fixture.private, 'commit', '-qm', 'chore: invalid synthetic anchor')
        fixture.contract['privateHead'] = git(fixture.private, 'rev-parse', 'HEAD')
        fixture.options['recipeSha256'] = digest(recipe_path.read_bytes())
        result = fixture.run()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(fixture.original.read_bytes(), ORIGINAL)
        self.assertFalse(fixture.journal.exists())


if __name__ == '__main__':
    unittest.main()
