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
refused request-in-another-pots-name "$CALLER" <<< "request other.$NONCE 0
boundary probe: a request in another pot's name"
refused malformed-header "$CALLER" <<< "order $CALLER.$NONCE
boundary probe: a header that names no kind"
refused path-shaped-request-id "$CALLER" <<< "request ../../$CALLER.$NONCE 0
boundary probe: a request ID shaped like a path"
refused request-past-the-hop-limit "$CALLER" <<< "request $CALLER.$NONCE 3
boundary probe: a request forwarded once more than a pot takes"
refused empty-note "$CALLER" <<< "request $CALLER.$NONCE 0"
refused oversized-message "$CALLER" < <(printf 'request %s.%s 0\n' "$CALLER" "$NONCE"; head -c 17000 /dev/zero | tr '\0' a)
refused nul-byte "$CALLER" < <(printf 'request %s.%s 0\nboundary\0probe' "$CALLER" "$NONCE")
refused text-that-is-not-utf8 "$CALLER" < <(printf 'request %s.%s 0\n\xff\xfe' "$CALLER" "$NONCE")
refused caller-that-is-not-a-pot-name ../probe <<< "request $CALLER.$NONCE 0
boundary probe: a caller name shaped like a path"

# A pot holding an unanswered request at the end of a chain asks nothing, --for or not, so a woken bot cannot start the count again.
# The ask runs in a scratch home whose ssh only records a knock, so a pot that did ask reaches no door and wakes no bot.
chain_refused() {
	scratch=$(mktemp -d)
	folder="$scratch/.config/agent-sandbox/requests"
	held="$CALLER.$NONCE"
	mkdir -p "$folder" "$scratch/.local/bin"
	printf '#!/bin/sh\ntouch "%s/knocked"\nexit 1\n' "$scratch" > "$scratch/.local/bin/ssh"
	chmod +x "$scratch/.local/bin/ssh"
	printf '{"id":"%s","direction":"received","pot":"%s","need":"boundary probe","hop":2,"state":"open","at":0}\n' "$held" "$CALLER" > "$folder/$held.json"
	output=$(HOME="$scratch" PATH="$HOME/.local/node/bin:$PATH" "$pots" ask "$CALLER" --need 'boundary probe: a fresh chain from the end of one' 2>&1 < /dev/null)
	code=$?
	if [ "$code" -ne 0 ] && [[ "$output" == *"$held"* ]] && [ ! -e "$scratch/knocked" ] && [ "$(ls "$folder")" = "$held.json" ]; then
		echo "ok   ask-refuses-a-fresh-chain-at-the-hop-limit"
	else
		echo "FAIL ask-refuses-a-fresh-chain-at-the-hop-limit (exit $code: $output)"
		failures=$((failures + 1))
	fi
	rm -rf "$scratch"
}
chain_refused
exit $((failures > 0))
