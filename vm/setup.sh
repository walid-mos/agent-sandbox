#!/bin/sh
set -eu

SYSBOX_VERSION=0.7.1
SYSBOX_RELEASES=https://github.com/nestybox/sysbox/releases/download
SYSBOX_SHA256_arm64=04ca894ae0b53f0fa54eaacc173ce40363c9a95ea5450f773716a84ef650a69b
SYSBOX_SHA256_amd64=9d6d5484f980d0a17f86c492c1262015c2afb66280bdb97215b79fde6a0261c5
SWAP_FILE=/swapfile
GIB_BYTES=1073741824
here=$(dirname "$(readlink -f "$0")")

install_sysbox() {
	if sysbox-runc --version 2>/dev/null | grep -q "$SYSBOX_VERSION"; then
		return 0
	fi
	architecture=$(dpkg --print-architecture)
	case "$architecture" in
		arm64) checksum=$SYSBOX_SHA256_arm64 ;;
		amd64) checksum=$SYSBOX_SHA256_amd64 ;;
		*) echo "vm/setup.sh: no pinned Sysbox checksum for $architecture; add one next to SYSBOX_VERSION" >&2; exit 1 ;;
	esac
	package_dir=$(mktemp -d)
	package="$package_dir/sysbox-ce_$SYSBOX_VERSION.linux_$architecture.deb"
	curl -fsSL -o "$package" "$SYSBOX_RELEASES/v$SYSBOX_VERSION/$(basename "$package")"
	echo "$checksum  $package" | sha256sum -c --quiet -
	apt-get update -qq
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq "$package"
	rm -rf "$package_dir"
}

install_firewall() {
	install -D -m 0644 "$here/network.env" /etc/pots-firewall/network.env
	install -m 0755 "$here/firewall.sh" /usr/local/sbin/pots-firewall
	install -m 0644 "$here/pots-firewall.service" /etc/systemd/system/
	systemctl daemon-reload
	systemctl reenable pots-firewall.service
	# Start, never restart: Docker requires this unit, so restarting it restarts Docker and every container.
	systemctl start pots-firewall.service
}

swap_file_gib() {
	[ -f "$SWAP_FILE" ] || { echo 0; return; }
	bytes=$(stat -c %s "$SWAP_FILE")
	echo $((bytes / GIB_BYTES))
}

swap_is_on() {
	swapon --show=NAME --noheadings | grep -qx "$SWAP_FILE"
}

configure_swap() {
	wanted_gib=$1
	if [ "$(swap_file_gib)" -ne "$wanted_gib" ]; then
		! swap_is_on || swapoff "$SWAP_FILE"
		rm -f "$SWAP_FILE"
	fi
	[ "$wanted_gib" -gt 0 ] || return 0
	if [ ! -f "$SWAP_FILE" ]; then
		install -m 0600 /dev/null "$SWAP_FILE"
		fallocate --length "${wanted_gib}GiB" "$SWAP_FILE"
		mkswap "$SWAP_FILE" > /dev/null
	fi
	# No boot entry: every VM start goes through vm-up, which turns the file back on here.
	swap_is_on || swapon "$SWAP_FILE"
}

[ "$(id -u)" -eq 0 ] || { echo "vm/setup.sh runs as root inside the sealskin VM" >&2; exit 1; }
swap_gib=${1:-}
case $swap_gib in
	'' | *[!0-9]*) echo "vm/setup.sh: expected vm.swapGiB as a whole number of GiB, got '$swap_gib'; set it in the sandbox's sandbox.json" >&2; exit 2 ;;
esac
install_sysbox
install_firewall
configure_swap "$swap_gib"
