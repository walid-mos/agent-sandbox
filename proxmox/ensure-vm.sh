# Runs as root on the Proxmox node, after proxmox/host.env, as `sh -c SCRIPT ensure-vm ARGUMENTS` from lib/providers/proxmox.sh.
# It creates the pot's VM once, refuses any guest it did not create, applies the vm sizes, starts the VM and waits for cloud-init.
set -eu

IMAGE_URL=https://cloud-images.ubuntu.com/releases/noble/release-20261017/ubuntu-24.04-server-cloudimg-amd64.img
IMAGE_SHA256=04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94
IMAGE_DIR=/var/lib/vz/template/iso
LOCK=/run/lock/pots-vm.lock
LOCK_WAIT_SECONDS=300
BOOT_ATTEMPTS=60
BOOT_RETRY_SECONDS=5
BINARY_STEP=1024
NEWLINE='
'

fail() {
	echo "ensure-vm: $1" >&2
	exit 1
}

[ $# -eq 10 ] || { echo 'usage: ensure-vm VMID NAME CORES MEMORY_MIB DISK_GIB CPU_UNITS STORAGE BRIDGE ADDRESS GATEWAY' >&2; exit 2; }
vmid=$1 name=$2 cores=$3 memory_mib=$4 disk_gib=$5 cpu_units=$6 storage=$7 bridge=$8 address=$9 gateway=${10}
for number in "$vmid" "$cores" "$memory_mib" "$disk_gib" "$cpu_units"; do
	case "$number" in
		'' | *[!0-9]*) echo "ensure-vm: VMID, CORES, MEMORY_MIB, DISK_GIB and CPU_UNITS are whole numbers, got '$number'" >&2; exit 2 ;;
	esac
done

# Prints "VMID TYPE NAME TAGS" for each guest of the cluster, VM or container, that holds this VM id or this name.
guests_matching() {
	pvesh get /cluster/resources --type vm --output-format json | python3 -I -c '
import json, sys
vmid, name = int(sys.argv[1]), sys.argv[2]
for guest in json.load(sys.stdin):
    if guest.get("vmid") == vmid or guest.get("name") == name:
        print(guest["vmid"], guest.get("type", "-"), guest.get("name") or "-", guest.get("tags") or "-")
' "$vmid" "$name"
}

require_own_guest() {
	case "$1" in
		*"$NEWLINE"*) fail "several guests hold VM id $vmid or name $name, which vm-up leaves alone:$NEWLINE$1" ;;
		"$vmid qemu $name "*) ;;
		*) fail "VM id $vmid or name $name belongs to another guest, which vm-up leaves alone: $1" ;;
	esac
	case ";${1#"$vmid qemu $name "};" in
		*";$PROXMOX_GUEST_TAG;"*) ;;
		*) fail "VM $vmid is named $name but lacks the tag $PROXMOX_GUEST_TAG that vm-up gives its VMs; vm-up leaves it alone" ;;
	esac
}

verified() {
	echo "$IMAGE_SHA256  $1" | sha256sum -c --quiet - > /dev/null 2>&1
}

download_image() {
	pending=$(mktemp "$1.XXXXXX")
	if ! curl -fsSL --retry 3 -o "$pending" "$IMAGE_URL" || ! verified "$pending"; then
		rm -f "$pending"
		fail "could not download $IMAGE_URL with the pinned SHA-256 $IMAGE_SHA256"
	fi
	chmod 0644 "$pending"
	mv "$pending" "$1"
}

verified_image() {
	image="$IMAGE_DIR/$(basename "$IMAGE_URL")"
	[ -f "$image" ] || download_image "$image"
	verified "$image" || fail "$image does not match the pinned SHA-256 $IMAGE_SHA256; remove it so vm-up downloads the pinned image"
	echo "$image"
}

create_vm() {
	image=$(verified_image)
	[ ! -f "$PROXMOX_VM_KNOWN_HOSTS" ] || ssh-keygen -R "${address%/*}" -f "$PROXMOX_VM_KNOWN_HOSTS" > /dev/null
	qm create "$vmid" --name "$name" --tags "$PROXMOX_GUEST_TAG" --description "Pot $name, created by agent-sandbox bin/vm-up" \
		--ostype l26 --cpu host --cores "$cores" --memory "$memory_mib" --balloon 0 --cpuunits "$cpu_units" --onboot 1 \
		--scsihw virtio-scsi-single --scsi0 "$storage:0,import-from=$image,discard=on" --boot order=scsi0 \
		--ide2 "$storage:cloudinit" --serial0 socket --vga serial0 --net0 "virtio,bridge=$bridge" \
		--ipconfig0 "ip=$address,gw=$gateway" --nameserver "$PROXMOX_VM_NAMESERVERS" --ciuser root --sshkeys "$PROXMOX_VM_KEY.pub" --ciupgrade 0
}

disk_mib() {
	size=$(qm config "$vmid" | sed -n 's/^scsi0: .*size=\([0-9]*\)\([KMGT]\).*/\1 \2/p')
	set -- $size
	case "${2:-}" in
		K) echo $(($1 / BINARY_STEP)) ;;
		M) echo "$1" ;;
		G) echo $(($1 * BINARY_STEP)) ;;
		T) echo $(($1 * BINARY_STEP * BINARY_STEP)) ;;
		*) fail "cannot read the size of VM $vmid's disk scsi0 from qm config" ;;
	esac
}

# Cores and memory of a running VM change at its next start; the disk only grows.
apply_resources() {
	qm set "$vmid" --cores "$cores" --memory "$memory_mib" --cpuunits "$cpu_units"
	current_mib=$(disk_mib)
	[ "$current_mib" -ge $((disk_gib * BINARY_STEP)) ] || qm disk resize "$vmid" scsi0 "${disk_gib}G"
}

wait_for_boot() {
	attempt=1
	until answer=$(ssh -n -o StrictHostKeyChecking=accept-new $PROXMOX_VM_SSH_OPTIONS "root@${address%/*}" test -f /var/lib/cloud/instance/boot-finished 2>&1); do
		[ "$attempt" -lt "$BOOT_ATTEMPTS" ] || fail "VM $vmid did not finish cloud-init with ssh open at ${address%/*} after $BOOT_ATTEMPTS tries; read its console with qm terminal $vmid. Last answer: $answer"
		attempt=$((attempt + 1))
		sleep "$BOOT_RETRY_SECONDS"
	done
}

exec 9> "$LOCK"
flock --wait "$LOCK_WAIT_SECONDS" 9 || fail "another vm-up held $LOCK for $LOCK_WAIT_SECONDS seconds"
[ -f "$PROXMOX_VM_KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "pots-vm@$(hostname)" -f "$PROXMOX_VM_KEY"
matches=$(guests_matching)
if [ -z "$matches" ]; then
	create_vm
else
	require_own_guest "$matches"
fi
apply_resources
[ "$(qm status "$vmid")" = 'status: running' ] || qm start "$vmid" 9>&-
exec 9>&-
wait_for_boot
