#!/bin/sh
set -eu

EGRESS=eth0
CONTAINER_LINKS="docker0 br-+"
PRIVATE_V4="100.64.0.0/10 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16"
PRIVATE_V6="fc00::/7 fe80::/10"
EGRESS_CHAIN=DOCKER-USER
INPUT_CHAIN=POTS-INPUT
NETWORK_ENV=/etc/pots-firewall/network.env
LAUNCHER_ENV=/etc/pots-firewall/launcher.env

. "$NETWORK_ENV"
. "$LAUNCHER_ENV"

private_egress_rules() {
	for range in $1; do
		echo "-A $EGRESS_CHAIN -o $EGRESS -d $range -j DROP"
	done
	echo "-A $EGRESS_CHAIN -j RETURN"
}

vm_service_rules() {
	for link in $CONTAINER_LINKS; do
		echo "-A $INPUT_CHAIN -i $link -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
		echo "-A $INPUT_CHAIN -i $link -p udp --dport 53 -j RETURN"
		echo "-A $INPUT_CHAIN -i $link -p tcp --dport 53 -j RETURN"
		echo "-A $INPUT_CHAIN -i $link -j DROP"
	done
}

rules_v4() {
	echo '*filter'
	echo ":$EGRESS_CHAIN - [0:0]"
	echo ":$INPUT_CHAIN - [0:0]"
	if [ "$POTS_LAUNCHER" = sealskin ]; then
		echo "-A $EGRESS_CHAIN -d $SEALSKIN_SUBNET ! -s $SEALSKIN_SERVER_ADDRESS -m conntrack --ctstate NEW -j DROP"
	fi
	private_egress_rules "$PRIVATE_V4"
	vm_service_rules
	echo COMMIT
}

rules_v6() {
	echo '*filter'
	echo ":$EGRESS_CHAIN - [0:0]"
	echo ":$INPUT_CHAIN - [0:0]"
	private_egress_rules "$PRIVATE_V6"
	vm_service_rules
	echo COMMIT
}

# One restore call replaces every chain it declares in a single kernel transaction, so no packet meets a half-built chain.
load() {
	printf '%s\n' "$2" | "$1-restore" --noflush
	"$1" -C INPUT -j "$INPUT_CHAIN" 2> /dev/null || "$1" -I INPUT 1 -j "$INPUT_CHAIN"
}

route_bridged_traffic_through_iptables() {
	modprobe br_netfilter
	sysctl -q -w net.bridge.bridge-nf-call-iptables=1 net.bridge.bridge-nf-call-ip6tables=1
}

v4=$(rules_v4)
load iptables "$v4"
route_bridged_traffic_through_iptables
v6=$(rules_v6)
load ip6tables "$v6"
