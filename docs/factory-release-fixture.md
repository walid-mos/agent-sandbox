# Factory release fixture

The disposable producer signs and publishes a squash of a bound review to a local Git repository. The export pairs that exact candidate with the review record for the managed-update receiver. Use the export only in a disposable receiver.

## Produce and verify

Run from a clean checkout of the #30 producer with Git, Node.js, Linux `flock`, Python, `gpg`, `gpgconf` and `gpgv`. Fetch the pinned #55 commit if it is missing. The fixture runs the shared record and review binding code from that commit.

```sh
git fetch origin fix/bind-factory-verdict
work=$(mktemp -d)
python3 -B probes/landing-policy.py --release 5947f43fe411c78510b58121df27dc96eaedf2c5 --export "$work/release"
```

The command tests retargeting, a base update just before the push, recovery with a fresh review on a trusted advance, and an ambiguous result without a saved signed release. The successful retry scenario restarts after signing and again after pushing. It verifies the signature before writing `receipt.json`, `candidate.bundle`, `operator-public.asc` and `factory-public.asc`. Fresh disposable keys make each run's commit IDs different. The bundle and receipt from one run must travel together. The fixture puts its private keyrings in its temporary working directory and cleans them up before returning.

## Reuse in a receiver

The following reads the exported bundle offline. Use absolute paths if you copy it to another machine.

```sh
fixture="$work/release"
store="$work/objects.git"
receipt="$fixture/receipt.json"
ref=$(jq -r '.candidate.request.ref' "$receipt")
base=$(jq -r '.candidate.request.base' "$receipt")
head=$(jq -r '.candidate.request.head' "$receipt")
tree=$(jq -r '.candidate.request.tree' "$receipt")
candidate=$(jq -r '.candidate.commit' "$receipt")
number=$(jq -r '.candidate.request.number' "$receipt")
git init --bare "$store"
git -C "$store" fetch "$fixture/candidate.bundle" \
  "$ref:refs/remotes/origin/main" "refs/pull/$number/head:refs/heads/fixture-source"
test "$(git -C "$store" rev-parse refs/remotes/origin/main)" = "$candidate"
test "$(git -C "$store" show -s --format=%P "$candidate")" = "$base"
test "$(git -C "$store" show -s --format=%T "$candidate")" = "$tree"
test "$(git -C "$store" rev-parse refs/heads/fixture-source)" = "$head"
test "$(git -C "$store" rev-parse "$head^{tree}")" = "$tree"
git -C "$store" merge-base --is-ancestor "$base" "$head"
test "$(git -C "$store" show -s --format=%s "$candidate")" = 'Factory landing v1'
test "$(git -C "$store" show -s --format=%b "$candidate" | jq -Sc .)" = \
  "$(jq -Sc '.candidate.request' "$receipt")"
python3 -I lib/signed_commit.py verify "$store" "$base" "$fixture/operator-public.asc"
test "$(python3 -I lib/signed_commit.py verify "$store" "$candidate" "$fixture/factory-public.asc")" = \
  "$(jq -r '.candidate.fingerprint' "$receipt")"
```

For #53, seed the disposable installed checkout at `base`, stage the bundle's `main` as the candidate, and pass `candidate` by full ID. Use the fixture's enrolled repo `probe/factory` and target `refs/heads/main` in the test policy. Read `.review` and `reviewId` for the shared review. The `Factory landing v1` commit message contains signed JSON with repository, PR number, generation, ref, base, head and tree. Cross-check that payload against the checked record and Git objects. The export is a projection of the saved review and signer receipt. It grants no authority on its own.

## Publication and adoption limits

The producer builds a signed commit with the checked base as its only parent and the checked head's tree. The remote compares that exact base on the explicitly named target ref in the push. The producer checks live PR readiness, target and source head before signing and pushing. Git cannot compare live GitHub PR metadata inside that ref update. A later retarget or head edit cannot substitute another target or tree into the push. A direct squash push also does not establish that GitHub marked the PR merged.

The producer saves the signed object in the shared review record before any push. A retry can publish from the same base after rechecking the live PR, or acknowledge the exact candidate already at the target. Any other tip stops the retry. The protected signer keeps the identical receipt across restarts.

A fresh checked review can replace the signer receipt when the live target equals its new, trusted base and that base strictly advances the old receipt's base. The old release cannot use its lease on that target. The signer still checks the installed anchor, fetched PR head and reviewed tree before saving the new receipt. The old shared review record keeps its signed evidence. Recovery assumes the target advances without a forced rewind. The current ref cannot prove whether a candidate appeared in history that was later rewritten.

### GitHub merge state

[GitHub's merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request) can match the PR head. It has no input for the expected base SHA, expected target ref or a caller-signed commit to publish. The [asynchronous endpoint](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously) has the same limit.

[GitHub supports indirect merges](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges#indirect-merges) when an external update makes the PR head reachable from the default branch. A two-parent commit with the checked base first and the reviewed head second would give GitHub that ancestry and preserve the checked tree. A disposable Git repository verified both properties and the leased update. GitHub's merge status would still be a separate observation. A PR retarget or head change racing the push could leave the signed commit on the target without a merged PR. Direct pushes also depend on the target's branch rules.

The one-parent fixture remains the receiver contract pending the owner's decision. A two-parent release would require #53 to verify both parents and a new signed format before accepting it. Any workflow that uses indirect merges would record GitHub's confirmed outcome with the signed candidate and queue the Principal report under the same review lock. GitHub's merge endpoint remains the option for a native squash outcome if the owner changes the release guarantees.

Source integration follows #55. Until then the existing GitHub squash entry point refuses the landing repository. At cutover, drain old record writers and start checked actions through generation-bound commands. Preserve terminal records, and use an observed draft/ready cycle to issue a fresh review generation if an eligible old record lacks a bound command.

The one-time owner transition needs an operator-signed anchor that advances the installed revision and contains the integrated producers and receiver. The current signer requires a trusted signed base before signing. A GitHub-signed tip on top of the accepted operator commit does not satisfy that requirement with the operator keyring. The current VM verifier accepts any commit signed by a key in its keyring. Before enrolling the Factory public key, the integrated receiver must enforce the repository, ref, review and tree policy on the Factory key's path. The Mac's operator keyring and the Pi, Herdr, overlays and other repository update paths stay outside that enrollment. Revocation requires removing the Factory authorization and recovering to a still-trusted operator-signed revision through the authorized owner transition.
