import fcntl
import os
from pathlib import Path
import platform
import select
import selectors
import subprocess

from guards import COMMAND_SECONDS, environment, private_file, require

LIVE = 'LIVE'
UNKNOWN = 'UNKNOWN'
ENDED = 'LOCAL-GROUP-ENDED'


def identity(pid):
    if platform.system() == 'Linux':
        return linux_identity(pid)
    output = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart='], env=environment(),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=COMMAND_SECONDS)
    if output.returncode:
        return {'pid': pid, 'state': 'ended'}
    return {'pid': pid, 'start': output.stdout.decode().strip(), 'group': os.getpgid(pid),
            'session': os.getsid(pid), 'state': 'present', 'precision': 'lease-bound-start-time'}


def linux_identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    except (FileNotFoundError, ProcessLookupError):
        return {'pid': pid, 'state': 'ended'}
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    return {'pid': pid, 'start': boot + ':' + fields[19], 'group': int(fields[2]),
            'session': int(fields[3]), 'state': 'ended' if fields[0] == 'Z' else 'present',
            'precision': 'kernel-start-ticks'}


def lease_identity(path):
    info = private_file(path).stat()
    require(info.st_nlink == 1, 'shared process lease refused')
    return {'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid}


def lease_is_held(path, expected):
    require(lease_identity(path) == expected, 'process lease identity differs')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        return descriptor_is_held(descriptor)
    finally:
        os.close(descriptor)


def descriptor_is_held(descriptor):
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    fcntl.flock(descriptor, fcntl.LOCK_UN)
    return False


def group_members(group):
    if platform.system() == 'Linux':
        members = [linux_identity(int(path.name)) for path in Path('/proc').iterdir() if path.name.isdecimal()]
        return [member for member in members if member.get('group') == group
                and member['pid'] != os.getpid() and member['state'] == 'present']
    output = subprocess.run(['/bin/ps', '-ax', '-o', 'pid=,pgid=,stat='], env=environment(),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=COMMAND_SECONDS, check=True)
    rows = [line.split() for line in output.stdout.decode().splitlines()]
    members = [identity(int(pid)) for pid, pgid, status in rows if int(pgid) == group
               and int(pid) != os.getpid() and not status.startswith('Z')]
    return [member for member in members if member.get('group') == group and member['state'] == 'present']


def wait_process(member):
    if identity(member['pid']) != member:
        return
    if platform.system() == 'Linux':
        wait_linux(member)
        return
    with select.kqueue() as queue:
        event = select.kevent(member['pid'], filter=select.KQ_FILTER_PROC,
                              flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT)
        try:
            queue.control([event], 0, 0)
        except ProcessLookupError:
            return
        if identity(member['pid']) == member:
            queue.control(None, 1, None)


def wait_linux(member):
    try:
        descriptor = os.pidfd_open(member['pid'])
    except ProcessLookupError:
        return
    try:
        if identity(member['pid']) != member:
            return
        with selectors.DefaultSelector() as waiter:
            waiter.register(descriptor, selectors.EVENT_READ)
            waiter.select()
    finally:
        os.close(descriptor)


def wait_group(group):
    members = group_members(group)
    while members:
        for member in members:
            wait_process(member)
        members = group_members(group)
