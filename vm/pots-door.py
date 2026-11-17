#!/usr/bin/python3 -I
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

LAUNCH_ENV = Path("/etc/pots-door/launch.env")
STATE = Path("/var/lib/pots-door")
DOCKER = "/usr/bin/docker"
TAILSCALE = "/usr/bin/tailscale"
RECEIVER = "/opt/agent-sandbox/session/door-receive"
CALLER_TAG_PREFIX = "tag:pot-"
MESSAGE_LIMIT_BYTES = 16384
WHOIS_SECONDS = 5
DELIVERY_SECONDS = 45
KNOCK_BURST = 10
KNOCK_REFILL_SECONDS = 120
DELIVERIES = "deliveries"
REFUSALS = "refusals"
POT = re.compile(r"[a-z][a-z0-9-]{0,30}")
ACCESS = ("ask", "reply")
REPLIES_ONLY = "reply"
HEADER = re.compile(r"(?:(request) ([a-z][a-z0-9-]{0,30})\.([a-z0-9]{8,32}) [0-9]|(reply) ([a-z][a-z0-9-]{0,30})\.([a-z0-9]{8,32})|(dialog) ([a-z][a-z0-9-]{0,30})\.([a-z0-9]{8,32}))")
MALFORMED = 64
TOO_LARGE = 65
NO_SESSION = 69
DELIVERY_FAILED = 70
TRY_LATER = 75
SESSION_REFUSED = 76
NOT_ALLOWED = 77
# Docker resolves --user from the image's account, not the one the session's init renumbered, so the session resolves it once that init has finished.
AS_SESSION_USER = 's6-rc -a list < /dev/null 2> /dev/null | grep -qx "$1" || exit 1; exec s6-setuidgid "$2" env HOME="$3" "$4" "$5"'


class Refusal(Exception):
    def __init__(self, status, reason):
        super().__init__(reason)
        self.status = status
        self.reason = reason


def refuse(status, reason):
    print("pots-door: " + reason, file=sys.stderr)
    sys.exit(status)


def bound_access():
    bound = sys.argv[1:]
    if len(bound) != 3 or not all(POT.fullmatch(name) for name in bound[:2]) or bound[0] == bound[1] or bound[2] not in ACCESS:
        refuse(NOT_ALLOWED, "this key is not bound to a caller")
    return bound


def connecting_node_tags():
    words = os.environ.get("SSH_CLIENT", "").split()
    if len(words) != 3:
        return []
    try:
        result = subprocess.run([TAILSCALE, "whois", "--json", words[0]], capture_output=True, text=True,
                                timeout=WHOIS_SECONDS)
        return json.loads(result.stdout)["Node"].get("Tags") or []
    except (subprocess.TimeoutExpired, ValueError, KeyError, TypeError, AttributeError):
        return []


# A stolen key used from any other tailnet node fails here, since only the caller's own node carries its tag.
def check_caller_node(caller):
    if CALLER_TAG_PREFIX + caller not in connecting_node_tags():
        refuse(NOT_ALLOWED, f"this key belongs to {caller}, and the connection comes from another node")


def hold_caller_lock(caller):
    handle = open(STATE / (caller + ".lock"), "w")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        refuse(TRY_LATER, "busy")
    return handle


def remaining_tokens(bucket_path, now):
    try:
        bucket = json.loads(bucket_path.read_text())
        refilled = max(0.0, now - bucket["at"]) / KNOCK_REFILL_SECONDS
        return min(float(KNOCK_BURST), bucket["tokens"] + refilled)
    except (OSError, ValueError, KeyError, TypeError):
        return float(KNOCK_BURST)


# Under the caller's lock, a knock the door refuses spends from its own bucket, so refused knocks never use up the caller's deliveries.
def spend_token(caller, bucket):
    bucket_path = STATE / f"{caller}.{bucket}.json"
    now = time.time()
    tokens = remaining_tokens(bucket_path, now)
    if tokens < 1:
        refuse(TRY_LATER, "rate")
    pending = bucket_path.with_suffix(".pending")
    pending.write_text(json.dumps({"tokens": tokens - 1, "at": now}))
    os.replace(pending, bucket_path)


def read_message():
    raw = sys.stdin.buffer.read(MESSAGE_LIMIT_BYTES + 1)
    if len(raw) > MESSAGE_LIMIT_BYTES:
        raise Refusal(TOO_LARGE, f"the message is over {MESSAGE_LIMIT_BYTES} bytes")
    if b"\0" in raw:
        raise Refusal(MALFORMED, "the message holds a NUL byte")
    try:
        return raw, raw.decode("utf-8")
    except UnicodeDecodeError:
        raise Refusal(MALFORMED, "the message is not UTF-8") from None


def request_id(text, caller, receiver, access):
    header, separator, note = text.partition("\n")
    match = HEADER.fullmatch(header)
    if not separator or not match:
        raise Refusal(MALFORMED, "the first line must be 'request <origin>.<nonce> <hop>' or 'reply <origin>.<nonce>' or 'dialog <origin>.<nonce>', ended by LF")
    if not note.strip():
        raise Refusal(MALFORMED, "the note is empty")
    kind, origin, nonce = [part for part in match.groups() if part is not None]
    if kind != "reply" and access == REPLIES_ONLY:
        raise Refusal(NOT_ALLOWED, f"{caller} may only reply to {receiver}, since the doors of {caller} do not name {receiver}")
    expected = receiver if kind == "reply" else caller
    if origin != expected:
        raise Refusal(MALFORMED, f"a {kind} from {caller} must carry the origin {expected}, not {origin}")
    return origin + "." + nonce


def checked_message(caller, receiver, access):
    raw, text = read_message()
    return raw, request_id(text, caller, receiver, access)


def launch_setting(name):
    for line in LAUNCH_ENV.read_text().splitlines():
        key, _, value = line.partition("=")
        if key == name:
            return value
    refuse(NO_SESSION, f"{LAUNCH_ENV} names no {name}")


def session_container():
    label = launch_setting("POTS_SESSION_LABEL")
    listing = subprocess.run([DOCKER, "ps", "--filter", "label=" + label, "--filter", "status=running",
                              "--format", "{{.Names}}"], capture_output=True, text=True)
    names = listing.stdout.split()
    if listing.returncode or not names:
        refuse(NO_SESSION, "this pot has no running session")
    return names[0]


# The session's output never reaches the caller: it could carry text written to steer the caller's bot.
def deliver(raw, caller, container):
    settings = [launch_setting(name) for name in ("POTS_SESSION_INIT_SERVICE", "POTS_SESSION_USER", "POTS_SESSION_HOME")]
    command = [DOCKER, "exec", "--interactive", "--user", "root", container, "sh", "-c", AS_SESSION_USER, "pots-door", *settings,
               RECEIVER, caller]
    try:
        result = subprocess.run(command, input=raw, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=DELIVERY_SECONDS)
    except subprocess.TimeoutExpired:
        refuse(DELIVERY_FAILED, f"the session did not take the message within {DELIVERY_SECONDS} seconds")
    if result.returncode == SESSION_REFUSED:
        refuse(SESSION_REFUSED, "refused")
    if result.returncode:
        refuse(DELIVERY_FAILED, "the session did not take the message")


def main():
    caller, receiver, access = bound_access()
    check_caller_node(caller)
    lock = hold_caller_lock(caller)
    try:
        raw, identifier = checked_message(caller, receiver, access)
    except Refusal as refusal:
        spend_token(caller, REFUSALS)
        refuse(refusal.status, refusal.reason)
    spend_token(caller, DELIVERIES)
    deliver(raw, caller, session_container())
    print("delivered " + identifier)
    lock.close()


if __name__ == "__main__":
    main()
