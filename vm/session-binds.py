#!/usr/bin/env python3
import ctypes
import os
import sys

MS_RDONLY = 1
MS_REMOUNT = 32
MS_BIND = 4096
MNT_DETACH = 2
libc = ctypes.CDLL(None, use_errno=True)


def checked(step, result):
    if result != 0:
        raise SystemExit(f"session-binds: {step}: {os.strerror(ctypes.get_errno())}")


def identity(path):
    try:
        status = os.stat(path)
    except OSError:
        return None
    return status.st_dev, status.st_ino


def rebind(target, source):
    checked(f"detach {target}", libc.umount2(target.encode(), MNT_DETACH))
    checked(f"bind {source} on {target}", libc.mount(source.encode(), target.encode(), None, MS_BIND, None))
    checked(f"read-only {target}", libc.mount(None, target.encode(), None, MS_BIND | MS_REMOUNT | MS_RDONLY, None))
    print(f"session-binds: bound {source} on {target} again")


def is_below(path, directory):
    return os.path.commonpath([path, directory]) == directory


if len(sys.argv) < 2:
    raise SystemExit("usage: session-binds.py session-pid [target=source ...]")
session_pid, *binds = sys.argv[1:]
pairs = [bind.split("=", 1) for bind in binds]
# A source resolves inside the session only below a directory it binds at its own path, the Development directory that holds the Git checkouts.
shared = [source for target, source in pairs if target == source]
refreshable = [(target, source) for target, source in pairs if any(is_below(source, directory) for directory in shared)]
os.setns(os.open(f"/proc/{session_pid}/ns/mnt", os.O_RDONLY), os.CLONE_NEWNS)
for target, source in refreshable:
    current = identity(source)
    if current is None:
        raise SystemExit(f"session-binds: {source} is missing. Put the Mac checkout back on the branch that holds it, then run the watchdog again.")
    if identity(target) != current:
        rebind(target, source)
