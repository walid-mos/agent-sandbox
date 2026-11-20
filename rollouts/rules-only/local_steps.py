import base64
import os
from pathlib import Path

from guards import digest, encode, regular, require
from journal import create, fsync_directory
from preflight import configuration_paths


def capture_backups(plan, journal):
    paths = [plan.original, plan.private / 'rules/import.json',
             *configuration_paths(plan.directory, Path(plan.contract['runtime'])).values()]
    retained = {str(path): {'proof': plan.expected_paths[path],
                           'bytesBase64': base64.b64encode(path.read_bytes()).decode()}
                for path in paths if path.exists()}
    content = encode({'files': retained, 'vm': plan.vm})
    create(journal.directory / 'private-backups.json', content)
    return {'backupSha256': digest(content)}


def write_canonical(plan):
    create(plan.canonical, plan.after, plan.rules.PRIVATE_FILE)
    plan.remember(plan.canonical)
    plan.private_status = '?? rules/AGENTS.md'
    return {'sha256': digest(plan.after)}


def write_snapshot(plan):
    path = plan.directory / plan.rules.SNAPSHOT_FILE
    create(path, plan.after, plan.rules.SNAPSHOT_MODE)
    plan.remember(path)
    return {'sha256': digest(plan.after)}


def write_pending(plan):
    path = plan.directory / plan.rules.STATE_FILE
    create(path, plan.rules.json_bytes(plan.state), plan.rules.PRIVATE_FILE)
    plan.remember(path)
    return {'isPending': True, 'sha256': plan.state['sha256']}


def stage_link(plan):
    os.symlink(str(plan.directory / plan.rules.SNAPSHOT_FILE), plan.link_staging)
    fsync_directory(plan.link_staging.parent)
    plan.remember(plan.link_staging)
    return {'isSnapshotLink': True}


def link_original(plan):
    require(regular(plan.original).read_bytes() == plan.before, 'original changed before link replacement')
    os.replace(plan.link_staging, plan.original)
    plan.remember(plan.link_staging)
    fsync_directory(plan.original.parent)
    plan.remember(plan.original)
    return {'sha256': digest(plan.original.read_bytes()), 'isSnapshotLink': True}


def create_branch(plan):
    plan.commands.git(plan.private, 'switch', '-c', plan.resources['privateBranch'], mutation=True)
    plan.private_branch = plan.resources['privateBranch']
    return {'branch': plan.private_branch}


def stage_canonical(plan):
    commands, checkout = plan.commands, plan.private
    commands.git(checkout, 'add', '--', 'rules/AGENTS.md', mutation=True)
    plan.private_status = 'A  rules/AGENTS.md'
    staged = commands.git(checkout, 'diff', '--cached', '--name-status')
    require(staged == 'A\trules/AGENTS.md', 'private index contains unexpected paths')
    expected = commands.git(checkout, 'hash-object', '--no-filters', str(plan.canonical))
    require(commands.git(checkout, 'rev-parse', ':rules/AGENTS.md') == expected, 'Git transformed private bytes')
    return {'sha256': digest(plan.after)}


def canonical_commit(plan):
    commands, checkout = plan.commands, plan.private
    expected = commands.git(checkout, 'hash-object', '--no-filters', str(plan.canonical))
    commands.git(checkout, 'commit', '--quiet', '-m', plan.resources['privateSubject'], mutation=True)
    plan.private_head = commands.git(checkout, 'rev-parse', 'HEAD')
    plan.private_branch = plan.resources['privateBranch']
    plan.private_status = ''
    require(commands.git(checkout, 'rev-parse', 'HEAD^') == plan.contract['privateHead'], 'private commit parent differs')
    require(commands.git(checkout, 'diff-tree', '--no-commit-id', '--name-status', '-r', 'HEAD')
            == 'A\trules/AGENTS.md', 'private commit changed more than canonical rules')
    require(commands.git(checkout, 'rev-parse', 'HEAD:rules/AGENTS.md') == expected, 'committed bytes differ')
    return {'commit': plan.private_head, 'remote': plan.origin, 'branch': plan.private_branch, 'isPushed': False}


def transfer(plan):
    payload = plan.bundler.bundle(plan.directory, Path(plan.contract['runtime']))
    require({key: value for key, value in payload.items() if key != plan.rules.RULES_KEY} == plan.local_bundle,
            'outgoing unrelated configuration differs')
    rules = payload[plan.rules.RULES_KEY]
    require(rules == {'text': plan.after.decode(), 'sha256': plan.state['sha256'],
                      'previousSha256': plan.state['previousSha256']}, 'outgoing approved rules differ')
    plan.transport.transfer(payload)
    return {'transportReturnedSuccess': True}


def stage_acknowledgement(plan):
    create(plan.ack_staging, plan.rules.json_bytes({**plan.state, 'isPending': False}))
    plan.remember(plan.ack_staging)
    return {'isPending': True}


def acknowledge(plan):
    path = plan.directory / plan.rules.STATE_FILE
    approved = plan.rules.approved_state(plan.directory)
    require(approved[0] == plan.state and approved[1].encode() == plan.after, 'approval changed before acknowledgement')
    os.replace(plan.ack_staging, path)
    fsync_directory(path.parent)
    plan.remember(path)
    plan.remember(plan.ack_staging)
    return {'isPending': False, 'sha256': plan.state['sha256']}
