#!/usr/bin/python3 -I
import base64
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SSHD_CONFIG = Path("/etc/pots-door/sshd_config")
SUDO_RULES = Path("/etc/sudoers.d/pots-door-bindings")
VISUDO = "/usr/sbin/visudo"
DOOR = "/usr/local/sbin/pots-door"
DOOR_USER = "door"
FORCED_COMMAND = f"/usr/bin/sudo -n {DOOR}"
PUBLIC_FILE = 0o644
SUDO_RULES_FILE = 0o440
POT = re.compile(r"[a-z][a-z0-9-]{0,30}")
KEY_TYPE = "ssh-ed25519"
ACCESS = ("ask", "reply")
ED25519_BLOB_PREFIX = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20"
ED25519_BLOB_BYTES = len(ED25519_BLOB_PREFIX) + 32
USAGE = "usage: door-keys.py prepare | host-key | install SELF < 'CALLER ask|reply ssh-ed25519 KEY' lines"


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


# sudo reads every file of /etc/sudoers.d whose name holds no dot, so a pending copy carries one.
def write_pending(path, text, mode):
    pending = tempfile.NamedTemporaryFile("w", dir=path.parent, prefix=".", suffix=".pending", delete=False)
    with pending:
        pending.write(text)
    os.chmod(pending.name, mode)
    return pending.name


def replace_file(path, text, mode):
    os.replace(write_pending(path, text, mode), path)


def replace_sudo_rules(text):
    pending = write_pending(SUDO_RULES, text, SUDO_RULES_FILE)
    if subprocess.run([VISUDO, "--check", "--quiet", "--file", pending]).returncode:
        os.unlink(pending)
        fail(f"visudo refused the door's sudo rules; {SUDO_RULES} and the keys are unchanged")
    os.replace(pending, SUDO_RULES)


def prepare():
    host_key = configured_path("HostKey")
    if not host_key.exists():
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", str(host_key)], check=True)
    authorized = configured_path("AuthorizedKeysFile")
    if not authorized.exists():
        replace_file(authorized, "", PUBLIC_FILE)


def host_key():
    words = Path(str(configured_path("HostKey")) + ".pub").read_text().split()
    if len(words) < 2 or words[0] != KEY_TYPE or not checked_key(words[1]):
        fail("the door host key is not an ed25519 key; run vm/setup.sh again")
    print(KEY_TYPE, words[1])


def binding(row, receiver, seen):
    words = row.split()
    if len(words) != 4 or not POT.fullmatch(words[0]) or words[1] not in ACCESS or words[2] != KEY_TYPE or not checked_key(words[3]):
        fail(f"refused line {row!r}: expected 'CALLER ask|reply ssh-ed25519 KEY'")
    caller, access, key = words[0], words[1], words[3]
    if caller == receiver or caller in seen:
        fail(f"refused caller {caller}: it is this pot or it appears twice")
    seen.add(caller)
    return caller, access, key


def authorized_line(caller, receiver, access, key):
    return f'restrict,command="{FORCED_COMMAND} {caller} {receiver} {access}" {KEY_TYPE} {key} door:{caller}\n'


def sudo_rule(caller, receiver, access):
    return f"{DOOR_USER} ALL=(root) NOPASSWD: {DOOR} {caller} {receiver} {access}\n"


# The rules go in before the keys: a key whose rule is gone or not there yet fails at sudo, never runs another binding.
def install(receiver):
    if not POT.fullmatch(receiver):
        fail(f"refused pot name {receiver!r}")
    seen = set()
    bindings = [binding(row, receiver, seen) for row in sys.stdin.read().splitlines() if row.strip()]
    replace_sudo_rules("".join(sudo_rule(caller, receiver, access) for caller, access, _ in bindings))
    keys = "".join(authorized_line(caller, receiver, access, key) for caller, access, key in bindings)
    replace_file(configured_path("AuthorizedKeysFile"), keys, PUBLIC_FILE)
    print(f"door-keys: {len(bindings)} caller(s) may knock at {receiver}", file=sys.stderr)


ACTIONS = {("prepare",): prepare, ("host-key",): host_key}
if tuple(sys.argv[1:]) in ACTIONS:
    ACTIONS[tuple(sys.argv[1:])]()
elif len(sys.argv) == 3 and sys.argv[1] == "install":
    install(sys.argv[2])
else:
    fail(USAGE)
