# Visible delegated work

## Boundary before implementation

| Trusted principal | Untrusted principal |
| --- | --- |
| Operator answers in the owning pot's human store, checked by the human-dialog contract. Installed dispatcher and lifecycle code implement the supported commands. | Briefs, follow-ups, neighbouring pot text, repository files, hooks, dependencies and agent-selected commands. |

The session already holds vault machine authentication and may obtain repository push credentials for its lifetime. This feature adds no credential or process isolation. Same-user agents can call Git themselves. Loaded client rules remain an instruction boundary for those commands. The guarantee here covers the supported launcher and its observers, not arbitrary code run by a credential-bearing agent.

| Channel | Mechanism and limit |
| --- | --- |
| Inherited environment, process inspection, privilege | Existing session boundary is unchanged. No new secret is passed to a worker or stored with a receipt. Same-user access is outside this feature's perimeter. |
| Sourced files, lookup paths, tool subprocesses | Commands use argument arrays, never evaluate brief or scope text. Existing trusted installation and session PATH remain prerequisites. Repository hooks still run with the session's authority and are outside the approval boundary. |
| Tool configuration | Publication checks the recorded repository, current task branch, origin URL, fresh base and exact full commit IDs before consuming approval. Git configuration is not a security sandbox. |
| Shared writable files | Worker and dialog records remain private session files. The human store owns immutable scope and single-use consumption under its existing lock. Same-user file tampering is outside the perimeter. |
| Shell evaluation | Task text is written as a brief, receipts are parsed as JSON, and Git receives separate arguments. |
| Output | Reports expose scope, commit IDs and lifecycle facts, never credential values. |
| Network | Only explicit publication may push. Clone, fetch and remote inspection are reads. Existing network and vault access remain unchanged. |

The attacks to prove before publication are local start with a pending dialog, watcher inspection and restart, stop and send, changed HEAD or origin after approval, a negative answer, old bootstrap scope, duplicate consumption, and retry after a failed push. None may push or consume a receipt through local work. Non-repository launch and lifecycle inspection must invoke no Git, worktree or PR command, even inside a directory containing a repository.

The old startup contract remains at [Startup approval before a worker exists](human-dialogs.md#startup-approval-before-a-worker-exists). A local worker fails its no-existing-worker precondition. DA250's current immutable dialog remains pending on its original scope and conditions. Local implementation commits require a new exact commit-ID scope and its own checked receipt. Never expand or convert the old scope.

## Start repository work locally

Use `dispatch.mjs start --local` with the same repository, branch, brief, title, subject and optional base as ordinary `start`. It creates the worktree, local bootstrap commit, worker record and queued launch. It neither pushes nor opens a PR, and never consults or consumes a human dialog. Ordinary `start` keeps its existing immediate draft behavior for pots without a push gate. Choose `--local` whenever the loaded policy requires a push approval.

The watcher serves both kinds of launch from the same queue and slot limit. Each has the existing `pots.worker`, `pots.owner`, `pots.launch`, `herdr.space` and `herdr.tab` labels and exact Pi session identity. A queued worker has no terminal until a slot is free. Herdr lists the labelled terminal after it starts. No existing gateway child is converted.

## Publish a local repository worker

1. Let the worker finish and commit the contents it wants to publish. Run `node /opt/agent-sandbox/session/dispatch.mjs scope WORKER` through `with-vault`. It fetches the base and prints the exact immutable scope, full commit IDs and canonical `question` block. A dirty worktree, changed branch or origin, missing fresh base ancestry or existing remote task branch fails before approval consumption.
2. Ask the person using that returned question, with the owning pot's [human-dialog route](human-dialogs.md). Keep its scope byte-for-byte. `--for` is preserved in the returned question when the worker serves an incoming request. An unanswered or negative question authorizes nothing.
3. After the checked answer, run `node /opt/agent-sandbox/session/dispatch.mjs publish WORKER DIALOG_ID 'Push once'` through `with-vault`. It recomputes the scope, consumes that exact dialog with the existing `consumePush` contract, then rechecks the scope before the push. Changed contents require a new question. The push uses the approved full head ID and an empty expected remote ref, so it cannot include a newly made commit or replace an existing remote branch.
4. A successful push is recorded separately from watcher-owned state, then opens its draft PR. A failed or uncertain push burns the receipt. Inspect the remote and ask again before retrying a push. If only PR creation fails after the push, use `dispatch.mjs open-pr WORKER`. It verifies the recorded remote head, finds an existing open PR or creates the draft, and never pushes or consumes a receipt.

Local work, watcher events or restarts, stop, resume and `send` never call publication. Later pushes keep the loaded client's existing approval procedure. The token remains able to push independently, as the boundary above states.

## Delegate a bounded non-repository task

Use `dispatch.mjs task --title TITLE --scope SCOPE TASK_NAME WORKDIR BRIEF_FILE RESULT_FILE`. Supply an absolute existing directory, a one-line title and scope, a nonempty brief, and a new absolute result file inside that directory. Use a dedicated directory per task. `--for` and an explicitly requested `--max` work as for repository workers. The default model is the launcher's router group.

This task creates only its brief, worker record and queued launch. Its lifecycle never invokes Git or GitHub, even if the supplied directory contains a repository. Read, planning and report work stays within the stated scope and writes a nonempty regular result file. A symlink is not a result. If implementation is needed, report that need and open a new explicit repository task under the loaded approval rules. `send` preserves the recorded task kind and scope.

## Inspect, stop, resume and collect

The snapshot preserves a worker's kind and title before its terminal starts. A local repository worker has `publication: "local"` and no PR. A pushed worker awaiting a draft has `publication: "awaiting-pr"`. Neither is a collectable final result. Publication uses its own atomic record, so a concurrent watcher report cannot overwrite it. A published repository result still requires clean and pushed Git state. Task reports carry `resultFile` and `resultReady` instead of Git facts.

Both kinds retain the existing lifecycle guards. The watcher saves the exact transcript and screen only after the settled final reply, completed goals, no pending work, no open human dialog and no unread helpers. The coordinator reads those files and the task's result file when present, then acknowledges the exact result ID with `dispatch.mjs finish`. Pi rechecks its live session and completion facts before closing. An idle badge alone is insufficient.

`control.mjs stop-worker WORKER` marks and ends either kind without requiring a PR or Git. `dispatch.mjs send WORKER MESSAGE_FILE` clears the stop and queues a follow-up. The same recorded Pi session resumes when a slot is free. Automatic crash recovery remains bounded across watcher restarts. Idle Compose shutdown applies only to repository worktrees, never a task's arbitrary directory. Pots remains responsible for its workers' finish and cleanup, independently of Herdr views.

## Proof and rollout

`./bin/check` runs `probes/dispatch-branches.mjs`, `session/worker-publication.test.mjs`, `session/worker-inspection.test.mjs` and `session/worker-task.test.mjs` alongside the existing lifecycle and human-dialog suites. The dispatch probe records subprocesses for local and ordinary startup and Git-free task queuing. Publication tests create and remove disposable bare remotes, proving refusal of pending, negative, old, changed and reused receipts, an intervening commit during consumption, exact approved publication, failed push consumption and PR-only retry. Task tests cover labelled launch, retained unread output, exact acknowledgement, stop and session resume with Git and GitHub forbidden.

These checks establish source behavior. Installed Herdr visibility needs a later signed rollout and a labelled worker observed on the target pot. This change neither modifies the installed Pots package nor changes the Mac's views. The separate Herdr reset work owns Command Center removal and the installation-default views. Its cleanup must preserve Pots-owned result acknowledgement and finish. If its Pots worker rows remain, `config/mods/pots/pots-panel.js` in `agent-herdr` must render a task's scope or workdir in `workerRow` instead of the repository and branch, which are absent for tasks. The native terminal list already uses the launcher's existing labels. PR #30 also edits `session/dispatch.mjs` for factory merge landing. Reconcile that dispatch overlap when merging, without pulling its bootstrap or factory implementation into this change.
