. "$POTS_REPO/proxmox/host.env"
PROXMOX_WEB_PORT=8006
MIB_PER_GIB=1024

proxmox_problems=$(jq -r --arg sandbox "$SANDBOX" -f "$POTS_REPO/proxmox/config.jq" "$POTS_CONFIG")
if [ -n "$proxmox_problems" ]; then
	echo "$(basename "$0"): $POTS_CONFIG is not a valid Proxmox sandbox:" >&2
	printf '%s\n' "$proxmox_problems" | sed 's/^/  - /' >&2
	exit 2
fi

proxmox_setting() {
	jq -r --arg key "$1" '.proxmox[$key]' "$POTS_CONFIG"
}

PROXMOX_HOST=$(proxmox_setting host)
PROXMOX_VMID=$(proxmox_setting vmid)
PROXMOX_ADDRESS=$(proxmox_setting address)
PROXMOX_VM_ADDRESS=${PROXMOX_ADDRESS%/*}

# ssh hands its command to the remote shell as one string, so each word is single-quoted once per hop. The dot keeps trailing newlines.
quote_words() {
	for word in "$@"; do
		escaped=$(printf '%s.' "$word" | sed "s/'/'\\\\''/g")
		printf "'%s' " "${escaped%.}"
	done
}

proxmox_host() {
	ssh -o BatchMode=yes "$PROXMOX_HOST" -- "$(quote_words "$@")"
}

# This machine never holds a VM key: the node runs the second hop with its own, and stdin and the exit status pass through both.
sandbox_vm() {
	proxmox_host ssh $PROXMOX_VM_SSH_OPTIONS -o StrictHostKeyChecking=yes "root@$PROXMOX_VM_ADDRESS" -- "$(quote_words "$@")"
}

sandbox_docker() {
	sandbox_vm docker "$@"
}

vm_is_running() {
	[ "$(proxmox_host qm status "$PROXMOX_VMID" < /dev/null)" = 'status: running' ]
}

vm_start() {
	cores=$(vm_setting cpu)
	memory_gib=$(vm_setting memoryGiB)
	disk_gib=$(vm_setting diskGiB)
	cpu_units=$(proxmox_setting cpuUnits)
	storage=$(proxmox_setting storage)
	bridge=$(proxmox_setting bridge)
	gateway=$(proxmox_setting gateway)
	ensure_script=$(cat "$POTS_REPO/proxmox/host.env" "$POTS_REPO/proxmox/ensure-vm.sh")
	proxmox_host sh -c "$ensure_script" ensure-vm "$PROXMOX_VMID" "$SANDBOX" "$cores" "$((memory_gib * MIB_PER_GIB))" "$disk_gib" \
		"$cpu_units" "$storage" "$bridge" "$PROXMOX_ADDRESS" "$gateway" < /dev/null
}

proxmox_sandbox_endpoints() {
	for config in "$POTS_SANDBOX_ROOT"/*/sandbox.json; do
		[ "$(sandbox_provider "$config")" = proxmox ] || continue
		address=$(jq -r '.proxmox.address' "$config")
		printf '%s:22 ' "${address%/*}"
	done
}

# A pot VM routes the Mac's tailnet names through its own node, which the node check covers, so the VM reaches the Mac at its LAN address.
vm_forbidden_endpoints() {
	mac=$(jq -er '.macLanAddress | strings | select(test("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$"))' "$POTS_RUNTIME/host.json") || {
		echo "$(basename "$0"): $POTS_RUNTIME/host.json needs macLanAddress, the Mac's IPv4 address on the Proxmox node's LAN, such as 192.168.1.138" >&2
		return 1
	}
	node=$(proxmox_host ip -4 -o addr show "$(proxmox_setting bridge)" < /dev/null | awk '{ sub("/.*", "", $4); print $4; exit }')
	gateway=$(proxmox_setting gateway)
	pots=$(proxmox_sandbox_endpoints)
	echo "$mac:$MAC_ROUTER_PORT $mac:22 $mac:5432 $node:22 $node:$PROXMOX_WEB_PORT $gateway:80 $pots"
}
