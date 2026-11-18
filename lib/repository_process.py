from contextlib import contextmanager
import os
from pathlib import Path
import select
import signal
import subprocess
import time

READ_SECONDS = 100
TERMINATION_SECONDS = 5
POLL_SECONDS = 0.02


class CleanupUnconfirmed(Exception):
    pass


@contextmanager
def worker_input(payload):
    reader, writer = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        if len(payload) > os.fpathconf(writer, 'PC_PIPE_BUF'):
            raise ValueError('Repository worker input exceeds the pipe limit.')
        os.write(writer, payload)
    except BaseException:
        os.close(reader)
        raise
    finally:
        os.close(writer)
    try:
        os.set_blocking(reader, True)
        yield reader
    finally:
        os.close(reader)


def wait_for_exit(pid, timeout):
    descriptor = os.pidfd_open(pid)
    try:
        poller = select.poll()
        poller.register(descriptor, select.POLLIN)
        if not poller.poll(timeout * 1000):
            raise subprocess.TimeoutExpired('repository worker', timeout)
    finally:
        os.close(descriptor)


def has_live_members(group):
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / 'stat').read_bytes().rsplit(b')', 1)[1].split()
        except (FileNotFoundError, ProcessLookupError):
            continue
        if int(fields[2]) == group and int(fields[3]) == group and fields[0] not in (b'Z', b'X'):
            return True
    return False


def leader_exited(pid):
    return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


def terminate_and_reap(process):
    group = process.pid
    deadline = time.monotonic() + TERMINATION_SECONDS
    try:
        while True:
            leader_exited(group)
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if leader_exited(group) and not has_live_members(group):
                return process.wait(timeout=max(0, deadline - time.monotonic()))
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(POLL_SECONDS, remaining))
    except BaseException:
        raise CleanupUnconfirmed() from None
    raise CleanupUnconfirmed()
