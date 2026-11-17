#!/usr/bin/python3 -I
import base64
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SSHD_CONFIG = Path("/etc/pots-door/sshd_config")
FORCED_COMMAND = "/usr/bin/sudo -n /usr/local/sbin/pots-door"
POT = re.compile(r"[a-z][a-z0-9-]{0,30}")
KEY_TYPE = "ssh-ed25519"
ED25519_BLOB_PREFIX = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20"
ED25519_BLOB_BYTES = len(ED25519_BLOB_PREFIX) + 32
USAGE = "usage: door-keys.py prepare | host-key | install SELF < 'CALLER ssh-ed25519 KEY' lines"


def fail(message):
    print("door-keys: " + message, file=sys.stderr)
    sys.exit(1)


def configured_path(keyword):
    for line in SSHD_CONFIG.read_text().splitlines():
        words = line.split()
        if len(words) == 2 and words[0].lower() == keyword.lower():
            return Path(words[1])
    fail(f"{SSHD_CONFIG} sets no {keyword}")


def checked_key(blob):
    try:
        raw = base64.b64decode(blob, validate=True)
    except ValueError:
        return False
    return len(raw) == ED25519_BLOB_BYTES and raw.startswith(ED25519_BLOB_PREFIX)


def replace_file(path, text):
    pending = tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False)
    with pending:
        pending.write(text)
    os.chmod(pending.name, 0o644)
    os.replace(pending.name, path)


def prepare():
    host_key = configured_path("HostKey")
    if not host_key.exists():
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", str(host_key)], check=True)
    authorized = configured_path("AuthorizedKeysFile")
    if not authorized.exists():
        replace_file(authorized, "")


def host_key():
    words = Path(str(configured_path("HostKey")) + ".pub").read_text().split()
    if len(words) < 2 or words[0] != KEY_TYPE or not checked_key(words[1]):
        fail("the door host key is not an ed25519 key; run vm/setup.sh again")
    print(KEY_TYPE, words[1])


def caller_line(row, receiver, seen):
    words = row.split()
    if len(words) != 3 or not POT.fullmatch(words[0]) or words[1] != KEY_TYPE or not checked_key(words[2]):
        fail(f"refused line {row!r}: expected 'CALLER ssh-ed25519 KEY'")
    caller = words[0]
    if caller == receiver or caller in seen:
        fail(f"refused caller {caller}: it is this pot or it appears twice")
    seen.add(caller)
    return f'restrict,command="{FORCED_COMMAND} {caller} {receiver}" {KEY_TYPE} {words[2]} door:{caller}\n'


def install(receiver):
    if not POT.fullmatch(receiver):
        fail(f"refused pot name {receiver!r}")
    seen = set()
    lines = [caller_line(row, receiver, seen) for row in sys.stdin.read().splitlines() if row.strip()]
    replace_file(configured_path("AuthorizedKeysFile"), "".join(lines))
    print(f"door-keys: {len(lines)} caller(s) may knock at {receiver}", file=sys.stderr)


ACTIONS = {("prepare",): prepare, ("host-key",): host_key}
if tuple(sys.argv[1:]) in ACTIONS:
    ACTIONS[tuple(sys.argv[1:])]()
elif len(sys.argv) == 3 and sys.argv[1] == "install":
    install(sys.argv[2])
else:
    fail(USAGE)
