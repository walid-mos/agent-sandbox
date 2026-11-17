import ipaddress
import json

OPERATOR = "the operator's untagged devices"
POT_SESSIONS = "other pots' session nodes"


def covers_own_address(destination, own_addresses):
    if destination == "*":
        return True
    try:
        network = ipaddress.ip_network(destination, strict=False)
    except ValueError:
        return True
    return any(address in network for address in own_addresses)


def inbound_grants(netmap, own_addresses):
    rules = netmap.get("PacketFilterRules") or []
    return [(rule.get("SrcIPs") or [], port["Ports"]) for rule in rules for port in rule.get("DstPorts") or []
            if covers_own_address(port["IP"], own_addresses)]


def addresses_of(peers):
    return {ipaddress.ip_address(address) for peer in peers for address in peer.get("TailscaleIPs") or []}


# A peer counts only on the evidence the status holds: no tag and the operator's login, or one other pot's session tag.
def trusted_addresses(status, login, is_other_session):
    users = status.get("User") or {}
    peers = list((status.get("Peer") or {}).values())
    operator_devices = [peer for peer in peers if login and not peer.get("Tags")
                        and (users.get(str(peer.get("UserID"))) or {}).get("LoginName") == login]
    sessions = [peer for peer in peers if is_other_session(peer.get("Tags") or [])]
    return {OPERATOR: addresses_of(operator_devices), POT_SESSIONS: addresses_of(sessions)}


# Each status vouches with its own User map, and an address that one status trusts and another shows under another identity counts for neither.
def agreed_addresses(statuses, login, is_other_session):
    found = [(addresses_of((status.get("Peer") or {}).values()), trusted_addresses(status, login, is_other_session)) for status in statuses]
    return {group: {address for _, trusted in found for address in trusted[group]
                    if all(address in other[group] or address not in shown for shown, other in found)}
            for group in (OPERATOR, POT_SESSIONS)}


def is_identity(peer):
    tags, addresses = peer.get("Tags") or [], peer.get("TailscaleIPs") or []
    return isinstance(tags, list) and isinstance(addresses, list) and all(isinstance(item, str) for item in tags + addresses)


# IPv4 numbering is per tailnet and the IPv6 prefix is shared by all, so only a view of the node's own tailnet proves an address.
def view_status(view, tailnet):
    if not tailnet or view["CurrentTailnet"]["Name"] != tailnet:
        raise ValueError("the view comes from another tailnet")
    peers = {**(view.get("Peer") or {}), "Self": view["Self"]}
    users = view.get("User") or {}
    if not all(map(is_identity, peers.values())) or not all(isinstance(user, dict) for user in users.values()):
        raise ValueError("the view holds a malformed peer or user")
    addresses_of(peers.values())
    return {"Peer": peers, "User": users}


# The control server sends a shielded node none of the peers that may only reach it, so verify also judges what the operator's machine sees.
def operator_view(text, own_status):
    try:
        return view_status(json.loads(text), (own_status.get("CurrentTailnet") or {}).get("Name"))
    except (ValueError, TypeError, AttributeError, KeyError, RecursionError):
        return None


# A range, a CIDR wider than one address, '*' or an address no trusted peer holds fails: it may admit an untrusted node.
def is_trusted(source, addresses):
    try:
        network = ipaddress.ip_network(source, strict=False)
    except ValueError:
        return False
    return network.num_addresses == 1 and network.network_address in addresses


def source_problems(grants, allowed_sources, trusted):
    problems = []
    for sources, ports in grants:
        expected = allowed_sources(ports)
        strangers = [source for source in sources if expected is None or not is_trusted(source, trusted[expected])]
        if strangers:
            only = f", which only {expected} may reach" if expected else ""
            problems.append(f"the policy lets {strangers} reach ports {ports['First']}-{ports['Last']}{only}")
    return problems
