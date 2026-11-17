#!/usr/bin/env python3
import ipaddress
import json
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

NETWORK_ENV = Path(__file__).resolve().parent.parent / "vm/network.env"
LAUNCH_ENV = Path(__file__).resolve().parent.parent / "session/launch.env"
DOOR_PORT = int(re.search(r"^DOOR_PORT=([0-9]+)$", NETWORK_ENV.read_text(), re.MULTILINE).group(1))
INSTALLED_SETTINGS = Path(re.search(r"^POTS_SESSION_CONFIGURATION=(.+)$", LAUNCH_ENV.read_text(), re.MULTILINE).group(1))
TAILNET_SETTINGS = "tailnet.json"
LOGIN = re.compile(r"[^@\s]+@[^@\s]+")
POT_NAME = re.compile(r"[a-z](?:[a-z0-9-]{0,29}[a-z0-9])?")
HOST_SUFFIX = "-host"
TAG_PREFIX = "tag:pot-"
HOST_TAG = re.compile(r"tag:pot-([a-z0-9-]+)-host")
KEY = re.compile(r"tskey-auth-[A-Za-z0-9-]+")
SERVE_PORT = 443
# tailnet-link's file server trusts the login header Serve adds, and a userspace node hands an unserved port to its loopback, so no grant may reach this port.
FILE_SERVER_PORT = 18791
PREVIEW_RANGES = [(10001, FILE_SERVER_PORT - 1), (FILE_SERVER_PORT + 1, 65535)]
ADMIN_PORT = 22
ROLES = {
    "host": {"suffix": HOST_SUFFIX, "flags": ["--netfilter-mode=off", "--accept-dns=false"],
             "inbound": [(ADMIN_PORT, ADMIN_PORT), (DOOR_PORT, DOOR_PORT)], "required": ADMIN_PORT},
    "session": {"suffix": "", "flags": ["--accept-dns=false"],
                "inbound": [(SERVE_PORT, SERVE_PORT), *PREVIEW_RANGES], "required": SERVE_PORT},
}
PROBE_PORTS = (22, 80, 443, 3000, 3001, 3425, 5432, 8006, 8443, FILE_SERVER_PORT, DOOR_PORT)
PROBE_SECONDS = 5
PROBE_PARALLELISM = 16
FUNNEL_CAPABILITY = "funnel"
JOIN_TIMEOUT = "60s"
DAEMON_ATTEMPTS = 30
DAEMON_RETRY_SECONDS = 1
UNJOINED_STATES = {"NeedsLogin", "NoState"}
POLICY_GUIDANCE = "Apply the policy bin/tailnet-policy prints, as docs/tailnet-setup.md says, then run bin/tailnet-up again."
USAGE = "usage: tailnet_node.py name|tag|state|join|check|verify host|session POT [TARGET...] | guard host|session"


def fail(message):
    print("tailnet_node: " + message, file=sys.stderr)
    sys.exit(1)


# The generator reads the operator's copy and the nodes the one bin/vm-config installed, so both grant and check the same login.
def read_operator_login(directory):
    path = Path(directory) / TAILNET_SETTINGS
    try:
        login = json.loads(path.read_text()).get("operatorLogin")
    except (OSError, ValueError, AttributeError):
        return None
    return login if isinstance(login, str) and LOGIN.fullmatch(login) else None


def login_guidance(directory):
    return (f"{Path(directory) / TAILNET_SETTINGS} must hold {{\"operatorLogin\": \"you@example.com\"}}, the Tailscale login of the "
            f"operator's devices: write it at ~/.config/agent-sandbox/{TAILNET_SETTINGS} on the operator's machine, then run bin/vm-config")


def node_name(role, pot):
    if not POT_NAME.fullmatch(pot) or pot.endswith(HOST_SUFFIX):
        fail(f"pot name {pot!r} must be a DNS label of at most 31 lowercase letters, digits and dashes, not ending in {HOST_SUFFIX}")
    return pot + ROLES[role]["suffix"]


def node_tag(role, pot):
    return TAG_PREFIX + node_name(role, pot)


def tailscale_json(*arguments):
    return json.loads(subprocess.run(["tailscale", *arguments], capture_output=True, text=True, check=True).stdout)


# tailscaled may still be starting when bootstrap has just restarted it, so the first status call waits for its socket.
def daemon_status():
    for _ in range(DAEMON_ATTEMPTS):
        result = subprocess.run(["tailscale", "status", "--json", "--peers=false"], capture_output=True, text=True)
        if result.returncode == 0:
            return json.loads(result.stdout)
        time.sleep(DAEMON_RETRY_SECONDS)
    fail("tailscaled does not answer: " + result.stderr.strip())


def node_state(role, pot):
    status = daemon_status()
    backend = status.get("BackendState")
    if backend in UNJOINED_STATES:
        return "absent"
    own = status.get("Self") or {}
    name = (own.get("DNSName") or "").split(".")[0]
    tags = own.get("Tags") or []
    if backend == "Running" and name == node_name(role, pot) and tags == [node_tag(role, pot)]:
        return "joined"
    fail(f"this node is {backend} as {name or 'no name'} with tags {tags or 'none'}, expected {node_name(role, pot)} "
         f"with {node_tag(role, pot)} only. Delete the stale device in the Tailscale admin console, run 'tailscale logout' "
         "on this node, then run bin/tailnet-up again.")


# The node joins with shields up, so nothing reaches it before verify has checked what the policy lets in.
def join(role, pot):
    if node_state(role, pot) == "joined":
        return
    key = sys.stdin.read().strip()
    if not KEY.fullmatch(key):
        fail("expected one Tailscale auth key on standard input")
    command = ["tailscale", "up", "--auth-key=file:/dev/stdin", "--hostname=" + node_name(role, pot),
               "--advertise-tags=" + node_tag(role, pot), "--shields-up", "--timeout=" + JOIN_TIMEOUT,
               *ROLES[role]["flags"]]
    if subprocess.run(command, input=key, text=True).returncode:
        fail("tailscale up failed; run bin/tailnet-up again, it mints a new key")
    node_state(role, pot)


def is_allowed_inbound(role, ports):
    return any(first <= ports["First"] and ports["Last"] <= last for first, last in ROLES[role]["inbound"])


def covers_own_address(destination, own_addresses):
    if destination == "*":
        return True
    try:
        network = ipaddress.ip_network(destination, strict=False)
    except ValueError:
        return True
    return any(address in network for address in own_addresses)


def inbound_grants(own_addresses):
    rules = tailscale_json("debug", "netmap").get("PacketFilterRules") or []
    return [(rule.get("SrcIPs") or [], port["Ports"]) for rule in rules for port in rule.get("DstPorts") or []
            if covers_own_address(port["IP"], own_addresses)]


# A userspace node hands every port without a Serve handler to its own loopback, so the filter the control server sent is the only gate.
def inbound_problems(role, own_addresses):
    grants = inbound_grants(own_addresses)
    problems = [f"any node may reach ports {ports['First']}-{ports['Last']}" for sources, ports in grants if "*" in sources]
    problems += [f"the policy lets {sources} reach ports {ports['First']}-{ports['Last']}"
                 for sources, ports in grants if not is_allowed_inbound(role, ports)]
    required = ROLES[role]["required"]
    if not any(ports["First"] <= required <= ports["Last"] for _, ports in grants):
        problems.append(f"the policy grants the human's devices no port {required} on this node yet")
    return problems


def capability_problems(own):
    if FUNNEL_CAPABILITY in (own.get("CapMap") or {}) or FUNNEL_CAPABILITY in (own.get("Capabilities") or []):
        return ["the policy lets this node use Funnel"]
    return []


def allowed_outbound(role, pot, tags):
    peer_pots = [match.group(1) for match in map(HOST_TAG.fullmatch, tags) if match]
    return {DOOR_PORT} if role == "session" and any(peer != pot for peer in peer_pots) else set()


def probe_targets(role, pot, named_targets):
    peers = (tailscale_json("status", "--json").get("Peer") or {}).values()
    targets = [((peer.get("TailscaleIPs") or [peer.get("DNSName")])[0], peer.get("DNSName"),
                allowed_outbound(role, pot, peer.get("Tags") or [])) for peer in peers]
    named = [*named_targets, node_name("host", pot)] if role == "session" else list(named_targets)
    return targets + [(name, name, set()) for name in named]


def reaches(address, port):
    try:
        return subprocess.run(["tailscale", "nc", address, str(port)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=PROBE_SECONDS).returncode == 0
    except subprocess.TimeoutExpired:
        return False


def outbound_problems(role, pot, named_targets):
    probes = [(address, label, port) for address, label, allowed in probe_targets(role, pot, named_targets)
              for port in PROBE_PORTS if port not in allowed]
    with ThreadPoolExecutor(PROBE_PARALLELISM) as pool:
        reached = list(pool.map(lambda probe: reaches(probe[0], probe[2]), probes))
    return [f"this node reaches {label} on port {port}" for (_, label, port), hit in zip(probes, reached) if hit]


def exposure_problems(role, pot, named_targets):
    if node_state(role, pot) != "joined":
        fail("this node has not joined the tailnet; run bin/tailnet-up")
    own = daemon_status().get("Self") or {}
    own_addresses = [ipaddress.ip_address(address) for address in own.get("TailscaleIPs") or []]
    return inbound_problems(role, own_addresses) + capability_problems(own) + outbound_problems(role, pot, named_targets)


def check(role, pot, *named_targets):
    problems = exposure_problems(role, pot, named_targets)
    if problems:
        fail("; ".join(problems) + ". " + POLICY_GUIDANCE)
    print(f"tailnet_node: {node_name(role, pot)} takes only what the pots policy grants and reaches nothing else")


def verify(role, pot, *named_targets):
    problems = exposure_problems(role, pot, named_targets)
    subprocess.run(["tailscale", "set", "--shields-up=" + ("true" if problems else "false")], check=True)
    if problems:
        fail("shields stay up: " + "; ".join(problems) + ". " + POLICY_GUIDANCE)
    print(f"tailnet_node: {node_name(role, pot)} matches the pots policy; shields down")


# Run every minute from the VM: shields only go up here, and only verify, from bin/tailnet-up, lowers them once every check passes.
def guard(role):
    status = daemon_status()
    if status.get("BackendState") in UNJOINED_STATES:
        return
    own = status.get("Self") or {}
    own_addresses = [ipaddress.ip_address(address) for address in own.get("TailscaleIPs") or []]
    problems = inbound_problems(role, own_addresses) + capability_problems(own)
    if problems:
        subprocess.run(["tailscale", "set", "--shields-up=true"], check=True)
        fail("shields raised: " + "; ".join(problems) + ". " + POLICY_GUIDANCE)


ACTIONS = {
    "name": lambda role, pot: print(node_name(role, pot)),
    "tag": lambda role, pot: print(node_tag(role, pot)),
    "state": lambda role, pot: print(node_state(role, pot)),
    "join": join,
    "check": check,
    "verify": verify,
    "guard": guard,
}
TARGETED_ACTIONS = {"check", "verify"}
POTLESS_ACTIONS = {"guard"}

if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    arity = 3 if action in POTLESS_ACTIONS else 4
    if action not in ACTIONS or len(sys.argv) < arity or sys.argv[2] not in ROLES or (
            len(sys.argv) > arity and action not in TARGETED_ACTIONS):
        fail(USAGE)
    ACTIONS[action](*sys.argv[2:])
