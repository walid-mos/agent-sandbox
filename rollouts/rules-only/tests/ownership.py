import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

WORKTREE = str(Path(__file__).resolve().parents[3])


def process_identity(pid):
    try:
        os.kill(pid, 0)
        status = Path(f'/proc/{pid}/stat')
        if status.is_file():
            return status.read_text().rsplit(')', 1)[1].split()[19]
        return subprocess.check_output(['ps', '-o', 'lstart=', '-p', str(pid)], timeout=5).decode().strip()
    except ProcessLookupError:
        return 'ended'
    except (OSError, subprocess.SubprocessError):
        return 'unknown'


def write_record(path, record):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(record, output)
        output.flush()
        os.fsync(output.fileno())


def matches_receipt(receipt, record):
    return (not receipt.is_symlink() and receipt.is_file() and receipt.stat().st_uid == os.getuid()
            and json.loads(receipt.read_bytes()) == record)


def remove_owned(receipt, record):
    root = Path(record['path'])
    if not matches_receipt(receipt, record):
        return False
    if not root.exists() and not root.is_symlink():
        receipt.unlink()
        return True
    if root.is_symlink() or root.parent != Path(tempfile.gettempdir()).resolve():
        return False
    marker = root / 'fixture-owner.json'
    info = root.stat()
    is_owned = (root.name == record['runId'] and info.st_uid == record['uid'] == os.getuid()
                and info.st_ino == record['inode'] and not info.st_mode & 0o077
                and not marker.is_symlink() and marker.is_file()
                and json.loads(marker.read_bytes()) == record)
    if not is_owned:
        return False
    shutil.rmtree(root)
    receipt.unlink()
    return True


def reconcile_ended_fixtures():
    for receipt in Path(tempfile.gettempdir()).glob('rules-only-*.ownership.json'):
        reconcile_receipt(receipt)


def reconcile_receipt(receipt):
    try:
        if receipt.is_symlink() or receipt.stat().st_uid != os.getuid():
            return
        record = json.loads(receipt.read_bytes())
        if record['worktree'] != WORKTREE or record['uid'] != os.getuid():
            return
        identity = process_identity(record['pid'])
        if identity in ('unknown', record['pidStart']):
            return
        remove_owned(receipt, record)
    except (OSError, ValueError, KeyError):
        return


class OwnedFixture:
    def __init__(self, case):
        self.isHeld = False
        self.name = None
        self.receipt = None
        self.record = None
        case.addCleanup(self.cleanup)
        reconcile_ended_fixtures()
        self.name = tempfile.mkdtemp(prefix='rules-only-')
        root = Path(self.name).resolve()
        self.receipt = root.parent / f'{root.name}.ownership.json'
        self.record = {'runId': root.name, 'path': str(root), 'inode': root.stat().st_ino,
                       'uid': os.getuid(), 'pid': os.getpid(), 'pidStart': process_identity(os.getpid()),
                       'worktree': WORKTREE, 'networkEndpoint': None}
        write_record(self.receipt, self.record)
        write_record(root / 'fixture-owner.json', self.record)

    def cleanup(self):
        if self.isHeld or self.receipt is None or not self.receipt.exists():
            return
        remove_owned(self.receipt, self.record)
