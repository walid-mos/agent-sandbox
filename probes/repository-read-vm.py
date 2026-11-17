#!/usr/bin/env python3
import base64
import contextlib
import http.server
import json
import os
from pathlib import Path
import pwd
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from repository_read_fixture import REPOSITORY, TOKEN, POLICY, broker_socket, fixture_commits, load_broker
from repository_import import import_repository
from repository_git import git
from vault_policy import Refused

ACCOUNT = 'pots-repository-read'


class GitHubFixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.respond()

    def do_POST(self):
        self.respond()

    def log_message(self, *arguments):
        pass

    def respond(self):
        expected = 'Basic ' + base64.b64encode(f'x-access-token:{TOKEN}'.encode()).decode()
        is_authenticated = self.headers.get('Authorization') == expected
        self.server.requests.append((self.path, is_authenticated))
        self.observe_workers()
        if self.server.is_redirecting:
            self.send_response(302)
            self.send_header('Location', 'https://unselected.invalid/reference.git')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if not is_authenticated or self.server.is_refusing:
            self.send_response(401)
            self.send_header('WWW-Authenticate', 'Basic realm="fixture"')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        path, _, query = self.path.partition('?')
        length = int(self.headers.get('Content-Length', '0'))
        environment = {'PATH': '/usr/bin:/bin', 'GIT_PROJECT_ROOT': str(self.server.repositories), 'GIT_HTTP_EXPORT_ALL': '1',
                       'REQUEST_METHOD': self.command, 'PATH_INFO': path, 'QUERY_STRING': query,
                       'CONTENT_TYPE': self.headers.get('Content-Type', ''), 'CONTENT_LENGTH': str(length), 'REMOTE_USER': 'fixture'}
        response = subprocess.run(['/usr/lib/git-core/git-http-backend'], env=environment, input=self.rfile.read(length),
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        self.server.responses.append(response.stderr.decode())
        headers, body = response.stdout.split(b'\r\n\r\n', 1)
        self.server.responses.append(headers.decode())
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        for header in headers.decode().splitlines():
            name, value = header.split(':', 1)
            self.send_header(name, value.strip())
        self.end_headers()
        self.wfile.write(body)

    def observe_workers(self):
        for process in Path('/proc').glob('[0-9]*'):
            try:
                command = (process / 'cmdline').read_bytes().split(b'\0')
                self.server.has_token_in_argv |= any(TOKEN.encode() in argument for argument in command)
                if not any(argument.endswith(b'/lib/repository_bundle.py') for argument in command):
                    continue
                status = (process / 'status').read_text().splitlines()
                uid = next(line.split()[1:] for line in status if line.startswith('Uid:'))
                self.server.worker_uids.append(uid)
            except (OSError, StopIteration):
                continue


@contextlib.contextmanager
def github_fixture(root):
    certificate, key = root / 'certificate.pem', root / 'key.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=github.com',
                    '-addext', 'subjectAltName=DNS:github.com', '-keyout', str(key), '-out', str(certificate)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with open('/etc/ssl/certs/ca-certificates.crt', 'ab') as trust:
        trust.write(certificate.read_bytes())
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate, key)
    with http.server.ThreadingHTTPServer(('127.0.0.1', 443), GitHubFixture) as server:
        server.socket = context.wrap_socket(server.socket, server_side=True)
        server.repositories = root / 'repositories'
        server.requests = []
        server.worker_uids = []
        server.has_token_in_argv = False
        server.responses = []
        server.is_refusing = False
        server.is_redirecting = False
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server
        finally:
            server.shutdown()
            thread.join()


@contextlib.contextmanager
def poisoned_environment(root):
    executable = root / 'git'
    executable.write_text(f'#!/bin/sh\ntouch {root / "executed"}\nexit 91\n')
    executable.chmod(0o700)
    config = root / 'poison-config'
    config.write_text(f'[credential]\nhelper=!{executable}\n[core]\nfsmonitor={executable}\n[url "https://unselected.invalid/"]\ninsteadOf=https://github.com/\n')
    with patch.dict(os.environ, {'PATH': str(root), 'HOME': str(root), 'GIT_CONFIG_GLOBAL': str(config),
                                'GIT_EXEC_PATH': str(root), 'GIT_ASKPASS': str(executable), 'HTTPS_PROXY': 'http://unselected.invalid'}):
        yield


def configured_broker(root):
    broker = load_broker()
    broker.CONFIG_DIRECTORY = root
    (root / 'sandbox.json').write_text(json.dumps(POLICY))
    (root / 'vault.json').write_text(json.dumps({'project': 'fixture', 'environment': 'fixture'}))
    broker.read_identity = lambda: {'fixture': True}
    broker.access_token = lambda identity: 'invented-vault-access'
    broker.secret_value = lambda *arguments: TOKEN
    return broker


class VMReadTests(unittest.TestCase):
    def test_broker_fetches_with_dedicated_account_and_returns_only_objects(self):
        with tempfile.TemporaryDirectory(prefix='repository-read-vm-') as directory:
            root = Path(directory)
            remote = root / 'repositories' / f'{REPOSITORY}.git'
            remote.mkdir(parents=True)
            commits = fixture_commits(remote)
            git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
            broker = configured_broker(root)
            request = {'kind': 'read', 'repository': REPOSITORY, 'commits': commits}
            directories_before = set(Path('/tmp').glob('repository-read-*'))
            with github_fixture(root) as server:
                try:
                    with poisoned_environment(root):
                        reply = broker.answer(request)
                except Refused as error:
                    self.fail(f'{error} Fixture requests: {server.requests}, responses: {server.responses}')
                self.assert_read_boundary(root, server, reply)
                imported = root / 'imported'
                with broker_socket(root, lambda request: reply) as endpoint:
                    self.assertEqual(import_repository(request, imported, endpoint), [(commit, 'commit') for commit in commits])
                server.is_refusing = True
                with self.assertRaisesRegex(Refused, 'GitHub refused this token'):
                    broker.answer(request)
                server.is_redirecting = True
                before = len(server.requests)
                with self.assertRaisesRegex(Refused, 'Git read failed'):
                    broker.answer(request)
                self.assertEqual(server.requests[before:], [(f'/{REPOSITORY}.git/info/refs?service=git-upload-pack', False)])
                self.assertEqual(set(Path('/tmp').glob('repository-read-*')), directories_before)

    def assert_read_boundary(self, root, server, reply):
        self.assertEqual(set(reply), {'ok', 'bundle'})
        self.assertFalse((root / 'executed').exists())
        self.assertFalse(server.has_token_in_argv)
        self.assertNotIn(TOKEN.encode(), base64.b64decode(reply['bundle'], validate=True))
        self.assertTrue(any(authenticated for _, authenticated in server.requests))
        expected_uid = str(pwd.getpwnam(ACCOUNT).pw_uid)
        self.assertGreater(len(server.worker_uids), 0)
        self.assertTrue(all(uids == [expected_uid] * 4 for uids in server.worker_uids))
        self.assertTrue(all(path.startswith(f'/{REPOSITORY}.git/') for path, _ in server.requests))


if __name__ == '__main__':
    if os.geteuid() != 0 or os.environ.get('REPOSITORY_READ_DISPOSABLE_VM') != '1':
        sys.exit('Run this probe only in its disposable factory-image container, as documented.')
    subprocess.run(['/usr/sbin/useradd', '--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', ACCOUNT], check=True)
    unittest.main()
