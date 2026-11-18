#!/usr/bin/env python3
import argparse
import hashlib
import importlib.abc
import importlib.util
import json
import os
from pathlib import Path
import sys

AREA = Path(__file__).resolve().parent

if not sys.flags.isolated:
    print('REFUSED: invoke with python3 -I to isolate module lookup.', file=sys.stderr)
    sys.exit(1)

sys.dont_write_bytecode = True
RUNNER_FILES = json.loads((AREA / 'resources.json').read_bytes())['runnerFiles']


class SourceLoader(importlib.abc.Loader):
    def exec_module(self, module):
        path = Path(module.__spec__.origin)
        content = path.read_bytes()
        expected = RUNNER_FILES.get(path.name)
        if expected is None or hashlib.sha256(content).hexdigest() != expected:
            raise ImportError('pinned runner source differs')
        exec(compile(content, str(path), 'exec'), module.__dict__)


class SourceFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if '.' in fullname:
            return None
        source = AREA / f'{fullname}.py'
        if not source.is_file():
            if fullname in {Path(name).stem for name in RUNNER_FILES}:
                raise ImportError('pinned runner source is missing')
            return None
        return importlib.util.spec_from_file_location(fullname, source, loader=SourceLoader())


if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != RUNNER_FILES.get('run.py'):
    raise SystemExit('REFUSED: pinned runner entrypoint differs.')
sys.meta_path.insert(0, SourceFinder())
sys.path.insert(0, str(AREA))

from guards import Refused, artifact, read_json, validate_contract


def arguments():
    parser = argparse.ArgumentParser(description='Reviewed rules-only import. No live window or approval is supplied.')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('manifest', help='print safe resource hashes for review')
    for name in ('execute', 'fixture', 'inspect'):
        command = commands.add_parser(name)
        command.add_argument('--contract', required=True, type=Path)
        command.add_argument('--contract-sha256', required=True)
        if name != 'inspect':
            command.add_argument('--owner-proof', required=True, type=Path)
        if name == 'fixture':
            command.add_argument('--fixture-root', required=True, type=Path)
        if name == 'inspect':
            command.add_argument('--fixture-root', type=Path)
            command.add_argument('--vm', action='store_true')
    return parser.parse_args()


def manifest_command(_):
    print(json.dumps(artifact(), indent=2))
    return 0


def inspect_command(options):
    from execute import bounded_reads
    from inspection import inspect
    with bounded_reads(60):
        print(json.dumps(inspect(options)))
    return 0


def execute_command(options):
    contract = validate_contract(options)
    from execute import execute
    return execute(options, contract, read_json(AREA / 'resources.json'))


def run_internal_command():
    scripts = {'_fixture-store': 'fixture_store.py', '_mutation-worker': 'mutation_worker.py'}
    script = scripts.get(sys.argv[1]) if len(sys.argv) > 1 else None
    if script is None:
        return None
    path = AREA / script
    specification = importlib.util.spec_from_file_location('__main__', path, loader=SourceLoader())
    module = importlib.util.module_from_spec(specification)
    runner = sys.modules[__name__]
    sys.modules['_rules_only_verified_runner'] = runner
    sys.argv = [str(path), *sys.argv[2:]]
    sys.modules['__main__'] = module
    try:
        specification.loader.exec_module(module)
    finally:
        sys.modules['__main__'] = runner
    return 0


def main():
    internal_result = run_internal_command()
    if internal_result is not None:
        return internal_result
    os.umask(0o077)
    options = arguments()
    commands = {'manifest': manifest_command, 'inspect': inspect_command,
                'execute': execute_command, 'fixture': execute_command}
    try:
        return commands[options.command](options)
    except Refused as error:
        print(f'REFUSED: {error}', file=sys.stderr)
    except (OSError, ValueError, TypeError, KeyError, RuntimeError):
        print('REFUSED or FAILED-UNKNOWN: guard or operation did not complete. Input and command output withheld.', file=sys.stderr)
    print('RECONCILE: if an ownership record or journal exists, use inspect with the retained contract. '
          'Retain private backups. No rerun, retry, rollback, push or restart.', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
