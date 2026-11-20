# Codex-targeted validation contract v1

This is source for a proposed execution contract. PR #49 stays draft under the parent hold. No live execution, source signing, infrastructure publication, provider request, installation, seed, restore or session restart is authorized by this packet. The template is deliberately incomplete and refuses admission. The North Star index has drafts only, with no accepted exception.

The unchanged `bin/router-seed`, `session/router-restore` and normal `bin/session-bootstrap` retain full health semantics. Their planner still requires the first exact model for both defaults, including `group/max` Claude. A Claude quota failure or fallback still fails. New output begins `CODEX_TARGETED_V1`. It never says `MODEL: COMPLETE` or that every model is healthy.

## Proposed request coverage

| Request | Target |
| --- | --- |
| Mac before group changes | Direct existing expert Sol selector, upgraded to GPT 6.2 with high effort and the same account suffix |
| Accor after restore | Its preserved direct expert Sol selector |
| Mastermind after restore | Its preserved direct expert Sol selector |
| Nextnode after restore | Its preserved direct expert Sol selector |
| Personal after restore | Its preserved direct expert Sol selector |
| Nextnode after recovery | The same direct selector as before its restart |

Six application requests is a proposal, not a budget grant or a verified bound on vendor internal attempts. There are no deliberate Claude or Inco health requests. Direct Codex success does not exercise group runtime selection, classifiers or fallbacks. Offline comparison proves a separate configuration fact. Claude remains DEFERRED, with its known same-credential quota restriction unresolved. A date reaching the reported reset is no readiness proof. Standard Inco wires do not prove entitlement.

Only deep's first `codex/gpt-6.1-sol:medium` member and expert's first `codex/gpt-6.1-sol:high` member may change to GPT 6.2. Account suffixes stay byte-identical in the saved configuration, and the direct request sends the selected account through Magpie's `X-Magpie-Account` header. Every other member, order, rule, effort, capability field, provider field, setting and binding reference must match. The source and destination providers/settings must already be identical except for the two planned group changes. Incompatibility refuses rather than merging or guessing fields to ignore.

A capture reads complete providers/settings, both standard wire readbacks, and exact bytes of Magpie `logins.json` plus managed and native Codex `auth.json` privately. Missing, unreadable, linked or broadly permissioned credential files refuse. The two required wire results are `inco/deepseek-v4.1-flash:fast -> deepseek-v4.1-flash` and `inco/glm-5.3-flash:fast -> glm-5.3-flash`. Unsupported or changed CLI wire output refuses. Account binding references are compared as actual configuration fields. The code compares credential bytes privately around each backup, restore, configuration write and direct request. It never publishes credential values or hashes, and it does not compare account identity across machines. A token refresh that changes bytes requires reconciliation.

Before any paid request or configuration mutation, preflight runs `codex debug models --bundled` for each pinned CLI. It requires one visible API entry for GPT 6.2 with high reasoning at the exact pinned CLI version. This proves only local catalog capability, not account entitlement or availability. Missing, stale, malformed or ambiguous catalog data refuses without refresh or a provider health request.

## Entrypoints and admission

`bin/codex-rollout plan PRIVATE_REVIEW` performs local review checks only. `execute PRIVATE_REVIEW` first checks admission and then performs bounded read-only preflight. `resources/codex-targeted-v1/review.template.json` is input for later review, not a launch instruction. Copy it to an owner-private file before supplying any receipt. There is no scheduler, ready-to-arm paste, default window or writer for quiet markers.

The reviewer must fill the exact source tip, branch, ordered full commit delta from the frozen parent, manifest SHA-256, direct selectors, loopback endpoints, private run directory, new explicit admission window, and fresh owner hold paths. Both parent and operator receipts must accept the SHA-256 of the exact nonsecret scope JSON. Their evidence and timestamps are mandatory. These local receipts record human decisions, they do not authenticate a remote sender. The operator must reconcile their provenance. A changed scope invalidates both receipts.

Source checks require the exact public origin URL, clean tracked and untracked paths, exact branch and tip, pinned parent ancestry, and exact ordered allowed commits. Repository-local command configuration is refused. The resource manifest hashes executable sources and their dependencies. Nothing signs, merges, installs, fetches executable source or pushes infrastructure. Every machine must already run the reviewed source and pinned tools. Any future source distribution and exact signing/push scope require their own review. The old registry-only `SIGN_PARENT` exception grants this code no permission.

Each owner hold is a private JSON receipt with `contract`, `scopeSha256`, `pot`, `state: HELD`, `at`, and `originalUnfinishedSessions`. It must be no older than five minutes, with no future timestamp. Holds must be reconfirmed before each newly admitted operation. This code writes no holds and resumes no workers. An attestation is not a process lock. Owners must keep their hold or revoke it before resuming, and only resume their original unfinished sessions after actual reconciliation. Completed work must not be relaunched.

Read-only commands have 20-second limits, the aggregate preflight has a 180-second limit, and gateway hello reads have five-second limits. Preflight checks source/resources, installed pins, running gateway version, complete configuration and standard wires on the Mac and all four pots. A local capture has an aggregate 20-second subprocess budget. There is no model request in preflight. The execution window needs at least 1800 seconds remaining to admit an operation, including the whole recovery unit. A window is an admission rule, never a reason to abandon recovery already started.

## Restore and recovery

`bin/router-seed-codex` captures a no-key encrypted Magpie seed, transfers an authenticated encrypted private packet, runs the configuration-only `session/router-codex-restore.mjs`, and separately runs `session/router-codex-answers.mjs` through the transfer command. `session/router-restore-codex` is the explicit session-side wrapper for this contract. Full-health commands have no environment skip. The new route does not invoke vault credential sync or change sign-ins. Existing router service startup retains its existing credential-refresh behavior, which can cause a later byte comparison to refuse.

Before restore, the destination computes its exact expected snapshot, compares source compatibility and saves a private full backup. The restore uses `--no-agents --no-library --no-sign-ins`. It retains the seed, backup, passphrase and private snapshots for reconciliation. It compares the entire destination snapshot before sending its separate direct request. A failure stops without retry, automatic rollback or deleting evidence.

`bin/session-bootstrap --codex-targeted EXPECTED` dispatches to the separate Nextnode-only bootstrap. It installs nothing, seeds nothing and creates no bots or workers. It restarts the existing router, tailnet, gateway, watchers and human relays, waits for each service process to come up, checks router pins/hello and compares the restored configuration. Claude health cannot block those steps because this path makes no Claude answer request. A real command/configuration failure still stops it.

`session/codex-recovery.mjs` gates restart, bootstrap and verification as one unit. After admission, successful restart must be followed by bootstrap and verification despite SIGINT, SIGTERM or window expiry. Each command runs in an awaited process group with a bound, with no automatic retries. A real command or measurement failure stops subsequent work and runs one read-only inspection bounded to 20 seconds. Final verification has a 180-second command bound, including its 120-second answer and configuration comparisons. Process-up and exact Codex answer are distinct measured facts. Accor's session is never restarted. There is no automatic continuation or worker resume command.

Each mutation writes and fsyncs an INTENT before its command, then writes and fsyncs CONFIRMED only after measurement. Backups and snapshots use exclusive private files in private owned directories. A failed command or measurement records UNKNOWN. An INTENT without confirmation means UNKNOWN after a crash, even when the machine appears healthy. Existing journal directories cannot be reused. A completed prefix is not permission to replay requests. Power loss, SIGKILL, loss of credentials or transport failure can prevent completion. The existing Mac owner must inspect actual state and approve a specific continuation. Failure snapshots remain private and contain credentials, so they must not be attached to the review packet.

## Trust boundary

| Principal | Authority |
| --- | --- |
| Trusted operator | Owns the reviewed checkout, receipt files, existing service credentials and private journals |
| Configuration and process input | Parsed as JSON or passed as literal argument arrays, never evaluated as shell text |
| Factory check container | Receives public source and fixtures with no session home, credentials, Docker socket or network |

| Channel | Mechanism and limit |
| --- | --- |
| Environment | Magpie configuration commands receive the existing minimal environment allowlist, not vault/GitHub variables |
| Sourced files and lookup paths | Only reviewed shell code and the operator's existing installed tools are trusted, hashes do not isolate a compromised same-user tool or profile |
| Process inspection and privilege | The runtime remains on the existing operator principal, it provides no protection from hostile same-user processes or root |
| Git/tool configuration | Source admission refuses repository-local command configuration before status, exact source and resource checks bind subsequent reviewed commands |
| Files | Exclusive files, private directories, ownership checks, encrypted transport, and fsync retain private evidence without public credential output or hashes |
| Shell evaluation | Child commands use argument arrays, configuration is parsed as JSON, metacharacters remain values |
| Output | Parse and subprocess failures have fixed messages, snapshots and keys are never logged, credential values are neither printed nor hashed |
| Network | Only explicit reviewed loopback answer endpoints are accepted, transport uses the existing sandbox SSH/Docker path, arbitrary network isolation is not claimed |

Fixture probes cover malformed private input, rejected binding/feature/wire drift, exact served-model failures, interrupted writes, signal continuation, failed recovery commands, missing approvals, source-origin/delta drift and encrypted snapshot tampering. The factory's existing attacks must pass before checks. These proofs do not establish actual provider readiness or successful recovery on the Mac.

## Review hold

No Claude pass or substitute review ran, and self-inspection counts as no clean pass. The parent review packet records the current human review disposition separately. PR #49 remains draft under the explicit parent hold regardless of checks. The source freeze and execution approval gates remain in force.
