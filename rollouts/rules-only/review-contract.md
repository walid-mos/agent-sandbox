# Reviewing an execution contract

The owner reviews the exact runner manifest, execution scope, local paths, source revisions, window and continuing hold together. This document defines the contract fields and the hashing procedure, and supplies no execution approval.

The contract and hold are regular files owned by the operator with owner-only permissions. The journal's parent must already be an owned private directory without symlinks. All execution paths are absolute. Keep these documents private even though the contract contains no rule text.

| Contract field | Required meaning |
| --- | --- |
| `runId` | A unique single path component for this one attempt. |
| `review` | The concrete review receipt that accepted this scope, window and resources. |
| `ownerRoute` | The established owner route responsible for holding the affected work and reconciling failures. |
| `notBefore`, `expires` | Integer UTC Unix seconds defining the reviewed operator window. |
| `preflightSeconds` | Positive aggregate read-only budget within the runner's supported bound. |
| `scope` | The exact scope identifier in the runner's contract guard. |
| `artifactSha256` | The resource manifest's aggregate digest from `manifest`. |
| `checkout` | Clean operator source checkout with pinned implementations. |
| `sourceHead` | Full reviewed operator source SHA, matching the pinned revision. |
| `runtime` | Operator configuration root containing only the selected sandbox paths used by this run. |
| `privateCheckout` | Existing private source checkout selected by the source catalog. |
| `privateHead` | Full reviewed private main SHA containing the approved recipe and required source ancestry. |
| `original` | The authoritative original rule file before import. |
| `journal` | Absent attempt directory under an existing owner-private parent. |
| `installed` | The existing VM configuration directory accepted by the production guard. |
| `loaded` | The existing session instruction link accepted by the production guard. |
| `ownerProofSha256` | SHA-256 of the exact hold file bytes. |

Unknown fields are refused. Supported values and bounds have one implementation in the [contract guard](guards.py). The production byte identities and private repository/branch/commit subject are defined only in [the pinned resources](resources.json). Review those resources without obtaining or publishing the private recipe or rules.

The private checkout must already have its actual Git identity configured locally. The runner refuses a missing local identity and never invents or changes one. It confirms source privacy through the installed GitHub CLI, verifies local origin and source ancestry, and performs no fetch. The task branch must be absent locally. The canonical path and local snapshot/approval destinations must be absent. Remote branch existence is not inferred or checked by this local-only commit operation.

The hold contains exactly these fields:

| Hold field | Required meaning |
| --- | --- |
| `runId`, `review`, `ownerRoute` | Equal to the reviewed contract's values. |
| `isHeld` | True while the owner keeps the affected writers stopped or coordinated. |
| `notBefore`, `expires` | Integer UTC Unix seconds within which this hold applies. |
| `scopeSha256` | Digest of the full contract except `ownerProofSha256`, computed as below. |

To bind the documents without a circular hash:

1. Fill every contract field except `ownerProofSha256` from the concrete review.
2. Remove that field entirely, encode the remaining object with Python `json.dumps(value, sort_keys=True, indent=2) + '\n'` as UTF-8, and SHA-256 those bytes for the hold's `scopeSha256`.
3. Have the owner attest the hold through their established route and save the hold file.
4. SHA-256 the exact hold file bytes for the contract's `ownerProofSha256`.
5. Save the final contract. Review and record the SHA-256 of its exact file bytes for `--contract-sha256`.

Changing any execution field invalidates the hold. The runner compares the hold immediately before each stage. A hold file is an attestation, not a process lock. The owner must keep the hold while a mutation is in flight and revoke it before resuming other writers. The sandbox lock coordinates commands using the pinned importer's lock protocol. Direct writes and processes ignoring that lock remain the owner's responsibility.

The review must account for refusal after partial success. Expiry blocks the next mutation, but cannot undo one already started. A transfer can finish while acknowledgement remains pending. A local commit can exist even when the VM transfer fails. Each outcome remains journaled for the owner, and no failure grants permission to retry or publish.

The distribution's `fixture` command cannot arm production. It accepts only an owned temporary root with an active fixture marker, contained paths, synthetic hashes and the pinned source. The test transport restricts executable launches and denies socket operations in the runner process. The pinned store child receives only synthetic files and performs no network operation.
