# Managed update preflight

The receiver checks one staged source commit and prints a JSON receipt the caller can save. It runs on direct invocation.

## Receiver contract

```sh
python3 -I lib/managed_update.py RECEIVER agent-sandbox COMMIT
```

Run the command from a trusted copy with Python, Git and `gpgv` available in system locations. `RECEIVER` is an absolute path to a dedicated directory controlled by the receiver account. That account owns the layout and excludes other writers during preflight. A project checkout or a path offered by a job is outside this contract. Do not run this command from the candidate.

| Entry inside `RECEIVER` | Expected evidence |
| --- | --- |
| `source` | Protected enrollment file containing the source ID and a newline. |
| `checkout/` | Dedicated ordinary clone on `main`, with the canonical origin, no linked worktrees and no edits, including masked, untracked and ignored files. |
| `candidate.git/` | Separate bare repository with the canonical origin and `refs/remotes/origin/main` populated by a trusted fetcher. |
| `trusted-signers.asc` | Existing authorized OpenPGP public keys from the operator-controlled trust configuration. |

The sandbox origin comes from the launcher configuration. Other source IDs come from the provisioning catalog and are blocked pending repository-specific enrollment and trust. The preflight compares the full commit ID with the staged ref, checks both commit objects and requires signed installed and candidate commits with a fast-forward relationship. It establishes what the trusted fetcher staged. Verifying freshness at the canonical remote is the fetcher's responsibility. The signature covers the candidate commit and its referenced history. Intermediate commits are not required to carry individual signatures.

The receiver checks ownership, permissions and repository layout before inspecting Git state. It refuses linked worktree metadata, object stores reached through alternates, unsafe Git configuration and symlinks inside either repository. It uses system tools with a reset environment, disables Git's optional writes and hooks, and accepts no network transport. The inputs provide Git data and public keys only. No fetch credentials, signing keys, installers or candidate programs cross this boundary. The receiver issues one receipt on stdout and exits `1` on a block. Repository files and refs are read-only to the preflight.

Run the command below with Git, `gpg`, `gpgconf` and `gpgv`. The fixture checks signed and unsigned commits, refusal cases and byte-for-byte preservation of a dirty unrelated checkout.

```sh
python3 -B probes/managed-update.py
```

## What the receipt establishes

`desired` is the requested commit. `checkout` is the observed on-disk commit. `verified` pairs the candidate commit with its signer fingerprint when all checks pass. `blocked` reports the first failed check. `provisioned`, `executables`, `process_starts`, `active`, `applied_rules` and `known_good` stay unknown in this source-only phase.

The owner and session reports used to review this contract describe past observations. Cached refs and a provisioning receipt have the following limits.

| Evidence | What remains to verify |
| --- | --- |
| Nextnode observed matching checkout and provisioned revisions, followed by service starts. | The host timer and journal were outside the session view. Start times do not identify the loaded commit or prove health. |
| Personal observed matching source receipts and executables on disk in a headless session. | The watcher replacing either executable, the running source revision and native panes were unverified. |
| A client session observed matching source receipts and cached refs. It reported distinct globally installed and application-bundled Pi versions, plus a running core version. | Host timer enablement and execution of the signature check were outside the session view. The loaded source revision and periodic executable replacement were unverified. Applied rules had separate approval and readback. |

The provisioning path serializes setup and checks the branch, tracked edits, Git configuration, origin and fast-forwardability in the ordinary refresh path. A checkout can advance before setup fails and leave the previous provision receipt in place. Setup locks do not check in-flight work or dialogs. The watcher's existing provisioning flow provides no signature, coordinated reload, health or rollback receipt.

## Before activation

A later rollout needs protected fetch and durable staging receipts, an admission gate that proves affected work and dialogs have reached a safe checkpoint, and an update transaction that keeps the previous verified release. It must cover restart paths triggered by the keeper. Restart only the named consumers that need the change, and record a healthy response from each with its loaded release ID. Keep the accepted remote checkpoint separate from the rollback pointer. Recovery must select a still-trusted release from outside the failed checkout and leave a block reason if safe recovery is unavailable.

The approved Factory design delegates sandbox signing for VM receivers to the Nextnode signing VM. The Mac uses operator signatures. See [PR #30](https://github.com/walid-mos/agent-sandbox/pull/30).

Pi, Herdr and overlays need repository-specific trust decisions and any needed staging, health and recovery work in their own source PRs. Executable pins and replacement need their own proof. Trust changes, deployment, Mac steps, enabling update automation and service restarts require separate operator authorization.
