import json
import os
from pathlib import Path
import re
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
from client_rules import RulesRefused, replace_file, unique_keys

STATE = Path('/var/lib/pots-usage')
HOST_ID = re.compile('[a-f0-9]{32}')
DAY_NAME = re.compile('[0-9]{4}-[0-9]{2}-[0-9]{2}')
FILE_LIMIT = 16384


class UsageRefused(RuntimeError):
    pass


def private_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise UsageRefused('Expected a private usage directory owned by the service user.')
    return path


def read_private(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise UsageRefused('Expected a private regular usage file owned by the service user.')
        content = source.read(FILE_LIMIT + 1)
    if len(content) > FILE_LIMIT:
        raise UsageRefused('Usage file exceeds the size limit.')
    return content


def parse_object(content):
    try:
        value = json.loads(content, object_pairs_hook=unique_keys)
    except (ValueError, RulesRefused, RecursionError):
        raise UsageRefused('Expected an unambiguous usage JSON object.') from None
    if not isinstance(value, dict):
        raise UsageRefused('Expected a usage JSON object.')
    return value


def stored_host(state):
    host = read_private(state / 'host-id').decode('ascii').strip()
    if not HOST_ID.fullmatch(host):
        raise UsageRefused('Invalid provisioned usage identity.')
    return host


def schedule_owner(state):
    try:
        owner = read_private(state / 'schedule-owner').strip()
    except FileNotFoundError:
        return b'vm'
    if owner not in (b'vm', b'pot'):
        raise UsageRefused('Expected schedule-owner to contain vm or pot.')
    return owner
