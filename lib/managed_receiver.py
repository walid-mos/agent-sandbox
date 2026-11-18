#!/usr/bin/python3 -I
import argparse
import fcntl
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from factory_candidate import verify_publication
from managed_update import (Blocked, SANDBOX, SHA1, checkout_revision, read_git, require_protected,
                            require_receiver, restrict_environment, source_origin, verify_signature)
from receiver_staging import fetch_tip, stage_candidate
from receiver_state import PROTOCOL, admission, read_state, write_state

ORIGIN = source_origin(SANDBOX)
RUNTIME_TIMEOUT_SECONDS = 60
RUNTIME_FAILURES = {'idle': 'runtime-busy', 'health': 'runtime-health-failed',
                    'restart': 'runtime-restart-failed', 'dispatch': 'runtime-dispatch-failed'}


class Receiver:
    def __init__(self, root, origin=ORIGIN):
        require_receiver(root, SANDBOX)
        self.root = root
        self.origin = origin
        self.runtime = root / 'runtime'

    def checkout(self, revision):
        initial = self.root / 'checkout'
        if checkout_revision(initial, self.origin) == revision:
            return initial
        releases = self.root / 'releases'
        require_protected(releases, stat.S_ISDIR, (os.geteuid(),))
        return releases / revision

    def require_release(self, revision):
        checkout = self.checkout(revision)
        if checkout_revision(checkout, self.origin) != revision:
            raise Blocked('release-checkout-mismatch')
        signers = 'trusted-signers.asc' if checkout == self.root / 'checkout' else 'factory-signers.asc'
        trust = self.root / signers
        require_protected(trust, stat.S_ISREG, (os.geteuid(),))
        verify_signature(checkout, revision, trust, 'release-signature-unverified')
        return checkout

    def call_runtime(self, operation, checkout, revision, descriptor, arguments=()):
        require_protected(self.runtime, stat.S_ISREG, (os.geteuid(),))
        try:
            return subprocess.run([str(self.runtime), operation, str(checkout), revision, *arguments], check=True,
                                  capture_output=True, timeout=RUNTIME_TIMEOUT_SECONDS, pass_fds=(descriptor,)).stdout
        except (OSError, subprocess.SubprocessError):
            raise Blocked(RUNTIME_FAILURES[operation]) from None

    def require_health(self, checkout, revision, descriptor):
        try:
            report = json.loads(self.call_runtime('health', checkout, revision, descriptor))
        except (ValueError, RecursionError):
            raise Blocked('runtime-health-invalid') from None
        if report != {'protocol': PROTOCOL, 'loaded': revision}:
            raise Blocked('runtime-version-mismatch')

    def initialize(self, descriptor):
        if os.path.lexists(self.root / 'status.json'):
            raise Blocked('receiver-already-initialized')
        revision = checkout_revision(self.root / 'checkout', self.origin)
        checkout = self.require_release(revision)
        self.require_health(checkout, revision, descriptor)
        return write_state(self.root, {'protocol': PROTOCOL, 'phase': 'ready', 'accepted': revision,
                                       'known_good': revision, 'filesystem': revision, 'loaded': revision,
                                       'desired': None, 'verified': None, 'blocked': None})

    def restore(self, state, reason, descriptor):
        revision = state['known_good']
        saving = write_state(self.root, {**state, 'phase': 'restoring', 'blocked': reason,
                                        'filesystem': None, 'loaded': None})
        try:
            checkout = self.require_release(revision)
            self.call_runtime('restart', checkout, revision, descriptor)
            self.require_health(checkout, revision, descriptor)
        except (Blocked, OSError) as problem:
            failure = str(problem) if isinstance(problem, Blocked) else 'receiver-io-failed'
            return write_state(self.root, {**saving, 'recovery_failure': failure})
        saving.pop('recovery_failure', None)
        return write_state(self.root, {**saving, 'phase': 'ready', 'filesystem': revision, 'loaded': revision})

    def poll(self, descriptor, endpoint=None, protocol='https'):
        state = read_state(self.root)
        if state['phase'] != 'ready':
            return self.restore(state, state['blocked'] or 'activation-interrupted', descriptor)
        endpoint = endpoint or self.origin
        candidate = None
        try:
            candidate = fetch_tip(self.root, self.origin, endpoint, protocol)
            stage_candidate(self.root, self.origin, state['known_good'], candidate, endpoint, protocol)
        except (Blocked, OSError) as problem:
            reason = str(problem) if isinstance(problem, Blocked) else 'candidate-staging-io-failed'
            return write_state(self.root, {**state, 'desired': candidate, 'verified': None, 'blocked': reason})
        return self.advance(candidate, descriptor)

    def status(self, descriptor):
        state = read_state(self.root)
        if state['phase'] != 'ready':
            return {**state, 'loaded': None}
        revision = state['known_good']
        try:
            checkout = self.require_release(revision)
            self.require_health(checkout, revision, descriptor)
        except (Blocked, OSError):
            return {**state, 'loaded': None, 'blocked': 'loaded-revision-unverified'}
        return {**state, 'loaded': revision}

    def advance(self, revision, descriptor):
        previous = read_state(self.root)
        if previous['phase'] != 'ready':
            return self.restore(previous, previous['blocked'] or 'activation-interrupted', descriptor)
        state = {**previous, 'blocked': None, 'desired': revision, 'verified': None}
        try:
            return self.apply_revision(state, revision, descriptor)
        except Blocked as problem:
            return self.record_block(revision, str(problem))
        except OSError:
            return self.record_block(revision, 'receiver-io-failed')

    def record_block(self, revision, reason):
        return write_state(self.root, {**read_state(self.root), 'desired': revision, 'blocked': reason})

    def apply_revision(self, state, revision, descriptor):
        known_good = state['known_good']
        checkout = self.require_release(known_good)
        self.require_health(checkout, known_good, descriptor)
        if revision == known_good:
            if state['accepted'] != known_good:
                raise Blocked('candidate-checkpoint-mismatch')
            return write_state(self.root, state)
        if state['accepted'] not in (known_good, revision):
            raise Blocked('candidate-checkpoint-mismatch')
        verified = verify_publication(self.root, self.origin, known_good, revision)
        target = self.require_release(revision)
        if read_git(target, 'rev-parse', f'{revision}^{{tree}}') != verified['tree']:
            raise Blocked('release-tree-mismatch')
        state = write_state(self.root, {**state, 'verified': verified})
        self.call_runtime('idle', checkout, known_good, descriptor)
        changing = write_state(self.root, {**state, 'phase': 'switching', 'accepted': revision,
                                          'filesystem': None, 'loaded': None})
        try:
            self.call_runtime('restart', target, revision, descriptor)
            self.require_health(target, revision, descriptor)
        except Blocked as problem:
            return self.restore(changing, str(problem), descriptor)
        return write_state(self.root, {**changing, 'phase': 'ready', 'known_good': revision,
                                       'filesystem': revision, 'loaded': revision})

    def dispatch(self, arguments, descriptor):
        state = read_state(self.root)
        if state['phase'] != 'ready' or state.get('loaded') != state['known_good']:
            raise Blocked('admission-closed')
        revision = state['known_good']
        checkout = self.require_release(revision)
        self.require_health(checkout, revision, descriptor)
        sys.stdout.buffer.write(self.call_runtime('dispatch', checkout, revision, descriptor, arguments))
        return 0


def run(arguments, receiver_type=Receiver):
    receiver = receiver_type(arguments.root)
    operation = arguments.operation
    mode = fcntl.LOCK_SH if operation in ('status', 'dispatch') else fcntl.LOCK_EX
    with admission(receiver.root, mode) as descriptor:
        if operation == 'initialize':
            return receiver.initialize(descriptor)
        if operation == 'advance':
            return receiver.advance(arguments.revision, descriptor)
        if operation == 'poll':
            return receiver.poll(descriptor)
        if operation == 'status':
            return receiver.status(descriptor)
        return receiver.dispatch(arguments.arguments, descriptor)


def full_revision(value):
    if not SHA1.fullmatch(value):
        raise argparse.ArgumentTypeError('expected a full commit SHA-1')
    return value


def main(execute=run):
    parser = argparse.ArgumentParser(description='Manage a protected sandbox VM release receiver')
    parser.add_argument('root', type=Path)
    operations = parser.add_subparsers(dest='operation', required=True)
    operations.add_parser('initialize')
    operations.add_parser('status')
    operations.add_parser('poll')
    operations.add_parser('advance').add_argument('revision', type=full_revision)
    operations.add_parser('dispatch').add_argument('arguments', nargs=argparse.REMAINDER)
    arguments = parser.parse_args()
    restrict_environment()
    try:
        outcome = execute(arguments)
    except Blocked as problem:
        outcome = {'blocked': str(problem)}
    except OSError:
        outcome = {'blocked': 'receiver-io-failed'}
    if isinstance(outcome, int):
        return outcome
    print(json.dumps(outcome))
    return int(outcome['blocked'] is not None)


if __name__ == '__main__':
    sys.exit(main())
