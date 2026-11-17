#!/bin/bash
set -u

clone=$1
session_home=$2
identity=$3
socket=$4
node=$5
failures=0
PATH="$(dirname "$node"):$PATH"

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

# Sends one raw request to the VM's broker. The answer is never printed: success only means the broker served it.
ask() {
	"$node" --input-type=module -e 'const { askVault } = await import(process.argv[1]); await askVault(JSON.parse(process.argv[2]));' "$clone/session/vault.mjs" "$1"
}

worker_sees_vault_access() {
	INFISICAL_TOKEN=planted INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=planted "$clone/session/with-vault" env | grep -q '^INFISICAL_'
}

echo "as $(id -un)"
expect succeed control-broker-answers ask '{"kind":"ready"}'
expect succeed control-with-vault-runs "$clone/session/with-vault" true
expect fail worker-sees-vault-access worker_sees_vault_access
expect fail session-sees-identity-path test -e "$identity"
expect fail session-holds-vault-env test -e "$session_home/.config/agent-sandbox/vault.env"
expect fail write-broker-directory touch "$(dirname "$socket")/.agent-sandbox-probe"
expect fail broker-serves-unknown-kind ask '{"kind":"export","path":"/"}'
expect fail broker-serves-extra-field ask '{"kind":"sandbox","path":"/tools/github"}'
expect fail broker-serves-unknown-group ask '{"kind":"sandbox","group":"agent-sandbox-probe"}'
expect fail broker-serves-unlisted-name ask '{"kind":"secret","path":"/tools/github","name":"AGENT_SANDBOX_PROBE"}'
expect fail broker-serves-path-traversal ask '{"kind":"secret","path":"/providers/../tools/github","name":"GITHUB_TOKEN"}'
expect fail broker-serves-vault-access-name ask '{"kind":"secret","path":"/","name":"INFISICAL_TOKEN"}'
expect fail broker-serves-unapproved-source ask '{"kind":"source","repository":"walid-mos/agent-sandbox"}'
exit "$failures"
