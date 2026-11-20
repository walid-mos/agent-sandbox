#!/bin/sh
set -eu

SYSBOX_VERSION=0.7.1
SYSBOX_RELEASES=https://github.com/nestybox/sysbox/releases/download
SYSBOX_SHA256_arm64=04ca894ae0b53f0fa54eaacc173ce40363c9a95ea5450f773716a84ef650a69b
SYSBOX_SHA256_amd64=9d6d5484f980d0a17f86c492c1262015c2afb66280bdb97215b79fde6a0261c5
SWAP_FILE=/swapfile
APT_LOCK_WAIT_SECONDS=300
GIB_BYTES=1073741824
here=$(dirname "$(readlink -f "$0")")
. "$here/../lib/tailscale.sh"

# A fresh cloud image runs apt on its own timers right after boot, so apt waits for their lock instead of failing.
apt_get() {
	DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout="$APT_LOCK_WAIT_SECONDS" "$@"
}

# Colima's image ships Docker. A stock cloud image does not, and Sysbox registers its runtime with an installed Docker.
install_docker() {
	if command -v dockerd > /dev/null; then
		return 0
	fi
	apt_get update -qq
	apt_get install -y -qq docker.io
}

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
	apt_get update -qq
	apt_get install -y -qq jq "$package"
	rm -rf "$package_dir"
}

install_firewall() {
	install -D -m 0644 "$here/network.env" /etc/pots-firewall/network.env
	printf 'POTS_LAUNCHER=%s\n' "$launcher" > /etc/pots-firewall/launcher.env
	install -m 0755 "$here/firewall.sh" /usr/local/sbin/pots-firewall
	install -m 0644 "$here/pots-firewall.service" /etc/systemd/system/
	systemctl daemon-reload
	systemctl reenable pots-firewall.service
	# Start, never restart: Docker requires this unit, so restarting it restarts Docker and every container.
	systemctl start pots-firewall.service
}

install_tailscale() {
	if tailscale_is_current /usr/bin/tailscale /usr/sbin/tailscaled; then
		systemctl start tailscaled.service
		return 0
	fi
	package_dir=$(mktemp -d)
	tailscale_unpack "$(dpkg --print-architecture)" "$package_dir"
	install -m 0755 "$package_dir/tailscale" /usr/bin/tailscale
	install -m 0755 "$package_dir/tailscaled" /usr/sbin/tailscaled
	install -m 0644 "$package_dir/systemd/tailscaled.service" /etc/systemd/system/
	[ -f /etc/default/tailscaled ] || install -m 0644 "$package_dir/systemd/tailscaled.defaults" /etc/default/tailscaled
	rm -rf "$package_dir"
	systemctl daemon-reload
	systemctl enable tailscaled.service
	systemctl restart tailscaled.service
}

# The door account has no Docker access: it runs only the forced command bound to each key, and that command only through the sudo rule pots-door-keys writes with that key.
install_door() {
	id door > /dev/null 2>&1 || useradd --system --no-create-home --home-dir / --shell /bin/sh door
	usermod --password '*' door
	install -d -m 0755 /etc/pots-door
	install -d -m 0700 /var/lib/pots-door
	visudo --check --quiet --file "$here/pots-door.sudoers"
	install -m 0440 "$here/pots-door.sudoers" /etc/sudoers.d/pots-door
	install -m 0644 "$here/door-sshd.conf" /etc/pots-door/sshd_config
	install -m 0644 "$here/../session/launch.env" /etc/pots-door/launch.env
	install -m 0755 "$here/pots-door.py" /usr/local/sbin/pots-door
	install -m 0755 "$here/door-keys.py" /usr/local/sbin/pots-door-keys
	install -m 0755 "$here/door.sh" /usr/local/sbin/pots-door-serve
	/usr/local/sbin/pots-door-keys prepare
	install -m 0644 "$here/pots-door.service" /etc/systemd/system/
	systemctl daemon-reload
	systemctl enable pots-door.service
	systemctl restart pots-door.service
}

# The units run this VM's clone in place through the trusted launcher, so a fast-forward reaches the timers' services with no reinstall.
# A changed unit file waits for the next vm-up, and the long-running broker takes new code at its restart here.
# The shields unit runs an installed copy instead, since it acts when the launcher refuses the clone.
# The login outlives memory exhaustion: the agent workloads raise their own score, and this keeps the login below everything else at the next start of these units.
install_login_scores() {
	install -D -m 0644 "$here/login-oom.conf" /etc/systemd/system/systemd-logind.service.d/oom.conf
	install -D -m 0644 "$here/login-oom.conf" /etc/systemd/system/ssh.service.d/oom.conf
}

install_units() {
	install -m 0755 "$here/shields-up" /usr/local/sbin/pots-shields-up
	install -m 0755 "$here/swap-on" /usr/local/sbin/pots-swap
	install -m 0644 "$here/pots-keeper.service" "$here/pots-keeper.timer" "$here/pots-update.service" "$here/pots-update.timer" \
		"$here/pots-tailnet-guard.service" "$here/pots-tailnet-guard.timer" "$here/pots-shields-up.service" "$here/pots-vault.service" \
		"$here/pots-swap.service" /etc/systemd/system/
	install_login_scores
	systemctl daemon-reload
	systemctl enable pots-vault.service
	systemctl restart pots-vault.service
	systemctl enable --now pots-keeper.timer pots-update.timer pots-tailnet-guard.timer
	systemctl enable --now pots-swap.service
}

# The isolated factory and its two services. GnuPG both signs the landing commit and verifies the tip the signer extends.
install_signing() {
	apt_get update -qq
	apt_get install -y -qq gnupg
	install -m 0644 "$here/pots-landing.service" "$here/pots-factory-reports.service" "$here/pots-factory.service" /etc/systemd/system/
	systemctl daemon-reload
	systemctl enable pots-landing.service pots-factory-reports.service pots-factory.service
	systemctl restart pots-landing.service pots-factory-reports.service
	# The factory exits cleanly until the operator's steps exist, and its unit retries it.
	systemctl restart pots-factory.service
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
	# pots-swap.service turns the file back on at every boot, so a VM that starts without vm-up keeps its swap.
	swap_is_on || swapon "$SWAP_FILE"
}

[ "$(id -u)" -eq 0 ] || { echo "vm/setup.sh runs as root inside the sealskin VM" >&2; exit 1; }
swap_gib=${1:-}
case $swap_gib in
	'' | *[!0-9]*) echo "vm/setup.sh: expected vm.swapGiB as a whole number of GiB, got '$swap_gib'; set it in the sandbox's sandbox.json" >&2; exit 2 ;;
esac
launcher=${2:-}
case $launcher in
	docker | sealskin) ;;
	*) echo "vm/setup.sh: expected the launcher docker or sealskin as second argument, got '$launcher'" >&2; exit 2 ;;
esac
install_docker
install_sysbox
install_firewall
install_tailscale
install_door
id pots-repository-read > /dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin pots-repository-read
usermod --password '*' --groups '' pots-repository-read
configure_swap "$swap_gib"
install_units
install_signing
/usr/bin/python3 -B "$here/usage_setup.py"
