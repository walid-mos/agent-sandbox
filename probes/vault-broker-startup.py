#!/usr/bin/env python3
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import socket
import socketserver
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error
from urllib.parse import parse_qs, urlsplit

from repository_read_fixture import POLICY, REPOSITORY, ROOT
import vault_policy

SOURCE = 'ExampleOrg/catalog'
ROUTES = (
    ({'kind': 'ready'}, {'ok': True, 'ready': True}),
    ({'kind': 'sandbox'}, {'ok': True, 'secrets': [['OWNER_FIXTURE', 'owner-value']]}),
    ({'kind': 'secret', 'path': '/tools/github', 'name': 'OWNER_FIXTURE'},
     {'ok': True, 'secrets': [['OWNER_FIXTURE', 'owner-value']]}),
    ({'kind': 'source', 'repository': SOURCE}, {'ok': True, 'secrets': [['SOURCE_FIXTURE', 'source-value']]}),
)
READ = {'kind': 'read', 'repository': REPOSITORY, 'commits': []}
RAW_URL = 'https://vault.invalid/v3/secrets/raw?secretPath=/tools/github'
FOLDERS = {'/tools/github': {'OWNER_FIXTURE': 'owner-value', 'SOURCE_FIXTURE': 'source-value', 'GITHUB_TOKEN_REFERENCE': 'read-value'}}


class BrokerStartupTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory(prefix='broker-startup-')))
        self.endpoint = self.root / 'socket' / 'vault.sock'
        self.script = self.root / 'vm' / 'vault-broker'
        self.script.parent.mkdir()
        shutil.copyfile(ROOT / 'vm/vault-broker', self.script)
        library = self.root / 'lib'
        library.mkdir()
        shutil.copyfile(ROOT / 'lib/launch.py', library / 'launch.py')
        session = self.root / 'session'
        session.mkdir()
        identity = self.root / 'identity.json'
        (session / 'launch.env').write_text(f'POTS_VAULT_SOCKET={self.endpoint}\nPOTS_VAULT_IDENTITY={identity}\nPOTS_SESSION_CONFIGURATION={self.root}\n')
        self.write_json(identity, {'INFISICAL_API_URL': 'https://vault.invalid', 'INFISICAL_UNIVERSAL_AUTH_CLIENT_ID': 'fixture-id',
                                   'INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET': 'fixture-login'})
        self.write_json(self.root / 'vault.json', {'project': 'fixture', 'environment': 'test'})
        self.write_json(self.root / 'sandbox.json', {**POLICY, 'owners': {'ExampleOrg': 'OWNER_FIXTURE'}, 'sources': ['catalog']})
        self.write_json(session / 'agent-sources.json', {'catalog': {'repository': SOURCE, 'credential': 'SOURCE_FIXTURE'}})
        self.opener = Mock()
        self.opener.open.side_effect = self.vault_reply
        self.fetch = self.enterContext(patch('repository_read.fetch', return_value=b'fixture-bundle'))
        self.enterContext(patch('urllib.request.build_opener', return_value=self.opener))
        self.enterContext(patch.object(vault_policy, 'ROOT', os.geteuid()))
        self.serve_requests = self.enterContext(patch.object(socketserver.ThreadingUnixStreamServer, 'serve_forever', autospec=True, side_effect=self.check_routes))

    def write_json(self, path, value):
        path.touch(mode=0o600)
        path.write_text(json.dumps(value))

    def vault_reply(self, request, *, timeout):
        url = urlsplit(request.full_url)
        self.assertEqual(url.hostname, 'vault.invalid')
        if url.path == '/v1/auth/universal-auth/login':
            return io.BytesIO(b'{"accessToken":"fixture-session","expiresIn":3600}')
        self.assertEqual(url.path, '/v3/secrets/raw')
        self.assertEqual(request.get_header('Authorization'), 'Bearer fixture-session')
        secrets = [{'secretKey': key, 'secretValue': value} for key, value in FOLDERS[parse_qs(url.query)['secretPath'][0]].items()]
        return io.BytesIO(json.dumps({'secrets': secrets}).encode())

    def exchange(self, server, request):
        client, handler = socket.socketpair()
        with client, handler:
            client.settimeout(2)
            client.sendall((json.dumps(request) + '\n').encode())
            server.finish_request(handler, str(self.endpoint))
            with client.makefile() as replies:
                return json.loads(replies.readline())

    def check_routes(self, server):
        self.assertTrue(self.endpoint.is_socket())
        for request, expected in ROUTES:
            self.assertEqual(self.exchange(server, request), expected)
        self.opener.open.reset_mock()
        self.read_reply = self.exchange(server, READ)

    def start(self, environment):
        with patch.dict(os.environ, environment, clear=True), patch.dict(sys.modules):
            sys.modules.pop('launch', None)
            runpy.run_path(str(self.script), run_name='__main__')
        self.serve_requests.assert_called_once()

    def broker(self):
        return runpy.run_path(str(self.script))

    def rate_limited(self, seconds=None, retry_after=None):
        body = (f'{{"message": "Rate limit exceeded. Please try again in {seconds} seconds"}}' if seconds is not None else '').encode()
        headers = {'Retry-After': retry_after} if retry_after is not None else {}
        return urllib.error.HTTPError(RAW_URL, 429, 'Too Many Requests', headers, io.BytesIO(body))

    def serving(self, plan):
        remaining = list(plan)

        def reply(request, *, timeout):
            step = remaining.pop(0) if remaining else None
            if isinstance(step, BaseException):
                raise step
            return self.vault_reply(request, timeout=timeout)
        return reply

    def assert_reads_refused(self, message):
        self.assertFalse(self.read_reply['ok'])
        self.assertIn(message, self.read_reply['error'])
        self.opener.open.assert_not_called()
        self.fetch.assert_not_called()

    def test_old_unit_without_runtime_directory_keeps_existing_routes_available(self):
        self.start({})
        self.assert_reads_refused('read state directory is not configured')

    def test_relative_runtime_directory_keeps_existing_routes_available(self):
        self.start({'RUNTIME_DIRECTORY': 'relative'})
        self.assert_reads_refused('read state directory is not configured')

    def test_missing_runtime_directory_keeps_existing_routes_available(self):
        state = self.root / 'missing'
        self.start({'RUNTIME_DIRECTORY': str(state)})
        self.assert_reads_refused('cleanup could not be confirmed')
        self.assertFalse(state.exists())

    def test_unprotected_runtime_directory_keeps_existing_routes_available(self):
        state = self.root / 'not-private'
        state.mkdir()
        state.chmod(0o755)
        self.start({'RUNTIME_DIRECTORY': str(state)})
        self.assert_reads_refused('cleanup could not be confirmed')
        self.assertEqual(list(state.iterdir()), [])

    def test_protected_runtime_directory_allows_bundle_read_and_existing_routes(self):
        state = self.root / 'read-state'
        state.mkdir(mode=0o711)
        self.start({'RUNTIME_DIRECTORY': str(state)})
        self.assertEqual(self.read_reply, {'ok': True, 'bundle': 'Zml4dHVyZS1idW5kbGU='})
        self.fetch.assert_called_once_with(READ, 'read-value', state)
        self.assertEqual(list(state.iterdir()), [])

    def test_local_read_failure_is_reported_without_private_details(self):
        state = self.root / 'read-state'
        state.mkdir(mode=0o711)
        self.fetch.side_effect = OSError('private detail')
        self.start({'RUNTIME_DIRECTORY': str(state)})
        self.assertEqual(self.read_reply, {
            'ok': False,
            'error': 'Repository read could not prepare or run the worker. Ask the VM operator to check the broker.',
        })
        self.assertEqual(list(state.iterdir()), [])

    def test_rate_limited_call_waits_the_stated_seconds_and_answers(self):
        broker = self.broker()
        self.opener.open.side_effect = self.serving([self.rate_limited(seconds=3)])
        with patch('time.sleep') as sleep:
            answer = broker['vault_call'](RAW_URL, token='fixture-session')
        sleep.assert_called_once_with(3)
        self.assertEqual([secret['secretKey'] for secret in answer['secrets']], list(FOLDERS['/tools/github']))

    def test_retry_waits_the_longer_wait_stated_by_the_body_and_the_header(self):
        broker = self.broker()
        self.opener.open.side_effect = self.serving([self.rate_limited(seconds=3, retry_after='7')])
        with patch('time.sleep') as sleep:
            broker['vault_call'](RAW_URL, token='fixture-session')
        sleep.assert_called_once_with(7)

    def test_retry_honours_a_retry_after_header_alone(self):
        broker = self.broker()
        self.opener.open.side_effect = self.serving([self.rate_limited(retry_after='5')])
        with patch('time.sleep') as sleep:
            broker['vault_call'](RAW_URL, token='fixture-session')
        sleep.assert_called_once_with(5)

    def test_rate_limit_stops_at_the_retry_bound_and_keeps_the_refusal(self):
        broker = self.broker()
        self.opener.open.side_effect = self.serving([None] + [self.rate_limited(seconds=1) for _ in range(3)])
        with patch('time.sleep') as sleep:
            with self.assertRaises(broker['VaultFailure']) as refusal:
                broker['secret_values']([('/tools/github', 'OWNER_FIXTURE')])
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(str(refusal.exception), 'the vault answered HTTP 429 for OWNER_FIXTURE in /tools/github.')
        self.assertEqual(len(self.opener.open.call_args_list), 4)

    def test_wait_beyond_the_budget_is_refused_without_waiting(self):
        broker = self.broker()
        self.opener.open.side_effect = self.serving([self.rate_limited(seconds=90)])
        with patch('time.sleep') as sleep:
            with self.assertRaises(urllib.error.HTTPError):
                broker['vault_call'](RAW_URL, token='fixture-session')
        sleep.assert_not_called()
        self.assertEqual(len(self.opener.open.call_args_list), 1)

    def test_retries_that_together_exceed_the_budget_stop(self):
        broker = self.broker()
        self.opener.open.side_effect = self.serving([self.rate_limited(seconds=40), self.rate_limited(seconds=40)])
        with patch('time.sleep') as sleep:
            with self.assertRaises(urllib.error.HTTPError):
                broker['vault_call'](RAW_URL, token='fixture-session')
        sleep.assert_called_once_with(40)
        self.assertEqual(len(self.opener.open.call_args_list), 2)

    def test_normal_call_logs_in_once_and_reads_one_folder_per_invocation(self):
        broker = self.broker()
        values = broker['secret_values']([('/tools/github', 'OWNER_FIXTURE'), ('/tools/github', 'SOURCE_FIXTURE')])
        broker['secret_values']([('/tools/github', 'GITHUB_TOKEN_REFERENCE')])
        paths = [urlsplit(call.args[0].full_url).path for call in self.opener.open.call_args_list]
        self.assertEqual(values, [['OWNER_FIXTURE', 'owner-value'], ['SOURCE_FIXTURE', 'source-value']])
        self.assertEqual(paths, ['/v1/auth/universal-auth/login', '/v3/secrets/raw', '/v3/secrets/raw'])

    def test_name_absent_from_the_folder_listing_is_reported_as_missing(self):
        broker = self.broker()
        with self.assertRaises(broker['VaultFailure']) as refusal:
            broker['secret_values']([('/tools/github', 'ABSENT_FIXTURE')])
        self.assertEqual(str(refusal.exception), "ABSENT_FIXTURE not found in /tools/github. Add it to the vault or remove it from the sandbox's list.")


if __name__ == '__main__':
    unittest.main()
