# Task handover source validation

This records local synthetic source validation for draft PR [#47](https://github.com/walid-mos/agent-sandbox/pull/47). It grants no rollout approval. The control and snapshot contract is in [task-handover.md](task-handover.md).

## Before and after

The before production source was `46bdc83c2978e7a045ecc47c2f6bea9f1651c25d`. The representative child-process flow called the actual `session/control.mjs task-submit` entry point and failed with its usage output because no intake operation existed. Fixture import failures were corrected before recording that meaningful red result.

The initial implementation was `2b93506c2ee724a07f18d64b7946e3f5e02672d2`. `./bin/check` passed at that commit. Stronger assertions subsequently exposed duplicate worker/task result wakes, missing launch-failure facts, invalid result text and path-alias identity loss. Each was reproduced before its fix. The final executable source is `41586757a22ce6abbe45965a1f42d29efc33fa77`.

At that source commit, this command passed twice consecutively, with 13 passing tests each time:

```sh
node --disable-warning=ExperimentalWarning --experimental-test-module-mocks --test probes/task-*.mjs session/task-association.test.mjs
```

The tests call actual control, dispatch, queue, worker runtime, worker inspection, worker result and shared reporting code. Each control call runs in a fresh process, with the same disposable filesystem records retained across calls. Native `flock` supplies process serialization. Herdr transport, coordinator decisions, external hc/Git/GitHub/Pots commands, and Discord bot/API calls are explicitly simulated. A loopback HTTP Discord API fixture receives the final shared task facts and is compared with the Herdr-facing snapshot. No live Discord click, Mac rendering, model judgment, paid provider, real execution adoption or client repository is involved.

## Observable requirements

| Added test | Requirement checked |
| --- | --- |
| simultaneous deliveries keep one durable intake and one bot receipt | Four concurrent control processes retain one task and one deduplicated receipt |
| Herdr intake reaches one bot receipt and explicit acceptance across lost replies and restart | Unknown delivery remains separate from pending acceptance, and a retry preserves provenance and identity |
| adoption preserves the exact Mac-parented conversation and one final result through restart | Exact execution and parent survive adoption, transcript bytes are retained, one outcome reaches both views and survives disappearance |
| an uncertain adopted follow-up stays visible and cannot trigger a replacement after disappearance | One attempted send stays unknown until explicit inspection, with no second send or replacement |
| a new accepted task uses one existing dispatch queue worker and one lifecycle result after restart | Repeated starts and watcher steps use one worker, one queue launch and one saved result report |
| failed task launch reports its task identity and reason through the shared report only | Failure state and cause remain visible under the same task ID without duplicate bot reports |
| adoption resolves local aliases while pinning published execution metadata | Valid local aliases match, and changing an alias target invalidates that execution |
| task text and claimed author stay literal and cannot grant approval or launch | Shell-like text remains data, claims grant no approval, and a rejection cannot be overwritten |
| changed identity, wrong pot, approval fields and ambiguous adoption are refused without execution | Conflicting payloads, cross-pot routes, extra approval fields, unsafe paths and ambiguous matches create no execution |
| adopted result refuses NUL before saving an outcome | Result text uses the intake text-validation contract |
| adopted result refuses UTF-8 byte overflow before saving an outcome | Byte limits apply to Unicode summaries before result persistence |
| a stale watcher save cannot erase the single worker task association | Mutable worker JSON cannot erase the separate association |
| a worker cannot overwrite its original task association | A second task identity cannot replace the first association |

Removing the worker task projection made both association tests fail before it was restored. The stricter one-result assertion failed with `2 !== 1` before task workers switched to the shared reporting wake. The launch-failure assertion failed with `attention-needed` instead of `not started` before its cause was retained. Both malformed-summary probes returned success before shared text validation was applied. The alias probe returned `attention-needed` immediately after adoption before published and canonical paths were pinned separately.

## Measured effort and repeat runs

Initial authoring wall time was measured from the filesystem creation time of the first boundary fixture, `2026-11-17T23:26:29.878Z`, to the first implementation commit preparation at `23:46:01.138Z`: 1,171,259 ms, or 19 minutes 31 seconds. This includes initial fixture authoring and red/green work. It excludes the later corrective work and clean-pass attempt. It is elapsed authoring time, not a claim of uninterrupted hands-on effort or a production performance estimate.

The two runs at the final executable source took 7,180.54 ms and 7,149.86 ms for the complete 13-test command. Representative diagnostics below use milliseconds. Setup measures disposable root/bot/boundary creation. Execution includes scenario fixture preparation and actual internal entry-point calls. Cleanup measures ownership verification and filesystem removal. The Discord fixture separately closes its owned HTTP server through its test cleanup hook, outside that filesystem-only cleanup metric.

| Flow | Run | Setup | Execution | Filesystem cleanup |
| --- | --- | ---: | ---: | ---: |
| Intake and acceptance | 1 | 0.60 | 394.08 | 0.59 |
| Intake and acceptance | 2 | 0.62 | 405.68 | 0.59 |
| Existing execution adoption and result | 1 | 0.56 | 1305.46 | 1.75 |
| Existing execution adoption and result | 2 | 0.92 | 1265.13 | 1.59 |
| New worker and lifecycle result | 1 | 0.65 | 1309.74 | 1.87 |
| New worker and lifecycle result | 2 | 0.55 | 1321.74 | 1.85 |

Fixtures record a worktree/run identity, an ownership marker and an external ownership registry. The HTTP fixture binds port zero on loopback and records the assigned endpoint. Test hooks remove fixture files and close the server after success or failure. There is no heavy benchmark or cost estimate.

## Checks and release blockers

`./bin/check` covers syntax, sandbox configuration, worker lifecycle and delivery, human-dialog and approval security, dispatch validation, the task probes, private-rule activation probes and whitespace. The task work introduced one fixture-compatibility regression because its sandbox stub lacked `botHome`. That stub was corrected, and the full check passed. The already-pushed empty startup commit follows the applicable Conventional Commit format. This repository has no package manifest, dependency-install step, active commit hook or commitlint configuration.

Local `shellcheck --severity=warning bin/check` and `fallow audit --base 6d71925e5467b58e7a935498c5a271cf5a9c059b` could not run because those executables are absent. No installation was attempted under the rollout hold.

The required clean pass was attempted through the installed `session/clean-pass.mjs untangle` command after the initial committed source passed its checks. Claude Code reported its weekly limit, resetting November 21 at 12:00 UTC. It produced no untangle report, branch or question. The owned pass terminal was stopped and removed. Review and simplify were not started because the same account remained unavailable. The clean pass is incomplete and must run on the final source once quota permits. No alternate credential or paid fallback was used.

Keep the PR draft for parent design review and the 05:00 UTC 18 November freeze. Before activation, release that hold, complete the clean pass and missing factory checks, approve the paired Herdr UI work, and use the normal reviewed signed rollout. The remote main branch was verified at `6d71925e5467b58e7a935498c5a271cf5a9c059b` and was never written by this task. No signing, feature installation, live launch/adoption, service restart or credential change occurred.
