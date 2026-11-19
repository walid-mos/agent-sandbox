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
PROC = Path('/proc')
EXITED_STATES = (b'Z', b'X')


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


def task_stat(entry):
    _, separator, fields = (entry / 'stat').read_bytes().rpartition(b')')
    state, _, group, session, *_ = fields.split()
    if not separator or len(state) != 1:
        raise ValueError('Unreadable procfs task state.')
    return state, int(group), int(session)


def inspect_process_tasks(entry, group):
    state, process_group, session = task_stat(entry)
    if (process_group, session) != (group, group):
        return False
    if state not in EXITED_STATES:
        return True
    tasks = {task.name: task for task in (entry / 'task').iterdir() if task.name.isdecimal()}
    if entry.name not in tasks:
        raise ProcessLookupError('Incomplete task list for an in-scope process.')
    return any(task_stat(task)[0] not in EXITED_STATES for task in tasks.values())


def process_has_live_tasks(entry, group):
    try:
        return inspect_process_tasks(entry, group)
    except (FileNotFoundError, ProcessLookupError) as error:
        try:
            entry.stat()
        except (FileNotFoundError, ProcessLookupError):
            return False
        raise error


def has_live_members(group):
    return any(process_has_live_tasks(entry, group) for entry in PROC.iterdir() if entry.name.isdecimal())


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
