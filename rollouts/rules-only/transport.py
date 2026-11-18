import json
from pathlib import Path
import sys

from guards import AREA, digest, encode, read_json, regular, require
from observe_vm import observe
from sources import prove_files

SESSION_PROOF = '''import hashlib,json,pathlib,sys
rules=pathlib.Path(sys.argv[1]); loaded=pathlib.Path('/config/AGENTS.md')
print(json.dumps({'sha256':hashlib.sha256(rules.read_bytes()).hexdigest(),
'loadedSha256':hashlib.sha256(loaded.read_bytes()).hexdigest(),'loadedTarget':str(loaded.resolve())}))
'''
TRANSFER = '. "$1/lib/sandbox.sh"; run_trusted vm/store-config "$POTS_SESSION_CONFIGURATION"'


class Transport:
    def __init__(self, commands, contract, resources):
        self.commands = commands
        self.contract = contract
        self.resources = resources
        self.checkout = Path(contract['checkout'])
        self.extra = {'POTS_RUNTIME': contract['runtime'], 'SANDBOX': 'accor', 'POTS_TRANSPORT': 'provider'}

    def observe(self, target):
        request = {'files': self.resources['files'], 'revision': self.resources['revision'],
                   'checkout': '/opt/agent-sandbox', 'installed': self.contract['installed'],
                   'rulesTarget': str(target), 'loaded': str(target), 'isProduction': True}
        collector = regular(AREA / 'observe_vm.py').read_text()
        output = self.commands.run([self.checkout / 'bin/vm-exec', '/usr/bin/python3', '-I',
                                    '-c', collector, json.dumps(request)], extra=self.extra)
        observed = json.loads(output)
        output = self.commands.run([self.checkout / 'bin/sandbox-exec', '/usr/bin/python3', '-I',
                                    '-c', SESSION_PROOF, str(target)], extra=self.extra)
        session = json.loads(output)
        require(session['sha256'] == observed['rules']['sha256'], 'session mount differs from VM')
        observed.update(loadedTarget=session['loadedTarget'], loadedSha256=session['loadedSha256'])
        return observed

    def transfer(self, payload):
        self.commands.run(['/bin/sh', '-c', TRANSFER, str(self.checkout / 'bin/vm-config'), str(self.checkout)],
                          input_bytes=json.dumps(payload).encode(), mutation=True, extra=self.extra)


class FixtureTransport:
    def __init__(self, commands, contract, resources, root, options):
        self.commands = commands
        self.contract = contract
        self.resources = resources
        self.root = root
        self.options = options
        self.observations = 0

    def observe(self, target):
        self.observations += 1
        self.external_fixture_change()
        prove_files(self.root / 'vm', self.resources)
        return observe({'files': self.resources['files'], 'checkout': str(self.root / 'vm'),
                        'installed': self.contract['installed'], 'rulesTarget': str(target),
                        'loaded': self.contract['loaded'], 'isProduction': False})

    def external_fixture_change(self):
        if self.observations == 1 and self.options['pauseRead']:
            import time
            time.sleep(self.options['pauseRead'])
        if self.observations != self.options['driftObservation']:
            return
        targets = {'vm-bundle': self.root / 'installed/vault.json',
                   'original': self.root / 'original.md', 'owner': self.root / 'owner.json'}
        path = targets[self.options['driftTarget']]
        path.write_bytes(path.read_bytes() + b' ')

    def transfer(self, payload):
        self.commands.run([sys.executable, '-I', AREA / 'fixture_store.py', self.root],
                          input_bytes=json.dumps(payload).encode(), mutation=True)


def fixture_scope(options, contract, resources):
    root = Path(options.fixture_root)
    require(root.resolve() == root and root.name.startswith('rules-only-'), 'isolated fixture root required')
    marker = read_json(root / 'fixture-owner.json')
    require(marker['runId'] == root.name and marker['runId'] == contract['runId'], 'fixture ownership differs')
    import os
    os.kill(marker['pid'], 0)
    for key in ('checkout', 'runtime', 'privateCheckout', 'original', 'journal', 'installed', 'loaded'):
        path = Path(contract[key])
        require(path.is_relative_to(root) and path.resolve().is_relative_to(root), 'fixture escaped ownership root')
    fixture = read_json(root / 'fixture-options.json')
    hashes = ('inputSha256', 'inputBytes', 'recipeSha256', 'outputSha256', 'outputBytes')
    require(set(fixture) == {*hashes, 'fault', 'storeFault', 'driftTarget', 'driftObservation', 'pauseRead'},
            'unsupported fixture options')
    require(fixture['driftTarget'] in ('', 'vm-bundle', 'original', 'owner')
            and type(fixture['driftObservation']) is int and 0 <= fixture['driftObservation'] <= 20,
            'unsupported fixture drift')
    require(isinstance(fixture['pauseRead'], (float, int)) and 0 <= fixture['pauseRead'] <= 2,
            'unsupported fixture delay')
    require(fixture['inputSha256'] != resources['inputSha256'], 'production input forbidden in fixtures')
    return root, fixture, {**resources, **{key: fixture[key] for key in hashes}}
