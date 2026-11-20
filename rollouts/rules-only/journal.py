import fcntl
import os
from pathlib import Path
import uuid

from guards import PRIVATE_MODE, Refused, digest, encode, private_directory, private_file, read_json, require
from process_state import LIVE, identity, lease_identity, lease_is_held


def fsync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def create(path, content, mode=PRIVATE_MODE):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            os.fchmod(output.fileno(), mode)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
    finally:
        fsync_directory(path.parent)


def create_ownership(marker, contract):
    descriptor = os.open(marker, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, PRIVATE_MODE)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        ownership = {'runId': contract['runId'], 'contractSha256': digest(encode(contract)),
                     'journal': contract['journal'], 'uid': os.getuid(), 'owner': identity(os.getpid()),
                     'lease': lease_identity(marker), 'nonce': uuid.uuid4().hex}
        with os.fdopen(os.dup(descriptor), 'wb') as output:
            output.write(encode(ownership))
            output.flush()
            os.fsync(output.fileno())
        fsync_directory(marker.parent)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


class Journal:
    def __init__(self, contract, fault, termination):
        self.directory = Path(contract['journal'])
        self.fault = fault
        self.termination = termination
        self.current_step = ''
        self.contract_hash = digest(encode(contract))
        parent = private_directory(self.directory.parent)
        self.marker = parent / (self.directory.name + '.ownership.json')
        require(not self.marker.exists() and not self.directory.exists() and not self.directory.is_symlink(),
                'RECONCILE: attempt exists. Use inspect with its original contract. Never rerun.')
        require(Path(contract['runId']).name == contract['runId']
                and contract['runId'] not in ('.', '..'), 'invalid run identity')
        self.owner_descriptor = create_ownership(self.marker, contract)
        self.directory.mkdir(mode=0o700)
        fsync_directory(parent)
        self.events = self.directory / 'events.jsonl'
        create(self.events, b'')
        create(self.directory / 'contract.json', encode(contract))
        self.append('ownership', 'confirmed', {'runId': contract['runId']})

    def append(self, step, status, proof=None):
        descriptor = os.open(self.events, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'ab') as output:
            output.write(encode_line({'step': step, 'status': status, 'proof': proof or {}}))
            output.flush()
            os.fsync(output.fileno())

    def close(self):
        os.close(self.owner_descriptor)

    def step(self, name, action):
        with self.termination.protect():
            self.current_step = name
            self.append(name, 'intent')
            return self.perform(name, action)

    def perform(self, name, action):
        try:
            self.inject(name, 'before')
            proof = action() or {}
            self.inject(name, 'after')
            self.append(name, 'confirmed', proof)
            return proof
        except BaseException:
            self.append(name, 'failed-unknown')
            raise Refused(f'RECONCILE: {name} has no confirmed completion. Use inspect. No retry or rollback.') from None

    def inject(self, name, point):
        if self.fault == f'{name}:{point}':
            raise Refused('synthetic write failure')
        if self.fault == f'{name}:crash-{point}':
            os._exit(86)


def encode_line(value):
    import json
    return (json.dumps(value, sort_keys=True) + '\n').encode()


def inspect_journal(contract):
    directory = Path(contract['journal'])
    private_directory(directory.parent)
    marker = read_json(private_file(directory.parent / (directory.name + '.ownership.json')))
    expected = {'runId': contract['runId'], 'contractSha256': digest(encode(contract)),
                'journal': str(directory), 'uid': os.getuid()}
    require(set(marker) == {*expected, 'owner', 'lease', 'nonce'}
            and all(marker[key] == value for key, value in expected.items()), 'ownership does not match')
    path = directory.parent / (directory.name + '.ownership.json')
    is_live = lease_is_held(path, marker['lease']) or identity(marker['owner']['pid']) == marker['owner']
    return read_events(directory, contract), LIVE if is_live else 'OWNER-ENDED'


def read_events(directory, contract):
    if not directory.exists():
        return [{'step': 'initialization', 'status': 'intent'}]
    private_directory(directory)
    if not (directory / 'contract.json').exists() or not (directory / 'events.jsonl').exists():
        return [{'step': 'initialization', 'status': 'intent'}]
    require(read_json(private_file(directory / 'contract.json')) == contract, 'retained contract differs')
    events = private_file(directory / 'events.jsonl').read_bytes()
    if not events:
        return [{'step': 'initialization', 'status': 'intent'}]
    require(events.endswith(b'\n'), 'RECONCILE: torn journal. Retain all bytes for owner inspection.')
    import json
    records = [json.loads(line) for line in events.splitlines()]
    require(all(set(record) == {'step', 'status', 'proof'} for record in records), 'invalid journal')
    return [{'step': record['step'], 'status': record['status']} for record in records]
