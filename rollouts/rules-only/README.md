# Reviewed rules-only import

This runner imports an exact private recipe and transfers its approved rules through the existing trusted configuration route. It prepares a private canonical commit locally and requires separate publication approval.

```mermaid
stateDiagram-v2
    [*] --> Unarmed
    Unarmed --> Refused: Missing review or incompatible proof
    Unarmed --> Preflight: Concrete contract and owner hold
    Preflight --> Refused: Drift or deadline
    Preflight --> Recorded: Durable ownership and backups
    Recorded --> Local: Journal each local write
    Local --> PrivateCommit: Commit canonical rules locally
    PrivateCommit --> Transferred: One trusted bundle transfer
    Transferred --> Acknowledged: Verify files and clear pending
    Acknowledged --> Verified: Read loaded file hashes
    Recorded --> Reconcile: Failure or interruption
    Local --> Reconcile: Failure or interruption
    PrivateCommit --> Reconcile: Failure or interruption
    Transferred --> Reconcile: Failure or interruption
    Acknowledged --> Reconcile: Failure or interruption
```

Start with the read-only resource manifest:

```sh
python3 -I rollouts/rules-only/run.py manifest
```

The manifest hashes the runnable resources. [The pinned source and approved byte identities](resources.json) define compatibility. The runner must be stored separately from the clean operator checkout it checks. It refuses incompatible Mac or VM implementations without updating either checkout.

A future operator first reviews a concrete [contract and owner hold](review-contract.md). The distribution supplies neither an execution window nor an owner approval. An operator-provided document is an attestation through that owner's established route. Possession of a file or an artifact hash does not establish human approval.

After that separate review, the invocation has this form. Every uppercase word is a required reviewed value, not a default:

```sh
python3 -I rollouts/rules-only/run.py execute \
  --contract /ABSOLUTE/OWNER_PRIVATE/contract.json \
  --contract-sha256 REVIEWED_CONTRACT_SHA256 \
  --owner-proof /ABSOLUTE/OWNER_PRIVATE/hold.json
```

The runner checks the original, recipe and computed result with the pinned `apply_recipe` before durable preparation and immediately before canonical creation. It holds the importer's sandbox directory lock while writing. Hash and state checks repeat between stages. Each read-only command and the aggregate preflight are bounded. Once a mutation starts, expiry does not interrupt it. There is no execution duration promise.

The unrelated configuration comparison covers the exact bytes the pinned store implementation will write and all optional-file membership. Different JSON formatting on the VM causes refusal even when its parsed values match. After transfer, the runner compares the VM and session files again before acknowledging. A hash proves the file visible to the process, not that an existing agent reread its instructions.

The runner uses the pinned bundle builder and trusted `vm/store-config` route directly. It journals acknowledgement separately instead of invoking the unjournaled `bin/client-rules` or `bin/vm-config` wrapper. It never retries a failed transfer or invokes the old wrapper's recovery advice.

## Failure and reconciliation

The ownership record is created outside the journal directory before that directory exists. The journal records an intent before an operation and confirms it only after its postconditions. File contents and directory entries are flushed to disk. If a failure follows a write, the retained state is deliberately left in place.

| Observation | Meaning and next action |
| --- | --- |
| No ownership record and no journal | Preflight did not consume an attempt. Resolve the refusal through the owner before considering a reviewed invocation. |
| Ownership record without a complete journal | Initialization may have been interrupted. Inspect through the original contract and retain the record. |
| Intent without confirmation or `failed-unknown` | Reconcile observed files and Git state with the owner. Never rerun or infer that a nonzero exit means nothing changed. |
| Transfer confirmed but acknowledgement absent | The VM may already hold the result while the local approval remains pending. Inspect both sides through the same owner route. |
| Final file proofs confirmed | The private commit is still local. Publication and any claim about active agent behavior need their own evidence and approval. |

Use the original contract and its reviewed hash for read-only reconciliation. Its window may have expired:

```sh
python3 -I rollouts/rules-only/run.py inspect \
  --contract /ABSOLUTE/OWNER_PRIVATE/contract.json \
  --contract-sha256 REVIEWED_CONTRACT_SHA256
```

Add `--vm` on the reviewed operator Mac to collect fresh trusted VM and session file proofs. The command performs no transfer, acknowledgement, Git update or cleanup. A changed source implementation causes VM inspection to refuse. Inspect the retained local evidence through the owner rather than installing replacement source.

Keep the original contract, ownership record, journal and private backups until the owner reconciles every intent. Do not delete the attempt to bypass the rerun refusal. There is no resume, automatic restore, retry, rollback or restart command. A torn journal requires private owner inspection of the retained bytes. Recovery may require a separately reviewed manual action with a new scope.

## Private information and boundaries

Only fixed diagnostics, hashes, booleans and the exact private commit/remote/branch are emitted. Recipe text, rule text, raw configuration bundles and subprocess diagnostics stay out of reports. Backups contain private bytes and remain in the owner's private journal directory.

The [trust boundary](trust-boundary.md) names the cooperating processes and the checks that constrain untrusted source files. Synthetic fixtures use the public command in an explicitly isolated temporary directory. Their hash substitution, delays and injected failures are available only through the fixture subcommand. Production execution exposes no fixture override.
