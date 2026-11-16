#!/bin/bash
set -u

CONNECT_TIMEOUT=4

for target in "$@"; do
	host=${target%:*}
	port=${target##*:}
	address=$(getent ahostsv4 "$host" | awk 'NR == 1 { print $1 }')
	if [ -n "$address" ] && timeout "$CONNECT_TIMEOUT" bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$address" "$port" 2>/dev/null; then
		echo "open $address:$port"
	else
		echo "closed ${address:-$host}:$port"
	fi
done
