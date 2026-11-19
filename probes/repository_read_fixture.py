import contextlib
import importlib.machinery
import importlib.util
import http.server
import json
import os
from pathlib import Path
import socketserver
import sys
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'lib'), str(ROOT / 'vm')]
from repository_bundle import build_bundle
from repository_git import GIT, ISOLATED_OPTIONS, environment, git

REPOSITORY = 'ExampleOrg/reference'
TOKEN = 'invented-read-credential'
POLICY = {'readRepositories': {REPOSITORY: {'credential': 'GITHUB_TOKEN_REFERENCE'}}}


def load_broker():
    loader = importlib.machinery.SourceFileLoader('fixture_broker', str(ROOT / 'vm/vault-broker'))
    specification = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(specification)
    loader.exec_module(module)
    return module


def fixture_commits(directory):
    git(directory, 'init', '--bare', '--quiet', '--initial-branch=main')
    tree = git(directory, 'mktree').strip().decode()
    commits = []
    for index in range(6):
        payload = f'tree {tree}\nauthor Fixture <fixture@example.invalid> 170000000{index} +0000\ncommitter Fixture <fixture@example.invalid> 170000000{index} +0000\n\nobject {index}\n'
        commit = subprocess.run([GIT, *ISOLATED_OPTIONS, '-C', str(directory), 'hash-object', '-t', 'commit', '-w', '--stdin'],
                                input=payload.encode(), env=environment(directory), check=True, stdout=subprocess.PIPE).stdout.strip().decode()
        commits.append(commit)
    git(directory, 'update-ref', 'refs/heads/main', commits[0])
    git(directory, 'update-ref', 'refs/tags/release', commits[1])
    return commits


class LocalRemote:
    def __init__(self, remote):
        self.remote = remote
        self.network_calls = []

    def __call__(self, directory, *arguments, credential=None, **keywords):
        if 'fetch' not in arguments:
            return git(directory, *arguments, **keywords)
        assert credential == (REPOSITORY, TOKEN)
        assert TOKEN not in ' '.join(arguments)
        url = f'https://github.com/{REPOSITORY}.git'
        assert url in arguments
        self.network_calls.append(url)
        mapped = [str(self.remote) if argument == url else argument for argument in arguments]
        return git(directory, '-c', 'protocol.file.allow=always', *mapped, **keywords)


@contextlib.contextmanager
def fixture():
    with tempfile.TemporaryDirectory(prefix='repository-read-proof-') as directory:
        root = Path(directory)
        remote = root / 'remote'
        remote.mkdir()
        commits = fixture_commits(remote)
        yield root, commits, LocalRemote(remote)


@contextlib.contextmanager
def http_remote(status):
    requests = []
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append((self.path, dict(self.headers)))
            self.send_response(status)
            self.send_header('Location', '/redirect-target')
            self.send_header('WWW-Authenticate', 'Basic realm="fixture"')
            self.end_headers()
        def log_message(self, *arguments):
            pass
    with http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        endpoint = f'http://127.0.0.1:{server.server_port}/reference.git'
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield endpoint, requests
        finally:
            server.shutdown()
            thread.join()


@contextlib.contextmanager
def broker_socket(root, answer):
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            request = json.loads(self.rfile.readline())
            self.wfile.write((json.dumps(answer(request)) + '\n').encode())
    endpoint = root / 'broker.sock'
    with socketserver.UnixStreamServer(str(endpoint), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield endpoint
        finally:
            server.shutdown()
            thread.join()
            endpoint.unlink()
