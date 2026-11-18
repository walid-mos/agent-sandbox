# Pot task handover

This is the sandbox contract for a Herdr submission to its owning pot. Installing the reviewed, signed source through the normal rollout activates it. A source push alone does not install it. Herdr presentation belongs to `agent-herdr`.

## Control contract

Invoke `node /opt/agent-sandbox/session/control.mjs OPERATION -` with one JSON object on stdin. A JSON argument also works when the caller passes a real argument array. Never interpolate task JSON into a shell command. The target is the configured lowercase bot ID returned as `owner` in task rows. This contract has no machine parameter and never routes into another pot.

| Operation | Input | Result |
| --- | --- | --- |
| `task-submit` | `id`, `target`, `text`, `provenance` | Durable intake and an attempted bot wake, followed by the current task row |
| `task-decide` | `id`, `state`, `reason` | Coordinator decision, with `state` equal to `accepted`, `rejected` or `needs-information` |
| `task-associate` | `id`, `worker` | Associate an accepted task with an existing registered worker owned by this bot |
| `task-adopt` | `id`, `terminal` | Associate an accepted task with one exact local execution, without launching or reparenting it |
| `task-result` | `id`, `sessionDigest`, `summary` | Preserve a direct execution's final transcript and screen with an explicit coordinator attestation |
| `task-delivery` | `id`, `delivery`, `state`, `reason` | Resolve an uncertain adopted follow-up after inspection, with `received` removing it or `retry` permitting another send |
| `snapshot` | No argument | Existing snapshot plus `tasks`, an array of task rows |

`id` is 1-96 letters, digits, dots or hyphens, beginning with a letter or digit. Herdr creates it once and retains the complete original payload for retries. Text is nonempty, contains no NUL, and takes at most 16,384 UTF-8 bytes. `provenance` has exactly `source`, `author`, and `reference`, each subject to that text limit. Submission refuses unknown fields. A different payload under an existing ID fails without replacing the intake. Decision reasons and coordinator result summaries use the same text validation.

The intake wake has `kind: "task-intake"`, the same `id`, `target`, `text`, and `provenance`, plus a fixed instruction about trust and explicit decisions. Its durable receipt ID is `task-intake-ID`. `delivery.state` is `unknown` before the transport call and remains so on any failed reply. Success records `delivered`. Neither state means acceptance. Repeating the original submission retries an unknown wake under its original receipt ID. Pots deduplicates that wake identity. After an uncertain Herdr transport reply, reconnect and inspect `snapshot.tasks`, then repeat the original submission if needed.

`acceptance` contains `state` and, after a decision, `reason`, `by`, and `at`. Acceptance is an explicit coordinator action. Accepted and rejected decisions are final. A repeated identical decision preserves its original timestamp. `needs-information` can later become accepted or rejected. Additional discussion uses the existing bot conversation, rather than editing an intake's immutable content.

## One relationship and one execution store

`session/tasks.mjs` owns intake validation and decisions. Intake records live beneath the existing bot terminal directory at `terminal/tasks/ID.json`. `session/task-store.mjs` serializes changes under a process-safe file lock. These records contain no worker status, execution or outcome copies.

`session/workers.mjs` owns the relationship. `WORKER.task` is the only persisted task association, projected as `worker.taskId`. It is separate from the mutable worker JSON because watcher saves can carry an older copy. Worker saves use their own file lock and cannot overwrite another association. Task operations hold the intake lock before changing the worker relationship. No worker save acquires the intake lock. Existing worker records, queue files, lifecycle files and result storage retain their responsibilities.

For a new worker, the coordinator uses the existing dispatcher with `--task ID` in addition to its existing arguments. It requires prior acceptance. Repeating that start with the same repository, branch and brief returns the existing associated worker, even after restart. Changing those selections under that ID fails. The normal queue, capacity checks, launch identity, exact Pi session and result acknowledgment remain in use. Task intake never starts a worker. Repository publication and approval rules still apply to dispatch. A partial Git/worktree/PR failure remains an actionable dispatch failure, rather than permission to create a replacement.

```mermaid
stateDiagram-v2
    [*] --> pending: durable intake
    pending --> needs_information: coordinator asks
    pending --> rejected: coordinator refuses
    pending --> accepted: coordinator takes ownership
    needs_information --> accepted: coordinator takes ownership
    needs_information --> rejected: coordinator refuses
    accepted --> associated: coordinator chooses existing queue worker or exact terminal
    associated --> progress: worker observation
    progress --> result_saved: lifecycle result or direct execution attestation
    progress --> attention_needed: execution disappears or identity changes
```

Delivery is independent of these states. `associated`, `progress`, `result_saved` and `attention_needed` in the diagram describe derived execution facts, not a second persisted task state machine.

## Snapshot and shared reporting facts

Each task row exposes `id`, `target`, `owner`, `text`, `provenance`, `receivedAt`, `receipt`, `delivery`, and `acceptance`. `execution` is absent until association. It then exposes:

- `worker`, the registered worker identity, and its recorded `terminal`, `sessionFile`, and `sessionId` when available.
- `mode`, either `managed` or `adopted`, and the preserved native `parent` for adoption.
- `status`, the current observed status, `starting`, `not started`, `stopped`, `attention-needed`, or `result-saved` when only a saved outcome remains. A launch failure also exposes its saved `failure` reason.
- `deliveries`, derived queue IDs with `queued` or `unknown` state.
- Worker `branch`, `commit`, `uncommitted`, `unpushed`, `cleanPass`, `pullRequest` and `result` facts when available.

A result is the existing worker result object with `id`, `state`, `screen`, and `transcript`. A direct execution's result additionally exposes `kind: "coordinator-attestation"`, `sessionDigest`, and `summary`. It records what the coordinator explicitly attested. It does not assert the presence of runtime pending-work checks in that direct process.

`session/task-view.mjs` is the sole projection for both snapshot and bot reporting. The existing watcher sends changes as a normal Pots wake with `kind: "task-report"` and `task` equal to the same task row. A deterministic digest supplies the wake ID. A missing transport reply leaves it retryable on the next observation or watcher restart. Task workers use this shared reporting wake in place of the ordinary worker-status wake, including launch failures and saved outcomes. The coordinator relays those facts through its existing conversation/Discord reporting route with the task ID. No separate Discord status computation or Discord credential is introduced.

Herdr must retain the task ID across reconnects, display delivery separately from acceptance, and render execution status and result from this row. Sending text or seeing a terminal alone does not assign a task. Submission and adoption are explicit actions. If the local control contract is absent, show that the installed sandbox needs its normal rollout. Never fall back to direct execution.

## New task example

Herdr submits this synthetic payload to the selected pot through control stdin:

```json
{"id":"task-synthetic-001","target":"synthetic","text":"Produce the synthetic report.","provenance":{"source":"herdr","author":"synthetic-person","reference":"synthetic-thread"}}
```

The coordinator decides, then selects its worker through the existing dispatcher:

```sh
node /opt/agent-sandbox/session/control.mjs task-decide '{"id":"task-synthetic-001","state":"accepted","reason":"This pot owns the report."}'
node /opt/agent-sandbox/session/dispatch.mjs start --task task-synthetic-001 --title 'feat: synthetic report' --subject 'feat: synthetic report' example/project feat/synthetic /config/synthetic-brief.md main
```

These are examples for an installed sandbox under its normal publication rules. They are not rollout instructions or approval to push.

## Existing execution example and limits

After accepting `task-synthetic-002`, the coordinator selects its exact local address:

```sh
node /opt/agent-sandbox/session/control.mjs task-adopt '{"id":"task-synthetic-002","terminal":"t7"}'
```

Adoption uses installed hc's `created_ms`, `argv`, local address, name, cwd, parent and `pi.session` label. The address must resolve to exactly one live terminal. The cwd must resolve beneath this pot's `Development` directory. The session must be a regular `.jsonl` file, no larger than 16 MiB, under this pot's Pi or worker session directory, with a Pi session header and exact ID. Symlinks resolving outside these directories are refused. Local aliases retain their published metadata and canonical destinations, and retargeting one invalidates the execution match. Another worker or managed owner on that execution is refused. Associate an existing registered worker with `task-associate` instead.

The original parent, argv, Git state, worktree and conversation are preserved. The owning bot tracks it through a registered worker association. A changed identity or vanished terminal needs inspection and cannot produce completion or an automatic replacement. `dispatch send` reaches a proven live adopted terminal. An uncertain send remains queued as `unknown` and is not automatically repeated. The coordinator inspects the exact conversation before resolving that delivery with `task-delivery`. `control stop-worker` can explicitly stop the proven execution.

A direct execution has no hot-installed worker lifecycle extension. After reading its final report, the coordinator can call `task-result` with the SHA-256 of its exact conversation and a summary. The terminal must be idle or done, the conversation must have a final assistant reply and no open goal, and the worktree must be clean and published. The existing result storage preserves its screen and exact transcript. The first outcome is final and retryable. `dispatch finish WORKER RESULT_ID` acknowledges this saved result while leaving the native terminal open.

Reparenting a native Mac child and resuming a vanished direct execution inside that same terminal are unsupported by hc 0.1.21. This contract refuses an automatic relaunch. Restoring an ended native execution requires a separately chosen supported operator action. Managed workers retain their existing exact-session resume behavior.

## Trust and activation

| Trusted principal | Untrusted input |
| --- | --- |
| Installed pot-local control and owning coordinator under existing pot rules | Herdr text, claimed provenance, display content and submitted identifiers |

The task code neither requests credentials nor changes credential scope. JSON remains parsed data and fixed argument values. It is never shell source, a launch command, a human-dialog result or an approval receipt. Claimed author metadata is preserved for display and audit, without authenticating a human or granting push, spend, credential or relaunch approval. Any same-user process that can invoke existing local control can also invoke coordinator operations. This is an intake contract, not isolation from a hostile session user.

Activation requires parent design approval, release of the rollout freeze, the normal reviewed and signed sandbox rollout, a watcher running that installed source, hc metadata compatible with the declared identity checks, and paired Herdr controls using this contract. No unmerged API from sandbox PR #43 is required. Herdr source needs this contract available before enabling submission/adoption controls. This PR remains draft until its hold is explicitly lifted.

Run `./bin/check` for the repository checks and `node --experimental-test-module-mocks --test probes/task-*.mjs` for the representative flow. The flow executes real control, dispatch, queue, worker runtime/inspection and result code in fresh child processes. Herdr transport, coordinator choices, external hc/Git/GitHub/Pots commands and the Discord bot/API are synthetic fixtures. It proves local state and boundary behavior, not live Discord clicks, model judgment, Mac rendering, real worker execution or native parent control. Test diagnostics separate disposable setup, execution and cleanup time. They are measurements of these fixtures, not production performance estimates.
