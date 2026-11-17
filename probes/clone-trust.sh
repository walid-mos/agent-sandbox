#!/bin/bash
set -u

trusted=$1
signers=$2
clone=$3
failures=0
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

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

verify() {
	python3 -I "$trusted/lib/signed_commit.py" verify "$1" "$2" "$signers"
}

scratch_git() {
	git -c init.defaultBranch=main -c user.name=probe -c user.email=probe@invalid -c commit.gpgsign=false -C "$scratch/candidate" "$@"
}

# The clone's signed head with an edited message keeps its signature, which no longer covers the commit.
forged_head() {
	git -c "safe.directory=$clone" -C "$clone" cat-file commit HEAD | sed '$ s/$/ forged/' | scratch_git hash-object -t commit -w --stdin
}

launcher_is_root_only() {
	[ "$(stat -c '%U %a' "$trusted/lib/trusted_source.py" "$signers" | sort -u)" = 'root 644' ]
}

echo "as $(id -un)"
git init --quiet "$scratch/candidate"
scratch_git commit --quiet --allow-empty --message 'unsigned probe'
expect succeed control-clone-verifies python3 -I "$trusted/lib/trusted_source.py" verify
expect succeed launcher-and-signers-root-owned launcher_is_root_only
expect fail unsigned-candidate-accepted verify "$scratch/candidate" HEAD
expect fail forged-candidate-accepted verify "$scratch/candidate" "$(forged_head)"
expect fail untracked-script-runs python3 -I "$trusted/lib/trusted_source.py" run ../../bin/sh -c true
expect fail unprivileged-write-clone sudo -u nobody touch "$clone/.agent-sandbox-probe"
expect fail unprivileged-write-launcher sudo -u nobody touch "$trusted/lib/.agent-sandbox-probe"
expect fail unprivileged-write-signers sudo -u nobody sh -c "echo > '$signers'"
exit "$failures"
