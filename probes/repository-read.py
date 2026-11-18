#!/usr/bin/env python3
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch

from repository_read_fixture import ROOT, POLICY, REPOSITORY, TOKEN, broker_socket, fixture, http_remote, load_broker
from repository_bundle import build_bundle
from repository_git import GitFailure, git
from repository_import import import_repository
from read_credential import answer as credential_answer
from vault_policy import Refused


class RepositoryReadTests(unittest.TestCase):
    def test_command_fetches_six_named_commits_and_imports_offline(self):
        with fixture() as (root, commits, remote):
            work = root / 'fetch'
            work.mkdir()
            bundle = build_bundle(work, REPOSITORY, commits, TOKEN, run=remote)
            broker = load_broker()
            broker.SOCKET = root / 'broker.sock'
            with patch.object(broker, 'read_root_json', return_value=POLICY), patch.object(broker, 'secret_values', return_value=[['GITHUB_TOKEN_REFERENCE', TOKEN]]), patch('repository_read.fetch', return_value=bundle):
                reply = broker.answer({'kind': 'read', 'repository': REPOSITORY, 'commits': commits})
            self.assertEqual(set(reply), {'ok', 'bundle'})
            self.assertNotIn(TOKEN, json.dumps(reply))
            with broker_socket(root, lambda request: reply) as endpoint:
                imported = import_repository({'kind': 'read', 'repository': REPOSITORY, 'commits': commits}, root / 'imported', endpoint)
            self.assertEqual(imported, [(commit, 'commit') for commit in commits])
            self.assertEqual(git(root / 'imported', 'remote'), b'')
            self.assertEqual(git(root / 'imported', 'show-ref', '--verify', 'refs/tags/release').split()[0].decode(), commits[1])
            self.assertFalse((root / 'imported' / 'objects.bundle').exists())
            self.assertEqual(len(remote.network_calls), 7)
            command = root / 'command'
            (command / 'session').mkdir(parents=True)
            shutil.copy(ROOT / 'session/repository-read', command / 'session/repository-read')
            shutil.copytree(ROOT / 'lib', command / 'lib', ignore=shutil.ignore_patterns('__pycache__'))
            shutil.copytree(ROOT / 'vm', command / 'vm', ignore=shutil.ignore_patterns('__pycache__'))
            with broker_socket(root, lambda request: reply) as endpoint:
                (command / 'session/launch.env').write_text(f'POTS_VAULT_SOCKET={endpoint}\n')
                result = subprocess.run([str(command / 'session/repository-read'), REPOSITORY, str(root / 'command-import'), *commits], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines(), [f'{commit} commit' for commit in commits])

    def test_refusals_precede_vault_and_network(self):
        broker = load_broker()
        request = {'kind': 'read', 'repository': REPOSITORY, 'commits': []}
        attacks = [{**request, 'repository': key} for key in ['ExampleOrg/other', 'Other/reference', 'https://github.com.evil/x/y', 'file:///x', 'git@github.com:x/y', 'exampleorg/reference']]
        attacks += [{**request, 'commits': ['bad']}, {**request, 'public': True}, {**request, 'args': ['push']}, {**request, 'url': 'https://evil.invalid'}]
        with patch.object(broker, 'read_root_json', return_value=POLICY), patch.object(broker, 'secret_values') as vault, patch('repository_read.fetch') as network:
            for attack in attacks:
                with self.subTest(attack=attack), self.assertRaises(Refused):
                    broker.answer(attack)
            vault.assert_not_called()
            network.assert_not_called()

    def test_existing_and_symlink_destinations_never_contact_broker(self):
        with fixture() as (root, commits, remote):
            destination = root / 'existing'
            destination.mkdir()
            (destination / 'config').write_text('[include]\npath=/evil\n')
            (root / 'linked').symlink_to(destination)
            request = {'kind': 'read', 'repository': REPOSITORY, 'commits': []}
            for path in [destination, root / 'linked', root / 'linked' / 'nested']:
                with self.subTest(path=path), patch('repository_import.ask_bundle') as network, self.assertRaises((OSError, Refused)):
                    import_repository(request, path, root / 'absent.sock')
                network.assert_not_called()
            self.assertEqual((destination / 'config').read_text(), '[include]\npath=/evil\n')

    def test_missing_named_commit_is_reported_without_credential_or_git_output(self):
        with fixture() as (root, commits, remote):
            work = root / 'fetch'
            work.mkdir()
            missing = 'f' * 40
            with self.assertRaisesRegex(GitFailure, f'Commit {missing} is unavailable'):
                build_bundle(work, REPOSITORY, [missing], TOKEN, run=remote)

    def test_helper_only_answers_selected_https_path(self):
        environment = {'REPOSITORY_READ_KEY': REPOSITORY, 'REPOSITORY_READ_TOKEN': TOKEN}
        good = f'protocol=https\nhost=github.com\npath={REPOSITORY}.git\n'
        self.assertIn(f'password={TOKEN}', credential_answer('get', good, environment))
        for request in [good.replace('https', 'http'), good.replace('github.com', 'github.com.evil'), good.replace('/reference', '/other'), good.replace('ExampleOrg', 'Other')]:
            self.assertEqual(credential_answer('get', request, environment), '')
        self.assertEqual(credential_answer('store', good, environment), '')
        self.assertEqual(credential_answer('get', good, {**environment, 'REPOSITORY_READ_TOKEN': TOKEN + '\npoison'}), '')

    def test_redirects_and_authenticated_refusals_never_fallback_or_disclose(self):
        for status, message in [(302, 'Git read failed'), (401, 'GitHub refused this token')]:
            with self.subTest(status=status), fixture() as (root, commits, remote), http_remote(status) as (endpoint, requests):
                work = root / 'fetch'
                work.mkdir()
                git(work, 'init', '--bare', '--quiet')
                with self.assertRaisesRegex(GitFailure, message):
                    git(work, '-c', 'protocol.http.allow=always', 'fetch', '--', endpoint, credential=(REPOSITORY, TOKEN))
                self.assertEqual(len(requests), 1)
                self.assertNotIn('/redirect-target', requests[0][0])
                self.assertNotIn('Authorization', requests[0][1])
                self.assertNotIn(TOKEN, json.dumps(requests))

    def test_poisoned_environment_config_hooks_and_executable_overrides_do_not_run(self):
        with fixture() as (root, commits, remote):
            marker = root / 'executed'
            poison = root / 'git'
            poison.write_text(f'#!/bin/sh\ntouch {marker}\nexit 91\n')
            poison.chmod(0o700)
            config = root / 'poison-config'
            config.write_text(f'[include]\npath={root / "include"}\n[credential]\nhelper=!{poison}\n[url "https://evil.invalid/"]\ninsteadOf=https://github.com/\n[core]\nhooksPath={root}\nfsmonitor={poison}\n')
            (root / 'include').write_text(f'[core]\nfsmonitor={poison}\n')
            shutil.copy(poison, root / 'post-fetch')
            work = root / 'fetch'
            work.mkdir()
            environment = {'PATH': str(root), 'HOME': str(root), 'GIT_CONFIG_GLOBAL': str(config), 'GIT_CONFIG_SYSTEM': str(config),
                           'GIT_EXEC_PATH': str(root), 'GIT_SSH_COMMAND': str(poison), 'GIT_ASKPASS': str(poison), 'GIT_TEMPLATE_DIR': str(root),
                           'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'core.fsmonitor', 'GIT_CONFIG_VALUE_0': str(poison),
                           'LD_PRELOAD': str(poison), 'BASH_ENV': str(poison), 'HTTPS_PROXY': 'https://evil.invalid'}
            with patch.dict(os.environ, environment):
                bundle = build_bundle(work, REPOSITORY, commits, TOKEN, run=remote)
            self.assertGreater(len(bundle), 0)
            self.assertFalse(marker.exists())
            self.assertNotIn(TOKEN.encode(), bundle)


if __name__ == '__main__':
    unittest.main()
