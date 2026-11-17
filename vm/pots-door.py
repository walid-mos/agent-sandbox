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
SESSION_USER = "abc"
RECEIVER = "/opt/agent-sandbox/session/door-receive"
CALLER_TAG_PREFIX = "tag:pot-"
MESSAGE_LIMIT_BYTES = 16384
WHOIS_SECONDS = 5
DELIVERY_SECONDS = 45
KNOCK_BURST = 10
KNOCK_REFILL_SECONDS = 120
POT = re.compile(r"[a-z][a-z0-9-]{0,30}")
HEADER = re.compile(r"(?:(request) ([a-z][a-z0-9-]{0,30})\.([a-z0-9]{8,32}) [0-9]|(reply) ([a-z][a-z0-9-]{0,30})\.([a-z0-9]{8,32}))")
MALFORMED = 64
TOO_LARGE = 65
NO_SESSION = 69
DELIVERY_FAILED = 70
TRY_LATER = 75
NOT_ALLOWED = 77


def refuse(status, reason):
    print("pots-door: " + reason, file=sys.stderr)
    sys.exit(status)


def bound_names():
    names = sys.argv[1:]
    if len(names) != 2 or not all(POT.fullmatch(name) for name in names) or names[0] == names[1]:
        refuse(NOT_ALLOWED, "this key is not bound to a caller")
    return names


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


# Every knock that passed the caller check spends a token, refused messages included, under the caller's lock.
def spend_token(caller):
    bucket_path = STATE / (caller + ".json")
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
        refuse(TOO_LARGE, f"the message is over {MESSAGE_LIMIT_BYTES} bytes")
    if b"\0" in raw:
        refuse(MALFORMED, "the message holds a NUL byte")
    try:
        return raw, raw.decode("utf-8")
    except UnicodeDecodeError:
        refuse(MALFORMED, "the message is not UTF-8")


def request_id(text, caller, receiver):
    header, separator, note = text.partition("\n")
    match = HEADER.fullmatch(header)
    if not separator or not match:
        refuse(MALFORMED, "the first line must be 'request <origin>.<nonce> <hop>' or 'reply <origin>.<nonce>', ended by LF")
    if not note.strip():
        refuse(MALFORMED, "the note is empty")
    kind, origin, nonce = [part for part in match.groups() if part is not None]
    expected = caller if kind == "request" else receiver
    if origin != expected:
        refuse(MALFORMED, f"a {kind} from {caller} must carry the origin {expected}, not {origin}")
    return origin + "." + nonce


def session_label():
    for line in LAUNCH_ENV.read_text().splitlines():
        name, _, value = line.partition("=")
        if name == "POTS_SESSION_LABEL":
            return value
    refuse(NO_SESSION, f"{LAUNCH_ENV} names no POTS_SESSION_LABEL")


def session_container():
    listing = subprocess.run([DOCKER, "ps", "--filter", "label=" + session_label(), "--filter", "status=running",
                              "--format", "{{.Names}}"], capture_output=True, text=True)
    names = listing.stdout.split()
    if listing.returncode or not names:
        refuse(NO_SESSION, "this pot has no running session")
    return names[0]


# The session's output never reaches the caller: it could carry text written to steer the caller's bot.
def deliver(raw, caller, container):
    command = [DOCKER, "exec", "--interactive", "--user", SESSION_USER, container, RECEIVER, caller]
    try:
        result = subprocess.run(command, input=raw, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=DELIVERY_SECONDS)
    except subprocess.TimeoutExpired:
        refuse(DELIVERY_FAILED, f"the session did not take the message within {DELIVERY_SECONDS} seconds")
    if result.returncode:
        refuse(DELIVERY_FAILED, "the session refused the message")


caller, receiver = bound_names()
check_caller_node(caller)
lock = hold_caller_lock(caller)
spend_token(caller)
raw, text = read_message()
identifier = request_id(text, caller, receiver)
deliver(raw, caller, session_container())
print("delivered " + identifier)
