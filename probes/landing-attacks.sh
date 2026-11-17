#!/bin/bash
# Session: the worker session, as its user and as its root, holds no factory path and no signer socket.
# VM: VM root is refused a signature, because only a process of the isolated factory may ask for one.
set -u

where=$1
launch=$2
failures=0

assign() {
	sed -n "s/^$1=//p" "$launch"
}

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

refused_without_token() {
	python3 - "$1" <<'PY'
import json
import socket
import sys

with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
    connection.settimeout(30)
    connection.connect(sys.argv[1])
    connection.sendall(b'{"repository": "probe/probe"}\n')
    connection.shutdown(socket.SHUT_WR)
    reply = json.loads(connection.makefile("rb").readline())

if reply.get("ok") is not False or "token" not in reply.get("error", ""):
    raise SystemExit(f"landing-attacks: the signer answered {reply}")
PY
}

no_root() {
	! sudo -n true
}

session_attacks() {
	key_home=$(assign POTS_LANDING_KEY_HOME)
	landing_state=$(assign POTS_LANDING_STATE)
	socket=$(assign POTS_LANDING_SOCKET)
	reports=$(assign POTS_FACTORY_REPORT_SOCKET)
	factory_state=$(assign POTS_FACTORY_STATE)
	expect fail landing-key-home-invisible test -e "$key_home"
	expect fail landing-key-unlistable ls "$key_home"
	expect fail landing-state-invisible test -e "$landing_state"
	expect fail signer-socket-invisible test -e "$socket"
	expect fail signer-token-invisible test -e "$(dirname "$socket")/token"
	expect fail report-socket-invisible test -e "$reports"
	expect fail factory-state-invisible test -e "$factory_state"
	expect fail no-root-through-sudo no_root
}

vm_attacks() {
	socket=$(assign POTS_LANDING_SOCKET)
	if [ -e "$socket" ]; then
		expect succeed signer-refuses-a-caller-with-no-token refused_without_token "$socket"
	else
		echo "ok   signer-not-started"
	fi
}

echo "as $(id -un) on $where"
case "$where" in
	session) session_attacks ;;
	vm) vm_attacks ;;
	*) echo "usage: landing-attacks.sh session|vm PATH_TO_LAUNCH_ENV" >&2; exit 2 ;;
esac
exit "$failures"
