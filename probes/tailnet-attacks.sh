#!/bin/bash
set -u

own_pot=$1
peer_host=$2
tailscale=$3
door_config=$4
door_port=$5
door_known_hosts=$6
DIAL_SECONDS=6
DOOR_STATE=/etc/pots-door
SOCKETS="/run/tailscale/tailscaled.sock /var/run/tailscale/tailscaled.sock"
NONCE=probe0000000000
RATE_PROBE_KNOCKS=64
RATE_REFUSAL=75
SSH_REFUSAL=255
failures=0

expect() {
	outcome=$1 name=$2
	shift 2
	if "$@" > /dev/null 2>&1; then actual=succeed; else actual=fail; fi
	if [ "$actual" = "$outcome" ]; then
		echo "ok   $name"
	else
		echo "FAIL $name (expected to $outcome)"
		failures=$((failures + 1))
	fi
}

# tailscale nc ends with status 0 as soon as its dial succeeded when its input is empty, so the status alone tells a connection from a refusal.
reaches() {
	timeout "$DIAL_SECONDS" "$tailscale" nc "$1" "$2" < /dev/null > /dev/null 2>&1
}

every_socket_is_the_session_node() {
	for socket in $SOCKETS; do
		[ -S "$socket" ] || continue
		name=$("$tailscale" --socket="$socket" status --json --peers=false | jq -r '.Self.DNSName | split(".")[0]')
		[ "$name" = "$own_pot" ] || return 1
	done
}

# Whatever this writes stays in the session's own filesystem; bin/probe-boundary compares the VM's door files before and after.
plant_door_state() {
	[ ! -e "$DOOR_STATE" ] || return 0
	mkdir -p "$DOOR_STATE" 2> /dev/null && echo 'command="sh" ssh-ed25519 planted' > "$DOOR_STATE/authorized_keys"
	rm -rf "$DOOR_STATE" 2> /dev/null
	return 0
}

knock() {
	exit_code=$1
	shift
	ssh -F "$door_config" "$@" > /dev/null 2>&1
	[ "$?" -eq "$exit_code" ]
}

# Only malformed knocks, so no probe message reaches the peer's bot; they spend this pot's refusal budget at the peer and leave its deliveries whole.
door_limits_the_rate() {
	for _ in $(seq "$RATE_PROBE_KNOCKS"); do
		knock "$RATE_REFUSAL" "$peer_host" <<< "request intruder.$NONCE 0
probe" && return 0
	done
	return 1
}

doors_outside_known_hosts() {
	"$tailscale" status --json | jq -r --arg own "$own_pot-host" '.Peer[]? | .DNSName | split(".")[0] | select(endswith("-host") and . != $own)' |
		grep -vxF -f <(awk '{ print $1 }' "$door_known_hosts") || true
}

# The host key check is off so the knock reaches the door; a foreign origin keeps any message from a bot, and only ssh's own refusal of the key passes.
every_other_door_refuses_the_key() {
	for host in $(doors_outside_known_hosts); do
		knock "$SSH_REFUSAL" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$host" <<< "request intruder.$NONCE 0
probe" || return 1
	done
}

door_attacks() {
	request="request $own_pot.$NONCE 0"
	expect fail door-runs-the-ssh-command knock 0 "$peer_host" id < /dev/null
	expect succeed door-refuses-a-foreign-origin knock 64 "$peer_host" <<< "request intruder.$NONCE 0
probe"
	expect succeed door-refuses-a-reply-to-another-pot knock 64 "$peer_host" <<< "reply $own_pot.$NONCE
probe"
	expect succeed door-refuses-a-request-without-hop knock 64 "$peer_host" <<< "request $own_pot.$NONCE
probe"
	expect succeed door-refuses-an-empty-note knock 64 "$peer_host" <<< "$request
  "
	expect succeed door-refuses-an-oversize-message knock 65 "$peer_host" < <(printf '%s\n' "$request"; head -c 20000 /dev/zero | tr '\0' a)
	expect fail door-forwards-to-the-peer-sshd knock 0 -W 127.0.0.1:22 "$peer_host" < /dev/null
	expect succeed door-limits-the-rate door_limits_the_rate
	expect succeed doors-outside-doors-refuse-the-key every_other_door_refuses_the_key
}

echo "as $(id -un)"
expect succeed every-reachable-tailscaled-is-the-session-node every_socket_is_the_session_node
expect fail session-reads-door-state test -e "$DOOR_STATE"
plant_door_state
if [ -z "$peer_host" ]; then
	echo "FAIL untestable no peer door in the session's door known_hosts; run bin/pots-doors first"
	exit 1
fi
expect succeed control-session-node-reaches-peer-door reaches "$peer_host" "$door_port"
if [ -r "$HOME/.config/agent-sandbox/door/id_ed25519" ]; then
	door_attacks
fi
[ "$failures" -eq 0 ]
