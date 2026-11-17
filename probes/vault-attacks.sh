#!/bin/bash
set -u

clone=$1
session_home=$2
identity=$3
socket=$4
node=$5
configuration=$6
session_user=$7
failures=0
export HOME="$session_home" POTS_REPO="$clone"
. "$clone/session/lib.sh"
PATH="$(dirname "$node"):$PATH"
session_identity="$session_home/$POTS_SESSION_VAULT_DIRECTORY/$POTS_SESSION_VAULT_FILE"
session_binding="$session_home/$POTS_SESSION_VAULT_DIRECTORY/core-vault.json"

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

sources_without_token() {
	"$node" -e 'const { readFileSync } = require("node:fs");
const [catalog, sandbox] = process.argv.slice(1).map(path => JSON.parse(readFileSync(path, "utf8")));
const selected = sandbox.sources ?? [];
for (const [name, source] of Object.entries(catalog)) {
  if (!source.credential || !selected.includes(name)) console.log(name, JSON.stringify({ kind: "source", repository: source.repository }));
}' "$clone/session/agent-sources.json" "$configuration/sandbox.json"
}

worker_keeps_session_login() {
	"$clone/session/with-vault" "$node" -e 'const { readFileSync } = require("node:fs");
const pairs = readFileSync(process.argv[1], "utf8").trim().split("\n").map(line => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]; });
process.exit(pairs.every(([name, value]) => value && process.env[name] === value) && process.env.INFISICAL_MASK_SECRET_VALUES === "true" ? 0 : 1);' "$session_identity"
}

session_login_lists_names() {
	"$node" -e 'const { readFileSync } = require("node:fs"); const { spawnSync } = require("node:child_process");
const binding = JSON.parse(readFileSync(process.argv[1], "utf8"));
const answer = spawnSync(process.execPath, [process.argv[2], "--projectId", binding.projectId, "--env", binding.environment, "--path", "/"], { stdio: "ignore" });
process.exit(answer.status === 0 ? 0 : 1);' "$session_binding" "$session_home/.pi/agent/security/secret-names.mjs"
}

session_login_is_private() {
	[ "$(stat -c '%U %a' "$session_identity" "$session_binding" "$(dirname "$session_identity")" | tr '\n' ' ')" = "$session_user 600 $session_user 600 $session_user 700 " ]
}

echo "as $(id -un)"
expect succeed control-broker-answers ask '{"kind":"ready"}'
expect succeed control-with-vault-runs "$clone/session/with-vault" true
expect succeed wrapped-command-keeps-session-login worker_keeps_session_login
expect succeed session-login-lists-names session_login_lists_names
expect succeed session-login-files-private session_login_is_private
expect succeed session-infisical-cli-installed "$session_home/.local/bin/infisical" --version
expect fail session-sees-broker-identity-path test -e "$identity"
expect fail write-broker-directory touch "$(dirname "$socket")/.agent-sandbox-probe"
expect fail broker-serves-unknown-kind ask '{"kind":"export","path":"/"}'
expect fail broker-serves-extra-field ask '{"kind":"sandbox","path":"/tools/github"}'
expect fail broker-serves-unknown-group ask '{"kind":"sandbox","group":"agent-sandbox-probe"}'
expect fail broker-serves-unlisted-name ask '{"kind":"secret","path":"/tools/github","name":"AGENT_SANDBOX_PROBE"}'
expect fail broker-serves-path-traversal ask '{"kind":"secret","path":"/providers/../tools/github","name":"GITHUB_TOKEN"}'
expect fail broker-serves-vault-access-name ask '{"kind":"secret","path":"/","name":"INFISICAL_TOKEN"}'
expect fail broker-serves-unapproved-source ask '{"kind":"source","repository":"walid-mos/agent-sandbox"}'
unserved=$(sources_without_token) || { echo "FAIL read-source-selection"; failures=$((failures + 1)); }
while read -r name request; do
	[ -n "$name" ] || continue
	expect fail "broker-serves-token-of-$name" ask "$request"
done <<< "$unserved"
exit "$failures"
