from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import signal
import time

from guards import Commands, Refused, check_window, digest, read_json, require
from journal import Journal
from local_steps import (acknowledge, canonical_commit, capture_backups, create_branch, link_original,
                         stage_acknowledgement, stage_canonical, stage_link, transfer,
                         write_canonical, write_pending, write_snapshot)
from preflight import Preflight
from sources import plan_import, prove_files
from transport import FixtureTransport, Transport, fixture_scope


@contextmanager
def bounded_reads(seconds):
    def expired(*_):
        raise Refused('aggregate read-only deadline reached')
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


@contextmanager
def sandbox_lock(directory):
    require(directory.resolve() == directory, 'sandbox directory is symlinked')
    descriptor = os.open(directory, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(os.fstat(descriptor).st_ino == directory.stat().st_ino, 'sandbox directory changed')
        yield
    finally:
        os.close(descriptor)


def guard(plan, proof_path):
    plan.commands.deadline = time.monotonic() + plan.contract['preflightSeconds']
    with bounded_reads(plan.contract['preflightSeconds']):
        check_window(plan.contract, proof_path)
        prove_files(Path(plan.contract['checkout']), plan.resources)
        require(plan.commands.git(plan.contract['checkout'], 'rev-parse', 'HEAD') == plan.contract['sourceHead'],
                'Mac HEAD drift')
        plan.guard_paths()
        plan.guard_vm()
        check_window(plan.contract, proof_path)


def prepare(options, contract, resources):
    is_fixture = options.command == 'fixture'
    commands = Commands(contract['preflightSeconds'])
    fault = ''
    if is_fixture:
        root, fixture, resources = fixture_scope(options, contract, resources)
        fault = fixture['fault']
        from fixture_boundary import install_boundary
        install_boundary(root, commands)
        transport = FixtureTransport(commands, contract, resources, root, fixture)
    else:
        import platform
        require(platform.system() == 'Darwin', 'production execution requires the reviewed operator Mac')
        transport = Transport(commands, contract, resources)
    with bounded_reads(contract['preflightSeconds']):
        plan = Preflight(commands, contract, resources, transport, is_fixture)
        check_window(contract, options.owner_proof)
    return plan, fault


def execute(options, contract, resources):
    journal_path = Path(contract['journal'])
    require(not journal_path.exists() and not journal_path.is_symlink()
            and not (journal_path.parent / (journal_path.name + '.ownership.json')).exists(),
            'RECONCILE: prior attempt exists. Use inspect with the retained contract. Never rerun.')
    plan, fault = prepare(options, contract, resources)
    with sandbox_lock(plan.directory):
        return execute_locked(options, plan, fault)


def execute_locked(options, plan, fault):
    contract = plan.contract
    guard(plan, options.owner_proof)
    journal = Journal(contract, fault)
    journal.step('capture-backups', lambda: capture_backups(plan, journal))
    guard(plan, options.owner_proof)
    with bounded_reads(contract['preflightSeconds']):
        require(plan_import(contract, plan.resources, plan.rules) == (plan.before, plan.after),
                'recipe preflight changed immediately before mutation')
        check_window(contract, options.owner_proof)
    stages = [('canonical-file', write_canonical), ('snapshot', write_snapshot),
              ('pending-state', write_pending), ('link-staging', stage_link), ('original-link', link_original),
              ('private-branch', create_branch), ('private-index', stage_canonical), ('local-commit', canonical_commit), ('vm-transfer', transfer)]
    for name, action in stages:
        guard(plan, options.owner_proof)
        if name == 'canonical-file':
            require(plan_import(contract, plan.resources, plan.rules) == (plan.before, plan.after),
                    'immediate recipe computation changed')
            check_window(contract, options.owner_proof)
        journal.step(name, lambda action=action: action(plan))
    plan.commands.deadline = time.monotonic() + contract['preflightSeconds']
    with bounded_reads(contract['preflightSeconds']):
        journal.step('vm-confirmation', plan.refresh_vm)
    guard(plan, options.owner_proof)
    journal.step('ack-staging', lambda: stage_acknowledgement(plan))
    guard(plan, options.owner_proof)
    journal.step('acknowledgement', lambda: acknowledge(plan))
    guard(plan, options.owner_proof)
    journal.step('loaded-hashes', plan.refresh_vm)
    print('RULES FILES VERIFIED: canonical, snapshot, original link, VM and session hashes match.')
    print('PRIVATE COMMIT LOCAL ONLY:', plan.private_head, plan.origin, plan.resources['privateBranch'])
    print('Publication requires separate approval. Agent instruction reload is not established by file hashes.')
    return 0
