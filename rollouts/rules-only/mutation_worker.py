import fcntl
import json
import os
from pathlib import Path
import signal
import sys
import tempfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from guards import MAX_BYTES, private_directory, read_json, require
from git_boundary import prove_git_directory
from mutation_records import intent, read, store
from process_state import identity, wait_group


def request():
    header = sys.stdin.buffer.readline(MAX_BYTES)
    require(header.endswith(b'\n'), 'mutation request incomplete')
    parsed = json.loads(header)
    require(set(parsed) == {'arguments', 'fixtureRoot'} and parsed['arguments']
            and all(isinstance(value, str) for value in parsed['arguments']), 'mutation request differs')
    payload = sys.stdin.buffer.read(MAX_BYTES + 1)
    require(len(payload) <= MAX_BYTES, 'mutation input exceeds supported size')
    return parsed, payload


def validate(directory, parsed):
    scope = read_json(directory.parent.parent / 'contract.json')
    arguments = parsed['arguments']
    if arguments[0] == 'git':
        require(arguments.count('-C') == 1 and arguments[arguments.index('-C') + 1] == scope['privateCheckout'],
                'mutation Git target differs from contract')
        prove_git_directory(scope['privateCheckout'])
    if parsed['fixtureRoot']:
        from fixture_boundary import validate_launch
        validate_launch(Path(parsed['fixtureRoot']), arguments, arguments[0])


def child(arguments, payload, directory, lease):
    with tempfile.TemporaryFile(dir=directory) as source:
        source.write(payload)
        source.seek(0)
        reader, writer = os.pipe()
        pid = os.fork()
        if pid == 0:
            execute_child(arguments, source.fileno(), reader, writer, lease)
        os.close(reader)
        store(directory, 'child.json', {'identity': identity(pid)})
        os.write(writer, b'G')
        os.close(writer)
        _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


def execute_child(arguments, source, reader, writer, lease):
    os.close(writer)
    if os.read(reader, 1) != b'G':
        os._exit(125)
    os.close(reader)
    os.dup2(source, 0)
    os.close(source)
    os.set_inheritable(lease, True)
    os.execvpe(arguments[0], arguments, dict(os.environ))


def ignore_signal(*_):
    pass


def main():
    directory = private_directory(Path(sys.argv[1]))
    intent(directory)
    parsed, payload = request()
    supervisor = read(directory, 'supervisor.json')['identity']
    require(supervisor == identity(os.getpid()), 'supervisor does not match its durable identity')
    lease = os.open(directory / 'lease', os.O_RDWR | os.O_NOFOLLOW)
    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    signal.signal(signal.SIGTERM, ignore_signal)
    signal.signal(signal.SIGINT, ignore_signal)
    validate(directory, parsed)
    returncode = child(parsed['arguments'], payload, directory, lease)
    wait_group(supervisor['group'])
    os.close(lease)
    lease = os.open(directory / 'lease', os.O_RDWR | os.O_NOFOLLOW)
    fcntl.flock(lease, fcntl.LOCK_EX)
    store(directory, 'outcome.json', {'identity': supervisor, 'returncode': returncode, 'localGroupEnded': True})
    os.close(lease)
    return 0 if returncode == 0 else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('Mutation supervision incomplete. Retain private evidence and reconcile ownership.', file=sys.stderr)
        sys.exit(1)
