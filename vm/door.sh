#!/bin/sh
set -eu
. /etc/pots-firewall/network.env
CONFIG=/etc/pots-door/sshd_config
PRIVILEGE_SEPARATION_DIR=/run/sshd

tailscale wait
ipv4=$(tailscale ip -4)
ipv6=$(tailscale ip -6)
install -d -m 0755 "$PRIVILEGE_SEPARATION_DIR"
exec /usr/sbin/sshd -D -e -f "$CONFIG" -o "ListenAddress=$ipv4:$DOOR_PORT" -o "ListenAddress=[$ipv6]:$DOOR_PORT"
