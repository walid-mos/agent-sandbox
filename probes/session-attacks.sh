#!/bin/bash
set -u

PROBE_IMAGE=alpine:3.22
launcher=$1
outer_container=$2
server_address=$3
vm_sealskin_config=$4
DEVELOPMENT=$5
MAC_HOME=$(dirname "$DEVELOPMENT")
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

only_development_is_mounted() {
	[ "$(ls -A "$MAC_HOME")" = "$(basename "$DEVELOPMENT")" ]
}

session_root_is_vm_root() {
	grep -qE '^ *0 +0 ' /proc/self/uid_map
}

session_docker_sees_vm_containers() {
	docker ps -a --format '{{.Names}}' | grep -qx "$outer_container"
}

echo "as $(id -un)"
expect succeed control-worker-container-runs docker run --rm -v /:/session "$PROBE_IMAGE" test -d /session/config
expect succeed control-worker-reaches-internet docker run --rm "$PROBE_IMAGE" nc -z -w 4 registry.npmjs.org 443
expect succeed only-development-is-mounted only_development_is_mounted
expect fail write-development touch "$DEVELOPMENT/.agent-sandbox-probe"
expect fail session-root-is-vm-root session_root_is_vm_root
expect fail session-docker-sees-vm-containers session_docker_sees_vm_containers
if [ "$launcher" = sealskin ]; then
	expect fail worker-mounts-vm-volume docker run --rm -v /:/session "$PROBE_IMAGE" test -e "/session$vm_sealskin_config"
	expect fail worker-reaches-sealskin-server docker run --rm "$PROBE_IMAGE" nc -z -w 4 "$server_address" 8443
fi
exit "$failures"
