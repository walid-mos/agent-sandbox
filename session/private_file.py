#!/usr/bin/env python3
import os
import stat
import sys
import uuid
from pathlib import PurePosixPath

PRIVATE_DIRECTORY = 0o700
PRIVATE_FILE = 0o600
DIRECTORY_REFUSED = 73
WRITE_REFUSED = 74


def owned_directory(name, parent=None):
    descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    details = os.fstat(descriptor)
    if not stat.S_ISDIR(details.st_mode) or details.st_uid != os.getuid():
        os.close(descriptor)
        raise PermissionError()
    return descriptor


def child_directory(name, parent):
    try:
        os.mkdir(name, PRIVATE_DIRECTORY, dir_fd=parent)
    except FileExistsError:
        pass
    return owned_directory(name, parent)


def directory_descriptor(relative):
    components = relative.split("/")
    if any(component in ("", ".", "..") for component in components):
        raise ValueError()
    descriptor = owned_directory(os.environ["HOME"])
    try:
        for component in components:
            nested = child_directory(component, descriptor)
            os.close(descriptor)
            descriptor = nested
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def replace_file(name, content, directory):
    if not name or name in (".", "..") or PurePosixPath(name).name != name or "\\" in name:
        raise ValueError()
    pending = f".{name}.{uuid.uuid4().hex}.next"
    descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, PRIVATE_FILE, dir_fd=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as output:
            os.fchmod(output.fileno(), PRIVATE_FILE)
            output.write(content)
        os.replace(pending, name, src_dir_fd=directory, dst_dir_fd=directory)
    finally:
        try:
            os.unlink(pending, dir_fd=directory)
        except FileNotFoundError:
            pass


def main():
    try:
        relative, name = sys.argv[1:]
        directory = directory_descriptor(relative)
    except (OSError, ValueError, KeyError):
        return DIRECTORY_REFUSED
    try:
        replace_file(name, sys.stdin.read(), directory)
    except (OSError, ValueError, UnicodeError):
        return WRITE_REFUSED
    finally:
        os.close(directory)
    return 0


if __name__ == "__main__":
    sys.exit(main())
