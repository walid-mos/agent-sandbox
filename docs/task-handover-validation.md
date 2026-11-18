# Task handover source validation

Protocol v2 fixes the parent's exact-conversation review finding. At `ad1c8f58a630ef44d3a04955e62caf986d2539c6`, a synthetic request lost before the first backend adoption followed by a session change reproduced an unsafe successful retry: expected exit 1, actual exit 0. The replacement flow persists a backend-issued selection before adoption, retains the versioned token on disk, and refuses both a changed session path and a changed session header without associations or terminal mutation. The v1 milestones below remain historical evidence. Final v2 factory results are recorded after its contract checkpoint is published.

This records local synthetic source validation for draft PR [#47](https://github.com/walid-mos/agent-sandbox/pull/47). It grants no rollout approval. The control and snapshot contract is in [task-handover.md](task-handover.md).

## Before and after

The before production source was `46bdc83c2978e7a045ecc47c2f6bea9f1651c25d`. The representative child-process flow called the actual `session/control.mjs task-submit` entry point and failed with its usage output because no intake operation existed. Fixture import failures were corrected before recording that meaningful red result.

The initial implementation was `2b93506c2ee724a07f18d64b7946e3f5e02672d2`. `./bin/check` passed at that commit. Stronger assertions subsequently exposed duplicate worker/task result wakes, missing launch-failure facts, invalid result text and path-alias identity loss. Each was reproduced before its fix. The executable versioned-contract checkpoint is `54edcf5eadeb627aae11417fa15e73527a96f073`. It implements protocol v1, capability discovery in `snapshot.taskContract`, required request versions and versioned replies.

At that source commit, this command passed twice consecutively, with 14 passing tests each time:

```sh
node --disable-warning=ExperimentalWarning --experimental-test-module-mocks --test probes/task-*.mjs session/task-association.test.mjs
```

The tests call actual control, dispatch, queue, worker runtime, worker inspection, worker result and shared reporting code. Each control call runs in a fresh process, with the same disposable filesystem records retained across calls. Native `flock` supplies process serialization. Herdr transport, coordinator decisions, external hc/Git/GitHub/Pots commands, and Discord bot/API calls are explicitly simulated. A loopback HTTP Discord API fixture receives the final shared task facts and is compared with the Herdr-facing snapshot. No live Discord click, Mac rendering, model judgment, paid provider, real execution adoption or client repository is involved.

## Observable requirements

| Added test | Requirement checked |
| --- | --- |
| versioned control refuses absent or incompatible versions before intake | Unsupported envelopes create no receipt, while v1 discovery and replies agree |
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

Removing the worker task projection made both association tests fail before it was restored. The stricter one-result assertion failed with `2 !== 1` before task workers switched to the shared reporting wake. The launch-failure assertion failed with `attention-needed` instead of `not started` before its cause was retained. Both malformed-summary probes returned success before shared text validation was applied. The alias probe returned `attention-needed` immediately after adoption before published and canonical paths were pinned separately. The version probe returned success for a request with no version before protocol validation was added.

## Measured effort and repeat runs

Initial authoring wall time was measured from the filesystem creation time of the first boundary fixture, `2026-11-17T23:26:29.878Z`, to the first implementation commit preparation at `23:46:01.138Z`: 1,171,259 ms, or 19 minutes 31 seconds. This includes initial fixture authoring and red/green work. It excludes the later corrective work and clean-pass attempt. It is elapsed authoring time, not a claim of uninterrupted hands-on effort or a production performance estimate.

The two runs at the versioned checkpoint took 7,920.70 ms and 7,889.09 ms for the complete 14-test command. Representative diagnostics below use milliseconds. Setup measures disposable root/bot/boundary creation. Execution includes scenario fixture preparation and actual internal entry-point calls. Cleanup measures ownership verification and filesystem removal. The Discord fixture separately closes its owned HTTP server through its test cleanup hook, outside that filesystem-only cleanup metric.

| Flow | Run | Setup | Execution | Filesystem cleanup |
| --- | --- | ---: | ---: | ---: |
| Intake and acceptance | 1 | 0.60 | 457.06 | 0.59 |
| Intake and acceptance | 2 | 0.60 | 392.90 | 0.60 |
| Existing execution adoption and result | 1 | 0.55 | 1365.84 | 1.52 |
| Existing execution adoption and result | 2 | 0.57 | 1335.03 | 1.52 |
| New worker and lifecycle result | 1 | 0.63 | 1361.78 | 2.03 |
| New worker and lifecycle result | 2 | 0.55 | 1361.08 | 1.94 |

Fixtures record a worktree/run identity, an ownership marker and an external ownership registry. The HTTP fixture binds port zero on loopback and records the assigned endpoint. Test hooks remove fixture files and close the server after success or failure. There is no heavy benchmark or cost estimate.

## Checks and release blockers

`./bin/check` covers syntax, sandbox configuration, worker lifecycle and delivery, human-dialog and approval security, dispatch validation, the task probes, private-rule activation probes and whitespace. The task work introduced one fixture-compatibility regression because its sandbox stub lacked `botHome`. That stub was corrected, and the full check passed. The full check also passed on the source tree committed as the v1 checkpoint, covering 166 JavaScript tests, 22 Python tests, dispatch and configuration checks. The already-pushed empty startup commit follows the applicable Conventional Commit format. This repository has no package manifest, dependency-install step, active commit hook or commitlint configuration.

The earlier missing-host-tool report did not establish a factory blocker. The parent identified the preexisting `agent-sandbox-factory:e359043d8f19` image, and all required factory gates subsequently passed on an isolated export of exact head `44ddbde83fbd8fd0dd46da1525b8425a606b31b0` against frozen base `6d71925e5467b58e7a935498c5a271cf5a9c059b`.

### Actual factory image run

Run identity: `herdr-factory-44ddbde-a72e9c`. Docker client and engine were both 29.9.3. The image ID was `sha256:5c3f42c3b6351363774408dd972af58d7a2b6a134f938b43f1bee0a9f6388184`, running as its configured `node` user. The exact exported Dockerfile hashed to `e359043d8f19f8d1dfc26039a7d5bf8ef32c3617273073ccebc400db7b8eb4ba`, matching the existing tag. Image tools reported Node 24.22.3, ShellCheck 0.9.0 and Fallow 3.43.1.

Source and base history traveled in a local Git bundle. The container checked out the exact head, verified the merge base and removed the bundle remote. Factory scripts were exported from that same source commit. Containers mounted only the disposable workspace at `/work` and those scripts read-only at `/factory`. Each used `--network none --cap-drop ALL --security-opt no-new-privileges --pids-limit 2048 --memory 6g`, a fresh HOME under `/work`, and `CI=true`. No credential environment, live checkout, session home or Docker socket was mounted. The image was neither built nor installed.

| Actual container command | Exit | Observed result | Retained log |
| --- | ---: | --- | --- |
| `sh /factory/attacks.sh` | 0 | All eight credential/process/home/socket/privilege/write/network attacks closed | `probe.log` |
| `./bin/check` | 0 | 166 JavaScript tests, 22 Python tests, dispatch, syntax, configuration and whitespace checks passed | `check.log` |
| `node /factory/shellcheck-new.mjs 6d71925e5467b58e7a935498c5a271cf5a9c059b` | 0 | One changed shell file, zero new findings | `shellcheck.log` |
| `fallow audit --base 6d71925e5467b58e7a935498c5a271cf5a9c059b` | 0 | Audit passed over 27 changed files, with warnings recorded below | `fallow.log` |

Logs, tool versions, exact container IDs, exit evidence and cleanup records are retained under `/config/reports/herdr-factory-44ddbde-a72e9c/`. `export.log` records image tool versions. `ownership.json` identifies all resources. Each `STEP.inspect.json` records the container image, state, isolation settings and mounts.

Fallow reported zero dead code, 35 complexity warnings and three test clone groups covering 39 duplicated lines in `probes/task-handover.mjs`. Its maximum cyclomatic complexity was 14. It excluded 12 inherited findings from the audit gate. The complexity risk scores are static estimates because no coverage file was provided. Its separate absent-`node_modules` warning limits dependency classification. This repository has no package manifest or dependency-install step, and no dependencies were installed. These diagnostics did not reproduce a behavioral regression, and no source change or warning suppression was made. The lifecycle close-deferred diagnostics in `check.log` also occurred in prior passing runs and come from existing inspection-failure tests.

Cleanup was registered before provisioning. It verified the run marker, exact container IDs, run labels, image identity and disabled network before removal. All five owned containers, including the export container, were removed and inspected as absent. The disposable source, Git objects, homes, worktree and factory-script copies were removed. `ownership.json` records `workspaceRemoved: true` and `cleanupComplete: true`. Only the evidence directory remains. No new test, benchmark or Claude pass was run beyond these required gates.

The earlier clean-pass attempt hit Claude's weekly quota before producing an untangle report, branch or question. Its owned terminal was stopped and removed, and review and simplify were not started. At 00:57 UTC on 18 November, the person explicitly waived Claude reviews tonight for the pending PRs. These passes are waived, not completed, and no replacement review or retry was run. The waiver grants no readiness, merge or activation approval.

Keep the PR draft for parent design review and the 05:00 UTC 18 November freeze. Before activation, release that hold, accept the corrected source and non-Claude gates, approve the paired Herdr v2 UI work, satisfy the remaining native-proof requirements, and use the normal reviewed signed rollout. The remote main branch was verified at `6d71925e5467b58e7a935498c5a271cf5a9c059b` and was never written by this task. No signing, feature installation, live launch/adoption, service restart or credential change occurred.
