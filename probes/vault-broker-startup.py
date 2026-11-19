#!/usr/bin/env python3
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import socket
import socketserver
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

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


class BrokerStartupTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory(prefix='broker-startup-')))
        self.endpoint = self.root / 'socket' / 'vault.sock'
        self.script = self.root / 'vm' / 'vault-broker'
        self.script.parent.mkdir()
        shutil.copyfile(ROOT / 'vm/vault-broker', self.script)
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
            return io.BytesIO(b'{"accessToken":"fixture-session"}')
        self.assertEqual(request.get_header('Authorization'), 'Bearer fixture-session')
        values = {'OWNER_FIXTURE': 'owner-value', 'SOURCE_FIXTURE': 'source-value', 'GITHUB_TOKEN_REFERENCE': 'read-value'}
        name = url.path.removeprefix('/v3/secrets/raw/')
        return io.BytesIO(json.dumps({'secret': {'secretValue': values[name]}}).encode())

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
        with patch.dict(os.environ, environment, clear=True):
            runpy.run_path(str(self.script), run_name='__main__')
        self.serve_requests.assert_called_once()

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


if __name__ == '__main__':
    unittest.main()
