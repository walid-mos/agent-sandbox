#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

root = Path(os.environ['RECEIVER_VM_FIXTURE'])
state_path = root / 'container.json'
arguments = sys.argv[1:]
state = json.loads(state_path.read_text()) if state_path.exists() else None


def run_container(arguments):
    binds = [arguments[index + 1].split(':') for index, value in enumerate(arguments) if value == '--volume']
    mounts = [{'Source': source, 'Destination': target, 'RW': mode != 'ro', 'Type': 'bind'}
              for source, target, mode in binds if source.startswith('/')]
    marker = next(Path(item['Source']) for item in mounts if item['Destination'] == str(root / 'release-id'))
    state_path.write_text(json.dumps({'mounts': mounts, 'revision': marker.read_text().strip()}))
    with (root / 'starts').open('a') as starts:
        starts.write(marker.read_text())
    print('fixture-session')


def exec_container(arguments):
    outdated = root / 'router-outdated'
    if arguments[-1] == '--router-current':
        sys.exit(int(outdated.exists()))
    if arguments[-1] == '--router-only':
        outdated.unlink()
        return
    if arguments[-3:] == ['s6-svc', '-r', '/run/service/custom-svc-pots-router']:
        with (root / 'router-restarts').open('a') as restarts:
            restarts.write(f"{state['revision']}\n")
        return
    if arguments[-2:] == ['pots', 'status']:
        activity = 'working' if (root / 'active-bot').exists() else 'idle'
        print(f'probe: Probe, fixture model, {activity}, fixture status')
        return
    if 'health' not in arguments:
        assert 'hc' in arguments and 'ls' in arguments, arguments
        terminals = [{'state': 'live'}] if (root / 'active-worker').exists() else []
        print(json.dumps({'terminals': terminals}))
        return
    health = arguments.index('health')
    marker, expected, *services = arguments[health + 1:]
    assert marker == str(root / 'release-id')
    assert services == ['pots-gateway', 'pots-router', 'pots-watcher', 'pots-sources']
    if state['revision'] != expected or (root / f'unhealthy-{expected}').exists():
        sys.exit(1)


match arguments[0]:
    case 'ps':
        if state:
            print('fixture-session')
    case 'run':
        assert state is None
        run_container(arguments)
    case 'stop':
        state_path.unlink()
    case 'wait':
        assert state is None
    case 'inspect':
        print(json.dumps(state['mounts']))
    case 'exec':
        exec_container(arguments)
    case _:
        raise SystemExit(f'Unrecognized Docker command: {arguments}')
