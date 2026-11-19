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

## Catch up across several releases

The publisher creates a lightweight tag at `refs/tags/factory-reviewed/<full-candidate-SHA>` pointing directly at the exact reviewed head. It sends that tag and the target ref in one atomic Git push. The target lease compares the checked base and the tag lease expects absence. An existing tag at the identical head is reusable. A conflicting tag or stale target rejects the whole push. The publisher confirms the target and tag before recording `published`. Recovery at the exact candidate also checks the tag. Keep these tags for as long as any receiver may need the corresponding releases.

Start with the receiver's known-good commit and the desired tip fetched from the configured repository and ref. Walk the tip's first-parent chain back to the known-good commit and require that it reaches that exact commit. In forward order, verify every Factory commit's signature and signed request under the enrolled repository and ref. Require the signed base and sole parent to equal the previous verified commit. Fetch each candidate's exact tag with automatic tag fetching disabled. Require the tag to point directly at the head in the signed request. Verify the checked base is an ancestor of that head and that both the head and candidate have the signed tree. Refuse a missing link, missing tag, conflicting tag or invalid checkpoint before installing anything from the series. A tag only locates an object. PR numbers and generations bind reviews and do not give release order.

```sh
work=$(mktemp -d)
python3 -B probes/landing-series.py --release 5947f43fe411c78510b58121df27dc96eaedf2c5 --export "$work/series"
python3 -B probes/landing-series.py --verify "$work/series"
```

The bundle contains `refs/heads/main` and the three candidate-keyed tags. `series.json` names the disposable operator anchor, target and tip, and includes the three checked records and receipts in oldest-first order for assertions. Use the two exported public keys and the fixture repository `probe/factory`. A receiver derives the order from Git and does not need `series.json` or the original PR refs in production. The earlier single-release export still uses its original `receipt.json` and `refs/pull/30/head` interface.

If the owner selects two-parent releases, the first parent still gives the previous release. The second parent would have to equal the reviewed head, which Git would then retain through ancestry. That format may replace the tag lookup after the producer and #53 agree on the new signed parent rule. GitHub PR readback and the Principal report remain separate requirements for that choice.

## Publication and adoption limits

The installed VM-root launcher and the Mac updater use operator keys. The VM trust installer copies the operator export and leaves the Factory public file for the managed receiver. The producer can extend an operator-signed base or the exact candidate in its own saved receipt. The receiver must enroll the Factory key separately for the configured repository and ref.

The producer builds a signed commit with the checked base as its only parent and the checked head's tree. The remote compares that exact base on the explicitly named target ref in the push. The producer checks live PR readiness, target and source head before signing and pushing. Git cannot compare live GitHub PR metadata inside that ref update. A later retarget or head edit cannot substitute another target or tree into the push. A direct squash push also does not establish that GitHub marked the PR merged.

The producer saves the signed object in the shared review record before any push. A retry can publish from the same base after rechecking the live PR, or acknowledge the exact candidate already at the target. Any other tip stops the retry. The protected signer keeps the identical receipt across restarts.

A fresh checked review can replace the signer receipt when the live target equals its new, trusted base and that base strictly advances the old receipt's base. The old release cannot use its lease on that target. The signer still checks the installed anchor, fetched PR head and reviewed tree before saving the new receipt. The old shared review record keeps its signed evidence. Recovery assumes the target advances without a forced rewind. The current ref cannot prove whether a candidate appeared in history that was later rewritten.

### GitHub merge state

[GitHub's merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request) can match the PR head. It has no input for the expected base SHA, expected target ref or a caller-signed commit to publish. The [asynchronous endpoint](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously) has the same limit.

[GitHub supports indirect merges](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges#indirect-merges) when an external update makes the PR head reachable from the default branch. A two-parent commit with the checked base first and the reviewed head second would give GitHub that ancestry and preserve the checked tree. A disposable Git repository verified both properties and the leased update. GitHub's merge status would still be a separate observation. A PR retarget or head change racing the push could leave the signed commit on the target without a merged PR. Direct pushes also depend on the target's branch rules.

The one-parent fixture remains the receiver contract pending the owner's decision. A two-parent release would require #53 to verify both parents and a new signed format before accepting it. Any workflow that uses indirect merges would record GitHub's confirmed outcome with the signed candidate and queue the Principal report under the same review lock. GitHub's merge endpoint remains the option for a native squash outcome if the owner changes the release guarantees.

### Separate signed evidence for native squashes

`python3 -B probes/landing-squash-proof.py --review-source REVIEW_COMMIT --export DIRECTORY` builds three simulated native squashes on a disposable remote. Use the exact #55 source commit as `REVIEW_COMMIT`. The probe binds each checked review through that revision's shared record code, simulates GitHub's `MERGED` response and verifies the landed tree from Git objects. Run `python3 -B probes/landing-squash-proof.py --verify DIRECTORY` to verify `squashes.bundle`, the scoped public keys and the review assertions in `squashes.json`. Each run generates fresh disposable keys and object IDs. Keep all four exported files together.

For the separate-evidence option, walk `main` in first-parent order from an operator-trusted anchor. At each squash SHA, fetch the signed annotated tag `refs/tags/factory-release/<squash-SHA>` and the lightweight reviewed-head tag `refs/tags/factory-reviewed/<squash-SHA>`. The signed tag object names the squash commit and has the subject `Factory squash evidence v1` followed by canonical JSON with the existing review fields plus `squash`. Verify the tag against the scoped Factory key, its internal tag name and target object, and the signed repository, target, PR, generation, base, head and tree. Verify the squash has exactly the prior checkpoint as its sole parent. The head locator must equal the signed head, and the head and squash must both have the signed tree. The JSON export is assertion data. Production verification takes authority from the signed tag object and the trusted anchor.

The draft proof requires matching PR readback and checks the actual squash parent and tree before signing. It saves the exact tag object ID before publication. A retry rereads that receipt and confirms both remote refs without another push if they match. Partial or conflicting refs stop recovery. The verifier checks the tag object ID in the export and refuses missing or transplanted evidence. A simulated concurrent base advance leaves a native squash on `main` that the signer refuses to certify. GitHub offers no expected-base or expected-target condition on the merge itself, so this path preserves exact VM admission and squash history only if the owner accepts that an uncertified merge can land and halt the release chain. It also requires a receiver policy that accepts signed tag evidence for this repository and target. Production would persist the verified GitHub outcome and exact tag object under the bound review lock before publication, then queue the Principal report after readback. This probe leaves the production path gated.

Source integration follows #55. Until then the existing GitHub squash entry point refuses the landing repository. At cutover, drain old record writers and start checked actions through generation-bound commands. Preserve terminal records, and use an observed draft/ready cycle to issue a fresh review generation if an eligible old record lacks a bound command.

The one-time owner transition needs an operator-signed anchor that advances the installed revision and contains the integrated producers and receiver. The current signer requires a trusted signed base before signing. A GitHub-signed tip on top of the accepted operator commit does not satisfy that requirement with the operator keyring. The current VM verifier accepts any commit signed by a key in its keyring. Before enrolling the Factory public key, the integrated receiver must enforce the repository, ref, review and tree policy on the Factory key's path. The Mac's operator keyring and the Pi, Herdr, overlays and other repository update paths stay outside that enrollment. Revocation requires removing the Factory authorization and recovering to a still-trusted operator-signed revision through the authorized owner transition.
