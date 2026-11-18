# Rules-only trust boundary

The trusted principal is the operator invoking reviewed runner resources against compatible public source and the existing signed root launcher. The untrusted side is private recipe content, private repository files and Git metadata, and configuration input. The GitHub CLI's existing authentication is used for the repository-privacy read. The runner does not obtain, export or print credential values.

| Channel | Constraint and evidence |
| --- | --- |
| Inherited environment | Child commands receive a constructed environment. The synthetic startup and inherited-Git attack test proves caller overrides do not enable hooks or shell startup files. |
| Sourced files | Transport shell text is fixed. Only hash-pinned public transport source is sourced. Private source files are parsed as bytes or JSON. |
| Process inspection | Private source code never executes. Same-user or root processes already running on the operator host are outside this boundary. The continuing owner hold coordinates those writers. |
| Privilege | The runner creates no credential or sudo rule. Root transfer uses the existing trusted launcher, which verifies its clone before running the pinned store implementation. |
| Trusted tool configuration | Local Git keys are checked against the pinned safe-key policy before repository operations. Global and system Git config are disabled. Hook and filter attack tests cover execution-bearing configuration. |
| Tool subprocesses | The runner invokes only named Git operations, a repository-privacy read, the pinned transport and read-only collectors. Private hooks are disabled. It never runs a private source installer or script. |
| Shared writable storage | Journal creation requires a private parent, exclusive ownership marker and absent destinations. Backups and state files use exclusive creation and owner-only access. Snapshot permissions follow the pinned importer. |
| Shell evaluation of input | Paths travel as command arguments. Recipes, contracts, holds and bundles are parsed as JSON. No private input is interpolated into shell code. |
| Lookup paths | Child command lookup uses a fixed operator tool path. Python loads checked source bytes for the recipe and bundle modules without accepting cached bytecode. The installed operator tools themselves remain trusted. |
| Output | Captured subprocess diagnostics are withheld on success and failure. Public-runner tests check that original/result rule bytes do not occur in output. Reports contain only selected proof fields. |
| Network | Production performs only the explicit privacy read and existing Accor transport required by the future reviewed scope. Fixture execution denies socket operations in the runner, admits only local Git and the pinned store child, and records those launches for assertions. |

The runner proves compatible files on both machines, installed launcher ownership, trusted VM signature validation and exact source revision before transfer. It checks unrelated VM configuration bytes and optional membership before and after transfer. The compatibility and bundle-drift tests exercise the same public runner with synthetic files. They do not establish an actual Mac or VM stage proof.

The journal is append-only by convention and private to the owner. It is not tamper-proof against that owner or root. Advisory locking and repeated observations cannot prevent an arbitrary same-user process from changing a file between observations. An owner who cannot maintain the hold must not authorize execution. No automatic recovery or source update expands this boundary after a refusal.

Read-only checks are bounded, including the aggregate preflight. Mutation calls are not killed by a window timer. Failure, interruption or expiry can leave canonical files, pending approval, a local commit, or a partially delivered bundle. The owner reconciles that state through [the read-only inspection route](README.md#failure-and-reconciliation) before any separately reviewed recovery action.
