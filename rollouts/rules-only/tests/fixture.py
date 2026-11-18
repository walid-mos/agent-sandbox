import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

from ownership import OwnedFixture

AREA = Path(__file__).resolve().parents[1]
ROOT = AREA.parents[1]
BASE = '6d71925e5467b58e7a935498c5a271cf5a9c059b'
ORIGINAL = b'# Invented client\nKeep approvals.\nUse fixed ports.\nUnrelated UTF-8: \xc3\xa9.  \n'
EXPECTED = b'# Invented client\nKeep approvals.\nUse allocated ports.\nUnrelated UTF-8: \xc3\xa9.  \n'


def digest(content):
    return hashlib.sha256(content).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value))
    path.chmod(0o600)


def git(path, *arguments):
    result = subprocess.run(['git', '-C', str(path), *arguments], check=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return result.stdout.decode().strip()


class Fixture:
    def __init__(self, case):
        self.scratch = OwnedFixture(case)
        self.root = Path(self.scratch.name).resolve()
        self.root.chmod(0o700)
        self.run_id = self.root.name
        self.checkout = self.root / 'mac'
        self.vm = self.root / 'vm'
        self.private = self.root / 'private'
        self.runtime = self.root / 'runtime'
        self.directory = self.runtime / 'sandboxes/accor'
        self.installed = self.root / 'installed'
        self.original = self.root / 'original.md'
        self.journal = self.root / 'journal'
        self.original.write_bytes(ORIGINAL)
        for directory in (self.checkout, self.vm, self.private / 'rules', self.directory, self.installed):
            directory.mkdir(parents=True)
        self.populate_sources()
        self.populate_private()
        self.populate_configuration()
        self.populate_contract()

    def populate_sources(self):
        archive = subprocess.run(['git', '-C', str(ROOT), 'archive', BASE], check=True,
                                 stdout=subprocess.PIPE).stdout
        for directory in (self.checkout, self.vm):
            subprocess.run(['tar', '-xf', '-', '-C', str(directory)], input=archive, check=True)
        git(self.checkout, 'init', '-q', '-b', 'main')
        git(self.checkout, 'config', 'user.name', 'Synthetic operator')
        git(self.checkout, 'config', 'user.email', 'fixture@example.invalid')
        git(self.checkout, 'add', '.')
        git(self.checkout, 'commit', '-qm', 'chore: synthetic source')

    def populate_private(self):
        plan = {'inputSha256': digest(ORIGINAL), 'replacements': [
            {'before': 'Use fixed ports.\n', 'after': 'Use allocated ports.\n'}]}
        write_json(self.private / 'rules/import.json', plan)
        git(self.private, 'init', '-q', '-b', 'main')
        git(self.private, 'config', 'user.name', 'Synthetic operator')
        git(self.private, 'config', 'user.email', 'fixture@example.invalid')
        git(self.private, 'remote', 'add', 'origin', 'https://github.com/walid-mos/agent-pi-accor.git')
        git(self.private, 'add', '.')
        git(self.private, 'commit', '-qm', 'chore: synthetic recipe')

    def populate_configuration(self):
        self.target = self.installed / 'RULES.md'
        self.target.write_bytes(ORIGINAL)
        self.loaded = self.root / 'AGENTS.md'
        self.loaded.symlink_to(self.target)
        configuration = {'sandbox.json': {'sources': ['accor'], 'rules': str(self.target)},
                         'vault.json': {'project': 'invented', 'environment': 'fixture'},
                         'git-identity.json': {'name': 'Invented operator'}}
        for name, value in configuration.items():
            content = (json.dumps(value, indent=2) + '\n').encode()
            (self.directory / name).write_bytes(content)
            (self.installed / name).write_bytes(content)
            (self.installed / name).chmod(0o644)
        self.installed.chmod(0o755)
        self.target.chmod(0o644)

    def populate_contract(self):
        now = int(time.time())
        self.contract = {'runId': self.run_id, 'review': 'synthetic-review',
                         'ownerRoute': 'synthetic-owner-hold', 'notBefore': now - 60,
                         'expires': now + 3600, 'preflightSeconds': 180,
                         'scope': 'accor-rules-only-local-commit-no-push',
                         'artifactSha256': '', 'checkout': str(self.checkout),
                         'runtime': str(self.runtime), 'privateCheckout': str(self.private),
                         'privateHead': git(self.private, 'rev-parse', 'HEAD'),
                         'original': str(self.original), 'journal': str(self.journal),
                         'installed': str(self.installed), 'loaded': str(self.loaded),
                         'sourceHead': git(self.checkout, 'rev-parse', 'HEAD'),
                         'ownerProofSha256': ''}
        proof = {'runId': self.run_id, 'review': self.contract['review'],
                 'ownerRoute': self.contract['ownerRoute'], 'isHeld': True,
                 'notBefore': now - 30, 'expires': now + 3600}
        self.proof = self.root / 'owner.json'
        write_json(self.proof, proof)
        self.contract['ownerProofSha256'] = digest(self.proof.read_bytes())
        self.contract_path = self.root / 'contract.json'
        self.options = {'inputSha256': digest(ORIGINAL), 'inputBytes': len(ORIGINAL),
                        'recipeSha256': digest((self.private / 'rules/import.json').read_bytes()),
                        'outputSha256': digest(EXPECTED), 'outputBytes': len(EXPECTED), 'fault': '', 'storeFault': '',
                        'driftTarget': '', 'driftObservation': 0, 'pauseRead': 0}

    def command(self, **updates):
        self.contract.update(updates)
        manifest = subprocess.run([sys.executable, '-I', str(AREA / 'run.py'), 'manifest'],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if manifest.returncode == 0:
            self.contract['artifactSha256'] = json.loads(manifest.stdout)['artifactSha256']
        if self.proof.exists():
            proof = json.loads(self.proof.read_bytes())
            scope = {key: value for key, value in self.contract.items() if key != 'ownerProofSha256'}
            proof['scopeSha256'] = digest((json.dumps(scope, sort_keys=True, indent=2) + '\n').encode())
            write_json(self.proof, proof)
            self.contract['ownerProofSha256'] = digest(self.proof.read_bytes())
        write_json(self.contract_path, self.contract)
        write_json(self.root / 'fixture-options.json', self.options)
        return [sys.executable, '-I', str(AREA / 'run.py'), 'fixture',
                '--fixture-root', str(self.root), '--contract', str(self.contract_path),
                '--contract-sha256', digest(self.contract_path.read_bytes()), '--owner-proof', str(self.proof)]

    def run(self, **updates):
        return subprocess.run(self.command(**updates), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45)

    def records(self):
        return [json.loads(line) for line in (self.journal / 'events.jsonl').read_text().splitlines()]
