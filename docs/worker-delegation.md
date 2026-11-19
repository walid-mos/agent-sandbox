# Visible delegated work

## Boundary before implementation

| Trusted principal | Untrusted principal |
| --- | --- |
| The owning broker checks Mastermind's registered Discord receipt against the pending scope, message, digest and configured operator, with push rollout enabled. Installed dispatcher and lifecycle code implement the supported commands. | Terminal answers, unchecked origin labels, briefs, follow-ups, neighbouring pot text, repository files, hooks, dependencies and agent-selected commands. |

The session already holds vault machine authentication and may obtain repository push credentials for its lifetime. This feature adds no credential or process isolation. Same-user agents can call Git themselves. Loaded client rules remain an instruction boundary for those commands. The guarantee here covers the supported launcher and its observers, not arbitrary code run by a credential-bearing agent.

| Channel | Mechanism and limit |
| --- | --- |
| Inherited environment, process inspection, privilege | Existing session boundary is unchanged. No new secret is passed to a worker or stored with a receipt. Same-user access is outside this feature's perimeter. |
| Sourced files, lookup paths, tool subprocesses | Commands use argument arrays, never evaluate brief or scope text. Existing trusted installation, session PATH and SSH configuration remain prerequisites. The approved push runs outside the checkout with no hooks or templates. Other checkout commands retain the session's authority. |
| Tool configuration | Publication checks the recorded repository, current task branch, origin URL, all effective push URLs, fresh base and exact full commit IDs before consuming approval. The push uses a temporary bare repository, disables system and global Git configuration and inherited Git overrides, and names the approved URL and commit explicitly. Checkout push settings and URL rewrites cannot affect it. This is not credential or process isolation. |
| Shared writable files | Worker and dialog records remain private session files. First publication must validate Discord origin, the registered request/message/digest, click evidence and the currently configured operator and enabled switch inside the same dialog lock that validates exact scope and writes single-use consumption. Generic terminal-answer consumption remains available to other broker users. Same-user file tampering is outside the perimeter. |
| Shell evaluation | Task text is written as a brief, receipts are parsed as JSON, and Git receives separate arguments. |
| Output | Reports expose scope, commit IDs and lifecycle facts, never credential values. |
| Network | Only explicit publication may push. Clone, fetch and remote inspection are reads. Existing network and vault access remain unchanged. |

The attacks to prove before publication are local start with a pending dialog, watcher inspection and restart, stop and send, changed HEAD or origin after approval, a negative answer, old bootstrap scope, duplicate consumption, and retry after a failed push. None may push or consume a receipt through local work. Non-repository launch and lifecycle inspection must invoke no Git, worktree or PR command, even inside a directory containing a repository.

The old startup contract remains at [Startup approval before a worker exists](human-dialogs.md#startup-approval-before-a-worker-exists). A local worker fails its no-existing-worker precondition. DA250's current immutable dialog remains pending on its original scope and conditions. Local implementation commits require a new exact commit-ID scope and its own checked receipt. Never expand or convert the old scope.

## Start repository work locally

Use `dispatch.mjs start --local` with the same repository, branch, brief, title, subject and optional base as ordinary `start`. It verifies that the existing checkout origin names the requested GitHub repository, then creates the worktree, local bootstrap commit, worker record and queued launch. It neither pushes nor opens a PR, and never consults or consumes a human dialog. Ordinary `start` keeps its existing immediate draft behavior for pots without a push gate. Choose `--local` whenever the loaded policy requires a push approval.

The watcher serves both kinds of launch from the same queue with [live memory admission](#worker-admission). Each has the existing `pots.worker`, `pots.owner`, `pots.launch`, `herdr.space` and `herdr.tab` labels and exact Pi session identity. A queued worker has no terminal until the watcher admits its launch. Herdr lists the labelled terminal after it starts. No existing gateway child is converted.

## Publish a local repository worker

1. Let the worker finish and commit the contents it wants to publish. Run `node /opt/agent-sandbox/session/dispatch.mjs scope WORKER` through `with-vault`. It fetches the base and prints the exact immutable scope, full commit IDs and canonical `question` block. A dirty worktree, changed branch or origin, missing fresh base ancestry or existing remote task branch fails before approval consumption.
2. Ask the person using that returned question, with the owning pot's [human-dialog route](human-dialogs.md). Keep its scope byte-for-byte. `--for` is preserved in the returned question when the worker serves an incoming request. An unanswered or negative question authorizes nothing.
3. After the checked answer, run `node /opt/agent-sandbox/session/dispatch.mjs publish WORKER DIALOG_ID 'Push once'` through `with-vault`. It recomputes the scope, then reads the checked Discord answer saved by the owning relay. Under the dialog lock, the broker checks the push policy, exact scope, registered Mastermind request and Discord message against that receipt. It checks the click against the current operator and approval switch before recording one use. A terminal answer, a stale receipt or a missing operator releases nothing. Changed local contents require a new question. The fresh base is pinned before consumption, so an unrelated base advance during consumption does not burn this receipt. The push uses the approved full head ID and URL in a temporary bare repository with an empty expected remote ref, so checkout configuration cannot redirect it, add tags, recurse into submodules, supply push options, include a newly made commit or replace an existing remote branch.
4. A successful push is recorded separately from watcher-owned state, then opens its draft PR. If the push result is uncertain or the process stops after consuming the receipt, the launcher verifies the same consumed Discord receipt under the broker lock and reads only the recorded origin URL and task branch with an isolated `git ls-remote`. It records recovery only when that read returns the exact approved commit ID. An absent, different, malformed or unreadable ref stops for operator inspection. Recovery never pushes or consumes again. If only PR creation fails after a confirmed push, use `dispatch.mjs open-pr WORKER`. For a recovered push, this checks the exact head again before opening a PR or adopting a same-repository draft with the matching base, branch and commit. For a push that reported success, this verifies the task branch still contains the recorded head. The PR step never pushes or consumes a receipt. Later branch advances remain subject to their own loaded approval rules.

Local work, watcher events or restarts, stop, resume and `send` never call publication. Later pushes keep the loaded client's approval procedure. The token remains able to push independently, as the boundary above states.

## Accor first publication

When the sandbox selects `accor-first-publication`, use ordinary `dispatch start` with `--title`. The setting also applies if `--local` is passed. The launcher records the policy on the new worker, starts at the base, and skips the empty bootstrap commit. Commit real changes locally and run the repository checks and required clean pass before requesting publication.

Use the checked Discord procedure above for the first push. The exact scope includes the full commit IDs, origin URL, branch, base and ready PR title. After the broker confirms the push, it creates a PR ready for review on that exact head. If confirmation of the push is uncertain, retry with the same consumed receipt to check the remote without pushing again. If PR creation is uncertain, `open-pr` can verify and record the matching open, ready PR. If GitHub cannot confirm it after a creation attempt, stop for inspection. Later attempts use readback only. The launcher serializes publication commands for that worker and checks the remote head before and after PR creation. GitHub creates a PR from a branch ref, so an independent writer on that ref can leave the outcome uncertain.

For later atomic commits while the Accor policy is configured, run `dispatch push WORKER` through `with-vault`. This also covers workers created before activation if their record already names the PR. The command checks the recorded URL against GitHub, verifies the repository and branch of both refs where recorded, confirms the PR is open at the remote head, then sends only a normal fast-forward push to that ref. A missing PR, closed PR or mismatch requires work center inspection. Preserve any separate repository, branch or release controls. The PR check is a snapshot before the push. Git rejects a changed advertised ref, but GitHub does not make a PR-state check and a Git push one operation.

The Accor pot's PR factory leaves these decisions to the person. A ready PR and a push receipt authorize neither merge nor deployment. Obtain a separate human decision for either action.

## Delegate a bounded non-repository task

Use `dispatch.mjs task --title TITLE --scope SCOPE TASK_NAME WORKDIR BRIEF_FILE RESULT_FILE`. Supply an absolute existing directory, a one-line title and scope, a nonempty brief, and a new absolute result file inside that directory. Use a dedicated directory per task. `--for` and an explicitly requested `--max` work as for repository workers. The default model is the launcher's router group.

This task creates only its brief, worker record and queued launch. Its lifecycle never invokes Git or GitHub, even if the supplied directory contains a repository. Read, planning and report work stays within the stated scope and writes a nonempty regular result file. A symlink is not a result. If implementation is needed, report that need and open a new explicit repository task under the loaded approval rules. `send` preserves the recorded task kind and scope.

## Inspect, stop, resume and collect

The snapshot preserves a worker's kind and title before its terminal starts. A local repository worker has `publication: "local"` and no PR. A pushed worker awaiting a draft has `publication: "awaiting-pr"`. Neither is a collectable final result. Publication uses its own atomic record, so a concurrent watcher report cannot overwrite it. A published repository result still requires clean and pushed Git state. Task reports carry `resultFile` and `resultReady` instead of Git facts.

Both kinds retain the existing lifecycle guards. The watcher saves the exact transcript and screen only after the settled final reply, completed goals, no pending work, no open human dialog and no unread helpers. The coordinator reads those files and the task's result file when present, then acknowledges the exact result ID with `dispatch.mjs finish`. Pi rechecks its live session and completion facts before closing. An idle badge alone is insufficient.

`control.mjs stop-worker WORKER` marks and ends either kind without requiring a PR or Git. `dispatch.mjs send WORKER MESSAGE_FILE` clears the stop and queues a follow-up. The watcher resumes the same recorded Pi session when it admits another launch. Automatic crash recovery remains bounded across watcher restarts. Idle Compose shutdown applies only to repository worktrees, never a task's arbitrary directory. Pots remains responsible for its workers' finish and cleanup, independently of Herdr views.

## Worker admission

The watcher reads the guest kernel before each new launch. It admits workers in queue order, and they run concurrently after startup. Producers publish requests under a shared lock, so concurrent dispatchers report `ahead` from the order each request joined. A memory pause affects only new launches. Live workers and their follow-ups continue, including follow-ups queued behind a waiting launch. `maxWorkers` adds a ceiling only when the operator sets it.

| Signal | How the watcher uses it |
| --- | --- |
| `/proc/meminfo` | `MemAvailable` is Linux's estimate of RAM available for new work without swapping. The reserve in [the admission code](../session/worker-admission.mjs) uses a share of the current `MemTotal` for large guests and a small absolute floor for the session on smaller guests. Both are policy choices for the guest as a whole. Each sample rereads both fields, including after ballooning. Missing, malformed, inconsistent or unreadable fields pause new launches. |
| `/proc/pressure/memory` | Linux [pressure stall information](https://docs.kernel.org/accounting/psi.html) reports time stalled. The policy uses the short `avg10` window and sets a lower threshold for `full` stalls, when all non-idle tasks are stalled, than for `some` stalls, when at least one is. These are initial policy choices for sustained reclaim or swap stalls. An unavailable PSI file leaves the memory headroom checks in effect. Malformed or otherwise unreadable PSI pauses new launches. |
| Cgroup v2 | The watcher resolves its worker-launch group and all ancestors visible in its cgroup namespace using `/proc/self/cgroup` and the cgroup mount in `/proc/self/mountinfo`. It checks PSI at each level and keeps the same percentage of the tighter of `memory.high` and `memory.max` free. The percentage scales to each group without applying the guest's absolute reserve to small groups. A zero-byte limit pauses admission even for an empty group. The watcher reads membership again after the last cgroup reading and retries if it changed. For a limited group, the watcher deducts inactive file cache from `memory.current` as an estimate of reclaimable memory. A missing cache count gets no credit. A disabled memory controller adds no local limit. Unreadable or invalid required inputs, cgroup v1 memory accounting, and mounts that hide namespace ancestors pause admission. |
| Swap | Swap occupancy and swap-in alone can reflect cold pages or light page-ins on an otherwise healthy guest. Admission uses the RAM and stall signals above on guests with and without swap. |

A short spacing interval after opening a worker gives its startup memory time to register. Launch timestamps preserve that spacing across watcher reloads. A worker that has yet to report an agent status holds new launches only during a bounded startup grace period. Once it reports, exits, or reaches the end of that period, the watcher checks memory before admitting another launch. While a launch is waiting, a timer rechecks admission even when hc and the queue are quiet. See [the admission code](../session/worker-admission.mjs) for the thresholds and interval.

After the authorized signed update reaches a pot, restart its `pots-watcher` service to load the policy. Remove any temporary `maxWorkers` ceiling before the restart if the operator wants memory-only admission. On each pot, confirm the watcher comes back, can read guest memory and PSI or uses the documented fallback, and preserves live terminals. Compare the watcher and hc worker processes' cgroup membership. Confirm the visible mount and parent limits cover where hc launches workers. With normal work, check queue-order starts and follow-ups. When pressure occurs during ordinary use, check that launches pause and resume while existing workers keep running.

## Proof and rollout

`./bin/check` is the source proof for this procedure, including the dispatch probe and the worker publication, inspection and task suites.

Source checks do not show installed Herdr visibility. That needs a signed rollout and a labelled worker observed on the target pot. A Pots worker row built for repository workers must show a task's scope or workdir, since a task has no repository or branch. Any cleanup of the Herdr views must keep Pots-owned result acknowledgement and finish.
