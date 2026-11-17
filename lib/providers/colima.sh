POTS_PROFILE=$SANDBOX
POTS_CONTEXT="colima-$POTS_PROFILE"
COLIMA_VM_INTERFACE=eth0
COLIMA_HOST=host.lima.internal

sandbox_vm() {
	colima ssh -p "$POTS_PROFILE" -- "$@"
}

sandbox_docker() {
	docker --context "$POTS_CONTEXT" "$@"
}

vm_is_running() {
	colima status --profile "$POTS_PROFILE" > /dev/null 2>&1
}

write_colima_profile() {
	cpu=$(vm_setting cpu)
	memory_gib=$(vm_setting memoryGiB)
	disk_gib=$(vm_setting diskGiB)
	profile="$HOME/.colima/$POTS_PROFILE/colima.yaml"
	mkdir -p "$(dirname "$profile")"
	pending=$(mktemp "$profile.XXXXXX")
	trap 'rm -f "$pending"' EXIT HUP INT TERM
	sed -e "s/^cpu: CPU$/cpu: $cpu/" \
		-e "s/^memory: MEMORY_GIB$/memory: $memory_gib/" \
		-e "s/^disk: DISK_GIB$/disk: $disk_gib/" \
		-e "s/^hostname: HOSTNAME$/hostname: colima-$POTS_PROFILE/" \
		"$POTS_REPO/colima/colima.yaml" > "$pending"
	mv "$pending" "$profile"
}

vm_start() {
	write_colima_profile
	# A start that cannot read the profile falls back to Colima's defaults, which mount the Mac home, so the flag names no mount as well.
	vm_is_running || colima start --profile "$POTS_PROFILE" --mount none
}

# The Colima VMs share one network and the Mac publishes each SealSkin server, so a session is checked against every Colima sandbox, its own included.
colima_sandbox_endpoints() {
	mac=$1
	for config in "$POTS_SANDBOX_ROOT"/*/sandbox.json; do
		[ "$(sandbox_provider "$config")" = colima ] || continue
		profile=$(basename "$(dirname "$config")")
		address=$(colima ssh -p "$profile" -- ip -4 -o addr show "$COLIMA_VM_INTERFACE" | awk '{ sub("/.*", "", $4); print $4 }')
		printf '%s:22 ' "$address"
		server_port=$(jq -r '.serverPort // empty' "$config")
		[ -z "$server_port" ] || printf '%s:%s ' "$COLIMA_HOST" "$server_port"
		ssh_port=$(jq -r '.tailnetSshPort // empty' "$config")
		[ -z "$ssh_port" ] || printf '%s:%s ' "$mac" "$ssh_port"
	done
}

vm_forbidden_endpoints() {
	mac=$(jq -er .macHost "$POTS_RUNTIME/host.json")
	peer=$(jq -er .peerHost "$POTS_RUNTIME/host.json")
	lan_gateway=$(route -n get default | awk '/gateway:/ { print $2 }')
	sandboxes=$(colima_sandbox_endpoints "$mac")
	echo "$mac:$MAC_ROUTER_PORT $mac:22 $mac:443 $mac:5432 $COLIMA_HOST:$MAC_ROUTER_PORT $COLIMA_HOST:22 $peer:22 $lan_gateway:80 $sandboxes"
}
