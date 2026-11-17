#!/usr/bin/env python3
import json
import sys

from tailnet_node import ADMIN_PORT, DOOR_PORT, ROLES, login_guidance, node_tag, read_operator_login

KEYS_TAG = "tag:pot-keys"
KEYS_TAG_OWNER = "autogroup:admin"
ASK = "ask"
REPLY = "reply"
USAGE = "usage: tailnet_policy.py access|policy SETTINGS_DIRECTORY < lines 'POT DOOR...', one per pot of the mesh, each with the pots its doors name"


def fail(message):
    print("tailnet_policy: " + message, file=sys.stderr)
    sys.exit(1)


def read_mesh(lines):
    rows = [line.split() for line in lines if line.strip()]
    pots = [row[0] for row in rows]
    for pot in pots:
        node_tag("host", pot)
    if len(set(pots)) != len(pots):
        fail(f"a pot appears twice among {pots}")
    doors = {row[0]: row[1:] for row in rows}
    problems = [f"the doors of {pot} name {receiver}" for pot, named in doors.items() for receiver in named
                if receiver == pot or receiver not in doors]
    if problems:
        fail("; ".join(problems) + ". A pot's doors name other pots of the mesh, and every pot of the mesh is listed.")
    return doors


# A reply travels through the asker's door, so the pot that is asked may knock back, but only to reply.
def door_access(doors):
    asks = {(caller, receiver) for caller, named in doors.items() for receiver in named}
    replies = {(receiver, caller) for caller, receiver in asks if (receiver, caller) not in asks}
    return sorted([(caller, receiver, ASK) for caller, receiver in asks] +
                  [(caller, receiver, REPLY) for caller, receiver in replies])


def tcp(ports):
    first, last = ports
    return f"tcp:{first}" if first == last else f"tcp:{first}-{last}"


def door_grants(doors):
    receivers = {}
    for caller, receiver, _ in door_access(doors):
        receivers.setdefault(caller, []).append(node_tag("host", receiver))
    return [{"src": [node_tag("session", caller)], "dst": hosts, "ip": [tcp((DOOR_PORT, DOOR_PORT))]}
            for caller, hosts in sorted(receivers.items())]


def policy(doors, settings):
    login = read_operator_login(settings) or fail(login_guidance(settings))
    pots = sorted(doors)
    owners = {KEYS_TAG: [KEYS_TAG_OWNER]} | {node_tag(role, pot): [KEYS_TAG] for pot in pots for role in ("session", "host")}
    members = [
        {"src": [login], "dst": [node_tag("session", pot) for pot in pots], "ip": [tcp(ports) for ports in ROLES["session"]["inbound"]]},
        {"src": [login], "dst": [node_tag("host", pot) for pot in pots], "ip": [tcp((ADMIN_PORT, ADMIN_PORT))]},
    ]
    return {"tagOwners": owners, "grants": members + door_grants(doors)}


def print_access(doors):
    for row in door_access(doors):
        print(*row)


ACTIONS = {
    ("access", 0): print_access,
    ("policy", 1): lambda doors, settings: print(json.dumps(policy(doors, settings), indent=2)),
}

action = (sys.argv[1] if len(sys.argv) > 1 else "", len(sys.argv) - 2)
if action not in ACTIONS:
    fail(USAGE)
ACTIONS[action](read_mesh(sys.stdin.read().splitlines()), *sys.argv[2:])
