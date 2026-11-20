import uuid

from guards import digest, encode, private_directory, private_file, read_json, require
from journal import create, fsync_directory
from process_state import ENDED, LIVE, UNKNOWN, identity, lease_identity, lease_is_held


def new_operation(journal):
    root = journal.directory / 'mutations'
    if not root.exists():
        root.mkdir(mode=0o700)
        fsync_directory(journal.directory)
    private_directory(root)
    directory = root / uuid.uuid4().hex
    directory.mkdir(mode=0o700)
    fsync_directory(root)
    create(directory / 'lease', b'')
    intent = {'operation': directory.name, 'stage': journal.current_step,
              'contractSha256': journal.contract_hash, 'lease': lease_identity(directory / 'lease')}
    create(directory / 'intent.json', encode(intent))
    return directory


def intent(directory):
    private_directory(directory)
    record = read_json(private_file(directory / 'intent.json'))
    require(set(record) == {'operation', 'stage', 'contractSha256', 'lease'}
            and record['operation'] == directory.name, 'mutation identity differs')
    require(lease_identity(directory / 'lease') == record['lease'], 'mutation lease differs')
    return record


def store(directory, name, proof):
    create(directory / name, encode({**intent(directory), **proof}))


def read(directory, name):
    record = read_json(private_file(directory / name))
    require(all(record[key] == value for key, value in intent(directory).items()), 'mutation record differs')
    return record


def operation_status(directory):
    record = intent(directory)
    if lease_is_held(directory / 'lease', record['lease']):
        return LIVE
    if not (directory / 'supervisor.json').exists():
        return UNKNOWN
    supervisor = read(directory, 'supervisor.json')['identity']
    if identity(supervisor['pid']) == supervisor:
        return LIVE
    if (directory / 'child.json').exists():
        child = read(directory, 'child.json')['identity']
        if identity(child['pid']) == child:
            return LIVE
    if not (directory / 'outcome.json').exists():
        return UNKNOWN
    outcome = read(directory, 'outcome.json')
    require(outcome['identity'] == supervisor and outcome['localGroupEnded'] is True,
            'mutation outcome does not establish local group completion')
    return ENDED


def inspect_operations(journal_directory, contract):
    root = journal_directory / 'mutations'
    if not root.exists():
        return []
    private_directory(root)
    operations = []
    for directory in sorted(root.iterdir()):
        require(intent(directory)['contractSha256'] == digest(encode(contract)), 'mutation scope differs')
        operations.append({'operation': directory.name, 'stage': intent(directory)['stage'],
                           'status': operation_status(directory)})
    return operations
