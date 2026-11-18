import os
from pathlib import Path
import signal
import time

READ_SECONDS = 100
TERMINATION_SECONDS = 5
POLL_SECONDS = 0.02


def workers_in_group(uid, group):
    members = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            ownership = (entry / 'status').read_text().splitlines()
        except OSError:
            continue
        if int(fields[2]) != group or fields[0] == 'Z':
            continue
        identities = [item for item in ownership if item.startswith('Uid:')]
        if identities and int(identities[0].split()[1]) == uid:
            members.append(int(entry.name))
    return members


class WorkerWindow:
    # The descriptor pins the spawned worker's pid while the group is being
    # terminated, so a recycled pid cannot redirect the kill to another
    # process before every owned descendant is verified stopped.
    def __init__(self, process, uid, group):
        self.process = process
        self.uid = uid
        self.group = group
        self.descriptor = os.pidfd_open(process.pid)

    def terminate(self):
        deadline = time.monotonic() + TERMINATION_SECONDS
        while True:
            members = workers_in_group(self.uid, self.group)
            if not members:
                return []
            try:
                os.killpg(self.group, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if time.monotonic() >= deadline:
                return workers_in_group(self.uid, self.group)
            time.sleep(POLL_SECONDS)

    def release(self):
        try:
            self.process.wait()
        finally:
            os.close(self.descriptor)
