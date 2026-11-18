#!/usr/bin/env python3
import sys

if not sys.flags.isolated:
    print('REFUSED: invoke with python3 -I to isolate module lookup.', file=sys.stderr)
    sys.exit(1)

import argparse
import json
import os
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from guards import AREA, Refused, artifact, read_json, validate_contract


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


def main():
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
