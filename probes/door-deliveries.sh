#!/bin/bash
set -u

pots=$1
NONCE=0000000000000000
CALLER=probe
failures=0

requests() {
	"$pots" requests --all < /dev/null 2> /dev/null
}

# A forged delivery runs through the command the door runs, and passes only when it is refused and leaves the requests as they were.
refused() {
	name=$1 caller=$2
	before=$(requests)
	if "$pots" wake --from "pot:$caller" --note-file - > /dev/null 2>&1; then outcome=accepted; else outcome=refused; fi
	after=$(requests)
	if [ "$outcome" = refused ] && [ "$before" = "$after" ]; then
		echo "ok   door-refuses-$name"
	else
		echo "FAIL door-refuses-$name ($outcome)"
		failures=$((failures + 1))
	fi
}

refused reply-to-a-request-never-asked "$CALLER" <<< "reply $CALLER.$NONCE
boundary probe: a reply to a request this pot never opened"
refused request-in-another-pots-name "$CALLER" <<< "request other.$NONCE
boundary probe: a request in another pot's name"
refused malformed-header "$CALLER" <<< "order $CALLER.$NONCE
boundary probe: a header that names no kind"
refused path-shaped-request-id "$CALLER" <<< "request ../../$CALLER.$NONCE
boundary probe: a request ID shaped like a path"
refused empty-note "$CALLER" <<< "request $CALLER.$NONCE"
refused oversized-message "$CALLER" < <(printf 'request %s.%s\n' "$CALLER" "$NONCE"; head -c 17000 /dev/zero | tr '\0' a)
refused nul-byte "$CALLER" < <(printf 'request %s.%s\nboundary\0probe' "$CALLER" "$NONCE")
refused text-that-is-not-utf8 "$CALLER" < <(printf 'request %s.%s\n\xff\xfe' "$CALLER" "$NONCE")
refused caller-that-is-not-a-pot-name ../probe <<< "request $CALLER.$NONCE
boundary probe: a caller name shaped like a path"
exit $((failures > 0))
