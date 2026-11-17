import ipaddress

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
