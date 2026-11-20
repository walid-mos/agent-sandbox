from pathlib import Path
import stat

from guards import digest, regular, require
from sources import plan_import, prove_checkout, prove_private

NAMES = ('sandbox.json', 'vault.json', 'git-identity.json', 'tailnet.json')


def path_proof(path):
    require(path.parent.resolve() == path.parent, 'parent directory changed')
    if path.is_symlink():
        return {'link': str(path.readlink())}
    if not path.exists():
        return {'absent': True}
    info = regular(path).stat()
    return {'sha256': digest(path.read_bytes()), 'mode': stat.S_IMODE(info.st_mode)}


def configuration_paths(directory, runtime):
    return {name: (runtime if name == 'tailnet.json' else directory) / name for name in NAMES}


def expected_vm(bundle, rules):
    return {name: {'sha256': digest(rules.json_bytes(content)), 'mode': 0o644}
            for name, content in bundle.items() if name != rules.RULES_KEY}


class Preflight:
    def __init__(self, commands, contract, resources, transport, is_fixture):
        self.commands = commands
        self.contract = contract
        self.resources = resources
        self.transport = transport
        self.is_fixture = is_fixture
        self.directory = Path(contract['runtime']) / 'sandboxes/accor'
        self.private = Path(contract['privateCheckout'])
        self.canonical = self.private / 'rules/AGENTS.md'
        self.original = Path(contract['original'])
        self.link_staging = self.original.parent / f'.{self.original.name}.{contract["runId"]}'
        self.ack_staging = self.directory / f'.client-rules.json.{contract["runId"]}'
        require(not self.link_staging.exists() and not self.link_staging.is_symlink()
                and not self.ack_staging.exists() and not self.ack_staging.is_symlink(), 'staging destination exists')
        self.rules, self.bundler, self.refresh = prove_checkout(commands, contract, resources, is_fixture)
        self.origin = prove_private(commands, contract, resources, self.refresh, is_fixture)
        self.before, self.after = plan_import(contract, resources, self.rules)
        for path in configuration_paths(self.directory, Path(contract['runtime'])).values():
            require(not path.is_symlink() and path.parent.resolve() == path.parent, 'configuration symlink refused')
            if path.exists():
                regular(path)
        self.state = {'source': 'accor', 'file': 'rules/AGENTS.md', 'sha256': resources['outputSha256'],
                      'previousSha256': resources['inputSha256'], 'original': str(self.original), 'isPending': True}
        self.local_bundle = self.bundler.bundle(self.directory, Path(contract['runtime']))
        self.validate_configuration()
        self.vm = transport.observe(self.target)
        self.validate_vm()
        paths = [self.original, self.canonical, self.link_staging, self.ack_staging,
                 self.private / 'rules/import.json', self.private / '.git/config',
                 Path(contract['checkout']) / '.git/config',
                 self.directory / self.rules.SNAPSHOT_FILE, self.directory / self.rules.STATE_FILE,
                 *configuration_paths(self.directory, Path(contract['runtime'])).values()]
        self.expected_paths = {path: path_proof(path) for path in paths}
        self.private_head = contract['privateHead']
        self.private_branch = 'main'
        self.private_status = ''

    def validate_configuration(self):
        configuration = self.local_bundle['sandbox.json']
        require('accor' in configuration.get('sources', []), 'Accor source not selected')
        installed = Path(self.contract['installed'])
        self.target = self.rules.rules_target(configuration.get('rules'), installed)
        if not self.is_fixture:
            require(self.contract['loaded'] == '/config/AGENTS.md' and str(installed) == '/etc/agent-sandbox',
                    'installed or loaded path differs')
            catalog = self.rules.read_json(Path(self.contract['checkout']) / 'session/agent-sources.json')
            require(self.private == Path.home() / catalog['accor']['directory'], 'private source path differs from catalog')
        require(not self.canonical.is_relative_to(Path(self.contract['checkout'])), 'private target enters public checkout')

    def validate_vm(self):
        require(self.vm['files'] == expected_vm(self.local_bundle, self.rules),
                'unrelated bundle bytes or optional membership differ')
        require(self.vm['rules'] == {'sha256': self.resources['inputSha256'], 'mode': 0o644}
                and self.vm['loadedSha256'] == self.resources['inputSha256']
                and self.vm['loadedTarget'] == str(self.target), 'initial VM or loaded rules differ')

    def guard_paths(self):
        require(all(path_proof(path) == proof for path, proof in self.expected_paths.items()), 'local path drift')
        require(self.commands.git(self.private, 'rev-parse', 'HEAD') == self.private_head
                and self.commands.git(self.private, 'branch', '--show-current') == self.private_branch
                and self.commands.git(self.private, 'status', '--porcelain', '--untracked-files=all') == self.private_status,
                'private Git drift')

    def guard_vm(self):
        require(self.transport.observe(self.target) == self.vm, 'VM proof drift')

    def remember(self, path):
        self.expected_paths[path] = path_proof(path)

    def refresh_vm(self):
        observed = self.transport.observe(self.target)
        expected = {**self.vm, 'rules': {'sha256': self.resources['outputSha256'], 'mode': 0o644},
                    'loadedSha256': self.resources['outputSha256']}
        require(observed == expected, 'VM transfer or loaded hashes differ')
        self.vm = observed
        return {'sha256': self.resources['outputSha256'], 'unrelatedBundlePreserved': True}
