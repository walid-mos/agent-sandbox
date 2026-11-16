#!/bin/sh
# The factory runs this in the check container before any check, and runs no check unless every attack fails.
opened=0

attack() {
	if sh -c "$2" > /dev/null 2>&1; then
		echo "open: $1"
		opened=1
	else
		echo "closed: $1"
	fi
}

attack 'a credential in the environment' 'env | grep -E "TOKEN|SECRET|_KEY=|INFISICAL"'
attack 'a credential in another process' 'grep -l -E "TOKEN|SECRET|INFISICAL" /proc/[0-9]*/environ'
attack 'the session home and its vault credential' 'test -e /config'
attack 'the docker socket' 'test -e /var/run/docker.sock'
attack 'root through sudo' 'sudo -n true'
attack 'a write to the factory folder' 'touch /factory/planted'
attack 'a write outside the workspace' 'touch /etc/planted'
attack 'the network' 'node -e "fetch(\"https://github.com\").then(() => process.exit(0), () => process.exit(1))"'
exit "$opened"
