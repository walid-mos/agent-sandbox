# Factory landing: implemented

Walid approved this design on 2026-11-17 16:18 UTC with the defaults below, and this branch implements the smallest path. Nothing is deployed until he signs and pushes a release: the signer, the isolated factory and the trust files then reach a pot at its next `vm-up`.

**What Walid gets.** Changes the factory approves for agent-sandbox land on the pots without him. He stops re-signing `main` by hand, as he did on 2026-11-17 with `81d5895`.

**What it costs.** One new signing key, held by root in a pot's VM, outside the worker session. Automation, not Walid, then decides what runs as root on every pot. The Factory bot leaves the worker session first, because a worker could otherwise obtain a signature.

**What he does once.** Sign and push the release that implements this, then run [his one-time steps](#walids-one-time-steps): seed the factory's model router, create the key in the VM, export its public half, install trust with `vm-up` on every pot.

**GitHub.** Adding the key on GitHub is not needed. It changes a badge, not what a pot accepts.

The three defaults he approved with it: the Mac keeps trusting his key only, so factory trust reaches the VMs alone through a second file; root creates the factory key inside the signing pot's VM; key expiry, operator-only control files and the stricter controls of the [fuller design](#fuller-design-authority-boundary) come in a second step. Pi and Herdr stay outside this trust until their provisioner checks signatures. The document keeps option D as the alternative if he ever wants his own signature on each release.

## Does adding the key on GitHub do it?

No. These are facts, read on 2026-11-17.

- **Where a key goes.** GitHub registers a GPG key on a user account only: **Settings**, then **SSH and GPG keys**, then **New GPG key**, or `gh gpg-key add FILE` ([adding a GPG key](https://docs.github.com/en/authentication/managing-commit-signature-verification/adding-a-gpg-key-to-your-github-account)). Its [GPG key API](https://docs.github.com/en/rest/users/gpg-keys) has account endpoints only. GitHub documents no GPG key for an organization or a repository.
- **What it does.** GitHub then shows "Verified" on a commit that key signed, when the committer email is one of the key's identities and a verified email of that account ([verified email rule](https://docs.github.com/en/authentication/troubleshooting-commit-signature-verification/using-a-verified-email-address-in-your-gpg-key)).
- **What it does not do.** It does not change who signs a merge that GitHub makes. Every squash merge on `main` after `6c5bd95` (`d740f12`, `316405a`, `4ef5ef0`, `03babcf`) is committed by GitHub and signed with GitHub's web-flow key `B5690EEEBB952194`.
- **What a pot reads.** The [commit verifier](../lib/signed_commit.py) checks the tip with `gpgv` against a local file of public keys. It never asks GitHub, so a badge changes nothing for it.
- **Rules on `main`.** None. A token with admin rights on `walid-mos/agent-sandbox` gets an empty ruleset list, no rule that applies to `main`, no classic branch protection, and zero rulesets and protection rules through GraphQL.

The proposed design therefore does not need the GitHub step. A pot accepts a factory-signed commit once the factory's public key is in the file its launcher reads.

Two cases would call for it later. A "Require signed commits" rule on `main` makes GitHub refuse a pushed commit it cannot verify ([protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-signed-commits)), so the factory's landing commit would need a registered key. Walid may also want the badge. In both cases, register the key on a dedicated machine account. On his own account, the key's email would have to be one of his verified emails, and the factory's commits would show as his.

## What exists and what is missing

| Need | State today |
| --- | --- |
| Verify a signed tip | Exists. The [launcher](../lib/trusted_source.py) checks the clone's HEAD before each root run, and the [Mac updater](../mac/update) checks each fetched tip. |
| Send trust to a VM | Exists. [`vm-trust`](../bin/vm-trust) copies the Mac's `~/.config/agent-sandbox/trusted-signers.asc` to the VM's `/etc/agent-sandbox/trusted-signers.asc` at each `vm-up`, and refuses private key material. A running VM gets a changed file only when `vm-up` runs. |
| Keep a secret from the session | Exists as a pattern. The [vault broker](../vm/vault-broker) is a root service started through the launcher. Its identity sits in a root-only file outside every session mount, it answers fixed request kinds on a socket, and [attacks from the session](../probes/vault-attacks.sh) check it. |
| Sign a commit | Exists in this branch. [`vm/landing-signer`](../vm/landing-signer) runs as VM root through the launcher, holds the key, builds the landing commit itself and signs it. |
| A factory decision a worker cannot fake | Exists in this branch. VM root starts the factory in [its own container](../vm/factory-runtime) from the clone's revision, and the signer answers only a caller holding a token written into a directory no session mount names. |
| Limit what a trusted key may do | Missing, deferred to the second step. Any key in the signers file keeps the operator's full authority over the clone, and the Mac still reads the operator file alone. |

## Implementation boundary

| Trusted principals | Untrusted principals |
| --- | --- |
| VM root holds the signing key until rotation and starts the signer from the trusted clone. | The worker session, its processes and files, PR contents and check containers. |
| The isolated factory owns its toolchain, model runtime, bot home, checks and verdict records. It holds the existing GitHub and provider credentials while running. | Session wakes, PASS files, GitHub comments and claimed actor names cannot authorize signatures. |
| The Mac operator installs public trust through the provider connection and keeps the operator key on the Mac. | Pot messages are not an authenticated public-key delivery channel. |

| Channel | Required closing mechanism |
| --- | --- |
| Environment and sourced files | Fixed signer environment and root-owned configuration. Independent factory home with no session startup files. |
| Process inspection | The signer answers only a caller holding the token VM root writes into the socket's directory, which only the factory container mounts. VM root stays trusted. |
| Privilege | Neither container mounts the VM Docker socket or signing key. The factory uses its own inner check engine. |
| Tool configuration and subprocesses | Separate installed toolchain. Candidate code runs only in credential-free check containers. Signing uses a private bare store and never checks out candidate code. |
| Shared writable paths | Separate factory home and inner Docker volume. No session cache, runtime, bot directory or symlink is adopted. |
| Shell evaluation | Bounded parsed JSON and validated object IDs. The signer constructs the only permitted commit itself. |
| Lookup paths | Fixed tools and private HOME. No caller Git, GPG, Python or shell configuration. |
| Output | Public fingerprints, release objects and bounded errors only. No private keys or credential values. |
| Network | Separate Docker bridge and private signer socket bound only into the factory. No published management listener. |

Compromise of the approving automation remains delegated root-code authority. VM root and the trusted runtime remain trusted.

## Smallest path (implemented)

Four pieces close the missing rows. The verifier, the launcher and the Mac updater stay unchanged.

1. **Custody.** Root creates the private key inside the VM of the pot whose factory merges agent-sandbox. It stays in a root-only directory outside every session mount, beside the vault identity. It never leaves that VM. No agent, session or Mac holds it, and a second signing pot gets its own key.
2. **Signer.** A root service holds the key, started through the launcher like the vault broker. It builds the landing commit itself: empty, one parent, a fixed message naming the pull request and its head. It signs only when that parent is a single commit sitting directly on the last tip a trusted key signed. It answers that one request on a socket bound into the factory's container alone.
3. **Factory outside the worker session.** The Factory bot runs in its own container, which root starts from the trusted clone. No worker runs there, and it accepts no message from the worker session. It reports to Principal one way.
4. **Publication.** After its squash merge, the factory asks the signer for the landing commit and pushes it to `main` with an ordinary push. This needs no new GitHub credential and no GitHub setting.

The Mac keeps trusting Walid's key only. The factory's public key reaches the VMs through a second file, which `vm-trust` adds to each VM's signers file. No pot can then change code the Mac runs, as today. The Mac checkout catches up at Walid's next signed commit.

What this path does not do:

- The factory's judge is automation and can approve a bad change. That change then runs as root on every pot. This is the authority Walid delegates.
- Root of the signing VM can sign anything. One compromised signing VM therefore reaches every pot that trusts its key, though not the Mac.
- A merge the factory did not make stops landing until Walid signs a tip, as today. Workers keep GitHub credentials that can merge.
- It adds no expiry and no limit by path. The [fuller design](#fuller-design-authority-boundary) adds both, and they can follow in a second step.
- Pi and Herdr are not covered. Their [provisioner](../lib/agent_sources.py) checks no signature.

Source changes, all implemented:

| Where | Change |
| --- | --- |
| [`session/launch.env`](../session/launch.env) | Names the key home, the landing state, the signer socket, and the isolated factory's container, volumes, network, state and report socket. |
| [`vm/landing.py`](../vm/landing.py), [`vm/landing-signer`](../vm/landing-signer), [`vm/pots-landing.service`](../vm/pots-landing.service) | The root signer: policy, the one commit it builds, and its receipt. |
| [`vm/factory_root.py`](../vm/factory_root.py) | The fixed environment, Git options, GnuPG calls and private directories the VM-root factory services share. |
| [`lib/factory_socket.py`](../lib/factory_socket.py) | The token-checked socket the signer and the report service serve, and [`session/factory-channel`](../session/factory-channel) calls. |
| [`vm/landing-key`](../vm/landing-key), [`bin/landing-key`](../bin/landing-key) | Creates and exports the key as VM root, from the Mac. |
| [`vm/factory-runtime`](../vm/factory-runtime), [`vm/pots-factory.service`](../vm/pots-factory.service), [`vm/factory-seed`](../vm/factory-seed), [`vm/factory-reports`](../vm/factory-reports), [`vm/pots-factory-reports.service`](../vm/pots-factory-reports.service) | The isolated factory's container, its operator seed, and its one-way reports to Principal. |
| [`session/factory-runtime/`](../session/factory-runtime) | The container's image and entrypoint: its own toolchain, home, router, gateway and inner Docker. |
| [`bin/factory-bootstrap`](../bin/factory-bootstrap) | Seals a router seed on the Mac and installs it outside the session. |
| [`vm/setup.sh`](../vm/setup.sh) | Installs GnuPG and the three services with the other units. |
| [`bin/vm-trust`](../bin/vm-trust) | Builds the VM's signers file from the operator file plus `factory-signers.asc`. The Mac updater keeps reading the operator file alone. |
| [`session/factory-channel`](../session/factory-channel), [`session/factory-publication.mjs`](../session/factory-publication.mjs), [`session/factory-mirror.mjs`](../session/factory-mirror.mjs) | After the squash merge, ask the signer, check the object's identity, push it without force and reconcile the tip. Merged, signed and published stay three facts. |
| [`session/factory-authority.mjs`](../session/factory-authority.mjs), [`session/factory-scan.mjs`](../session/factory-scan.mjs), [`session/factory-verdict.mjs`](../session/factory-verdict.mjs), [`session/factory-bot.mjs`](../session/factory-bot.mjs) | The signing pot's session factory stops, and host-code publication needs the signer socket. |
| [`bin/render-config`](../bin/render-config) | Refuses a session bind that would reach the key home, the landing state, a factory state or either socket. |
| [`probes/landing-policy.py`](../probes/landing-policy.py), [`probes/landing-attacks.sh`](../probes/landing-attacks.sh), [`bin/probe-boundary`](../bin/probe-boundary), [`session/factory-repositories.json`](../session/factory-repositories.json) | Disposable-key policy tests as the repository's `landing` check step, plus the session and VM attack probes in `probe-boundary`. |
| [`lib/signed_commit.py`](../lib/signed_commit.py), [`lib/trusted_source.py`](../lib/trusted_source.py), [`mac/update`](../mac/update) | No change. |

Walid does the [steps below](#walids-one-time-steps) once. No agent creates, moves or reads the real key.

## How the public key reaches Walid

A public key is not secret. The risk is a swap: a compromised pot or a forged message hands him a key whose private half an attacker holds.

| Way | Private key | What he must trust | Verdict |
| --- | --- | --- | --- |
| Created on the Mac, private half carried into the VM | Exists on the Mac, then travels | Nothing inbound. The carried secret and the copy left on the Mac are the weak points. | Second choice |
| Created by root in the VM, read from the Mac | Never leaves the VM | The Mac's own connection to VM root, which `vm-up` already uses to install trust. The session cannot answer on it. | Recommended |
| Key or fingerprint taken from Discord, a pull request, a pot's message or GitHub | Unknown | A channel a pot or a forger can write to | Refuse |

Recommend the second. No secret ever moves, and the public key arrives over the channel that already carries every trust file. A VM root that lied about the key would already own the key, so this adds no new party to trust. The fingerprint Walid reads there is his reference afterwards. Any message that names another one is wrong, and the landing check in step 6 must print the same one.

## Walid's one-time steps

Every command runs on the Mac, in his agent-sandbox checkout. `NAME` is the signing pot's name, the pot whose bot `POTS_SIGNING_FACTORY_BOT` names in [`session/launch.env`](../session/launch.env). Every command below exists in this branch.

1. Review this pull request. Sign and push its release to `main` himself, as he does today, then run `SANDBOX=NAME ./bin/vm-up` once for each pot. That installs the three services. The signer starts and holds no key; the isolated factory prints that it is waiting and its unit retries it every minute.
2. Create the key in the signing pot's VM: `SANDBOX=NAME ./bin/landing-key create`. It prints the 40-character fingerprint. Note it.
3. Export the public half: `SANDBOX=NAME ./bin/landing-key export > ~/.config/agent-sandbox/factory-signers.asc`.
4. Check it. `gpg --show-keys --with-fingerprint ~/.config/agent-sandbox/factory-signers.asc` shows one key with that fingerprint, and `python3 -I lib/signed_commit.py signers ~/.config/agent-sandbox/factory-signers.asc` answers that it holds public keys only.
5. Seed the isolated factory's model router: `SANDBOX=NAME ./bin/factory-bootstrap`. It seals a router seed without keys, without the library and without sign-ins, and installs it outside the session. Running it twice is refused, so a rotation needs its own reviewed step.
6. Install trust on every pot: `SANDBOX=NAME ./bin/vm-up`, once per pot. Each run copies the operator file plus `factory-signers.asc` into that VM's `/etc/agent-sandbox/trusted-signers.asc`, restarts the signer and lets the factory start. A pot that was off gets them at its next `vm-up`.
7. From this point the signing pot's session factory stops: its scan prints that the factory runs outside the worker session, and the isolated container scans the same owners. After the factory's next merge, confirm the landing. `SANDBOX=NAME ./bin/vm-exec sudo python3 -I /usr/local/lib/agent-sandbox/lib/trusted_source.py verify` prints the fingerprint that signed the commit the VM runs, which must be the one from step 2. `SANDBOX=NAME ./bin/vm-exec sudo git -C /opt/agent-sandbox rev-parse HEAD` must print the commit that `git ls-remote origin refs/heads/main` prints.

There is nothing to do on GitHub. To stop trusting the factory, he signs a tip himself, deletes `factory-signers.asc` and runs `vm-up` for each pot. The launcher then refuses a tip that only the factory signed, and removing a tip the factory already landed on a pot that has not updated yet needs his own signed commit on top.

## What was checked

[`probes/landing-policy.py`](../probes/landing-policy.py) passes seven cases with disposable keys created inside the test: the valid job produces one commit whose only parent is the squash and whose diff is empty, signed by the factory key and naming the checked head; a caller cannot choose the tree, the message, the payload, the parents, the origin or a command; an untrusted parent is not promoted; a moved main or a changed head is not substituted; a squash whose tree differs from the checked head is refused; a repeated request returns the identical object after a restart; and an older trusted parent cannot replace the last signed release. The repository's `landing` check step runs it, and [`bin/probe-boundary`](../bin/probe-boundary) runs [`probes/landing-attacks.sh`](../probes/landing-attacks.sh) inside the session as its user and as its root, then through the launcher on the VM: the key home, the landing state, the factory state, the sockets and the token are absent from the session, `sudo` gives it no root, and a caller with no token is refused.

The installed [commit verifier](../lib/signed_commit.py) requires an OpenPGP signature on the tip commit and checks it with `gpgv`. SSH signatures are refused. Its first valid signer has unrestricted authority over the guarded clone. It has no repository, branch, path or signer-role policy. Adding a factory public key to its current signers file would grant that unrestricted authority.

Read-only inspection found only the mac-studio key `700F307CDDE44D8462B6D1CF014DBB46BDA39DA0` in this VM's public signers file. After the operator-signed `6c5bd95`, `main` took four GitHub-signed squash merges: PR #22 at `d740f12`, PR #26 at `316405a`, PR #25 at `4ef5ef0` and PR #31 at `03babcf`. This pot ran none of them until Walid signed the empty commit `81d5895` on top, which it now runs. This session did not inspect the other pot.

The [factory](../session/factory-github.mjs) uses `gh pr merge --squash --match-head-commit`. Its bot, [verdict records](../session/factory-records.mjs), GitHub credentials and workers share the session user. [Checks](../session/factory-checks.mjs) run in credential-free containers. Neither a session record nor a PR comment proves that the factory, rather than another process with that user's access, approved a release.

The [VM trust installer](../bin/vm-trust) copies public trust and the installed launcher at `vm-up`. The [Mac updater](../mac/update) reads its local public-key file. Their polling does not copy trust files. The Mac watchdog reruns `vm-up` only for a stopped Colima VM, so a running VM keeps its trust file until `vm-up` runs. Agent-sandbox has no rule on `main`, as the GitHub answer above details. Existing settings remain fixed inputs, and no design step may bypass or weaken a rule that applies when implemented.

## Fuller design: authority boundary

The sections from here on describe the stricter form, kept from the previous revision. The smallest path takes two rules from it: no worker reaches the signer, and only the exact checked release is signed. The time-limited grant, the operator-only control files, the key per repository, the separate GitHub App credential and the Mac's own factory trust are hardening for a second step.

Recommend a dedicated factory key signing a final landing commit after a controlled GitHub squash merge. Move the existing factory authority out of the worker session before giving it this power. There remains one factory bot, with its fresh judge per head. Its controller, installed code and authorization records live under separate VM service accounts outside session mounts. A small deterministic signer runs under another account. It is not another bot and accepts no session-accessible signing requests.

Merely putting a key in a mode-0600 session file, using a hardware token with an unrestricted socket, or putting a signer behind a password known to the session does not isolate it. Under any of those designs, every agent and dependency running as the session user could ship root code to every trusting VM. The recommendation prevents that direct access through separate users, process isolation, private sockets, private state and no shared writable mounts. It does not prevent an intentionally submitted malicious PR from passing the automated checks and judgment. That decision is the authority Walid delegates.

| Trusted principals | Untrusted principals |
| --- | --- |
| Walid holds the operator signing key and approves trust grants and bootstrap releases. VM root installs the isolated services and public policy. | Workers, arbitrary pot-session processes, repositories, dependencies, hooks, PR text and check output. They retain the session credentials and reach described in the README. |
| The isolated factory controller selects jobs, owns check results and authorizes a particular release. The deterministic signer holds a new factory key. | Session verdict files, GitHub comments and statuses written with session credentials, claimed wake origins and user-supplied commit metadata. |
| Installed VM and Mac verifiers enforce the operator-issued grant and commit chain. | Fetched Git objects and public GitHub metadata until checked against the grant and the controller's own job. |

The new factory key is an OpenPGP Ed25519 signing key, which the installed GPG stack already supports for Walid's existing key. Use a separate key for each authorized repository to limit a single-key leak. Start with agent-sandbox. Add Pi and Herdr only with their own grants and receiving verifiers. SSH or S/MIME would require another signature parser and offer no simpler authorization boundary here. No Mac key, secret subkey or forwarded GPG socket is copied or reused.

The private factory key stays in the isolated signer's private home on the always-on pot VM. VM root and the host administrator remain trusted and can extract a software key. A dedicated device could reduce extraction risk later, but cannot prevent misuse by an authorized controller. A separate GitHub App credential, held only outside the session, identifies factory publication. Scope its installation to selected repositories, give it only required contents, PR and check-read permissions, and mint short-lived installation tokens. Its private App key and factory key last until rotation or revocation. Installation tokens normally last one hour. Model-provider credentials reach only the isolated judge service, never checked code or signer processes.

The fresh judge runs separately from credential-bearing control processes with fixed read-only review tools. It returns a structured verdict for one job. It has no shell, signing socket, controller state write access or GitHub publication credential. Only the deterministic controller can advance the job after its independently collected checks pass. The bot still runs the versioned factory policy from an operator-approved installed release. It does not load its control code from a PR or silently upgrade that code using a factory signature.

## Exact authorization and publication

The controller scans ready PRs independently. Session messages may be hints, but neither their origin nor their files authorize anything. Its private job binds the numeric GitHub repository ID, canonical HTTPS origin, `refs/heads/main`, PR number, full head `H`, current main base `B`, tree, check plan, installed policy version and fresh verdict. The signer authenticates the controller by Unix peer credentials on a private socket. Session users and the judge cannot connect. Requests name a job, not arbitrary bytes, paths, commands or commit messages to sign.

1. Fetch fixed GitHub refs into an account-owned bare object store. Validate repository identity and origin against installed policy. Require an open, non-draft PR targeting main at `H`, a current factory topic, required checks, and `B` equal to the last authorized release. Require `B` to be an ancestor of `H`, so its tree is the exact integrated tree being checked. A stale branch must change head and pass again.
2. Run the configured checks on that exact tree in disposable containers without credentials, host sockets or control-plane mounts. A trusted runner records exit evidence outside the containers. Obtain a fresh isolated judge verdict. Do not accept local session records, a user-editable status context or an unverified CI artifact as evidence. External required checks must match their expected GitHub App identity and commit, not just their displayed name.
3. Re-read PR/head/base and branch requirements, then call GitHub's squash merge with the exact head. Only the controller's App token makes this call. A moved head, draft or rejected rule stops it. GitHub's head comparison does not lock the base, so post-merge checks remain necessary.
4. Fetch GitHub's resulting commit `M`. Require the PR to be merged by the dedicated App, its reported merge commit to equal `M`, main to equal `M`, exactly one parent `B`, and its tree to equal the checked `H` tree. Unexpected ancestry, a different tree or an intervening merge stops publication. Never sign whatever main happens to contain after a failed attempt.
5. The signer independently fetches these objects and rechecks those facts, the authenticated job and installed grant. It constructs `L` itself with parent `M`, the identical tree, and a canonical signed message binding repository ID, main, PR, `H`, `B`, `M` and policy epoch. It signs `L` with the repository's factory key. No caller-supplied tree, parent list or signature payload is accepted.
6. Publish `L` with an ordinary fast-forward push, after any branch-required checks on `L` itself pass. Record job consumption durably before publication and reconcile a lost push response by object ID. Serialize releases per repository. Never force, retry over unknown history, or treat a later unsigned tip as approved. If fixed main rules prohibit this additional signed commit, this route is blocked and needs another reviewed design.

The signer's own GitHub reads and structural checks cannot be forged by editing session files. A session token can change PR state or push permitted refs, so all such changes are rechecked and can deny service. A compromised controller can authorize a false verdict, and a stolen factory key can forge an otherwise valid landing chain. Neither threat is solved by reading the same PR facts again. They are explicit compromises of the delegated authority.

These are stable primitives for the future implementation, not commands run by this PR. Variables must come from validated objects and the private job. Git and GPG use installed configuration, no candidate checkout, no hooks or filters, and a fixed tool path.

```sh
gh pr view PR_NUMBER --repo OWNER/REPOSITORY \
  --json state,isDraft,baseRefName,headRefOid,mergeCommit,mergedBy
gh pr merge PR_NUMBER --repo OWNER/REPOSITORY \
  --squash --match-head-commit "$head"
git -C TRUSTED_BARE_STORE rev-parse "$merged^{tree}"
git -C TRUSTED_BARE_STORE commit-tree "$tree" -p "$merged" \
  -S"$factory_fingerprint" -F TRUSTED_JOB_MESSAGE
git -C TRUSTED_BARE_STORE push origin "$landing:refs/heads/main"
```

There is an unsigned interval between `M` and `L`. Existing pollers must continue refusing `M`. They can skip directly from `B` to `L` once its proof is valid. A later unsigned push can still block availability. The factory reports GitHub merge, signed publication and observed installation separately.

## Public trust and verifier policy

The smallest path gives each VM one signers file holding both keys, where the factory key has the operator's full authority. The stricter form keeps `trusted-signers.asc` operator-only everywhere and adds a sibling `factory-trust/` directory containing public factory certificates and an operator-signed grant. Install it outside the clone at `/etc/agent-sandbox/factory-trust/` on each VM and `${POTS_RUNTIME:-$HOME/.config/agent-sandbox}/factory-trust/` on each Mac. The Mac's ordinary signer file remains at the same runtime directory. Installers must check ownership, public-only key material, full fingerprints and the operator signature. No secret is distributed.

The grant pins full primary and signing fingerprints, repository ID and canonical origin, main, an operator-approved starting commit, policy epoch, expiry, controller identity and the operator-only control-file rule. Recommend a maximum 30-day grant, evaluated against current trusted host time rather than the signature's creation time. Renewal is periodic operator administration, not a signature for each merge. Expiry rejects new factory-authorized launches through the installed guards as well as new updates. It does not remove installed pane modules, stop running processes or undo code already executed. Installed artifacts outside those entry points need explicit recovery.

This requires implementation changes to both receiver paths and the installed launcher, not just provisioning a public key. On the Mac, an operator-installed watchdog entry outside the clone must verify its current HEAD before running clone code or installers, even when main has not changed. The existing updater's candidate-only check is insufficient for expiry or revocation of an already landed HEAD. The VM's installed launcher must enforce the same policy on every trusted launch. The verifier must distinguish operator signatures from factory signatures and enforce the grant on every update and privileged launch. It must retain actual signing and primary fingerprints from `gpgv`, rather than accepting the first signature as a boolean. A factory signature alone never proves repository, branch or path scope.

For a factory tip `L`, validate the canonical repository binding, followed branch and grant, verify `L`'s signature with that repository's key, and enforce its signed metadata, parent and tree shape. Its parent `M` must have parent `B` and the same tree as `L`. Verify the release chain back to the installed operator-approved anchor, or a subsequently accepted operator-authorized release. Every intermediate factory release needs validation, even when a VM skipped several polls. Persist monotonic accepted checkpoints outside session access. Do not trust any unsigned `B`, accept a replacement origin, infer authorization from a commit date, or permit a rewind. The signer's signature is the offline assertion that its factory job approved `H`. Receivers do not need GitHub API credentials to accept it.

Do not apply the factory grant to task branches. Operator-authorized task-branch workflows remain distinct. The [session source provisioner](../lib/agent_sources.py) for Pi and Herdr currently fast-forwards without this signature check. Supporting those sources under this trust promise requires the same policy enforcement before their installers run. Installing a key on agent-sandbox VMs alone does not protect those checkouts or the separate operator Mac installations.

Reserve direct changes to trust grants, the installed verifier/launcher, updates, factory controller/signer, publication/check policy, service installation and their execution dependencies for Walid's key. Pin the protected path and dependency closure in operator-installed policy, with default denial of unknown file types, symlink targets, submodules or new control entry points. Check every release delta, including changes later reverted, rather than comparing only the final trees. A factory-signed tip directly changing this closure is refused on both VM and Mac. The implementation must inventory that closure before rollout and prove it with attack fixtures.

That path rule is a guard against direct self-modification, not a sandbox for approved host code. Other accepted code still runs with root or operator rights and could overwrite trust files, exploit an installer, or alter host time at runtime. A path denylist cannot prevent that. Recommend retaining this direct-change guard while treating compromise of any approved privileged code as compromise of the affected host. Enforcing operator-only trust changes against a hostile root process would require a separate execution boundary and is outside this design's claimed protection.

## Bootstrap, rotation and revocation

1. After design approval, implement and test using disposable keys and repositories. Walid approves the real isolated authority, new factory identity, App installation and fingerprint. No production private key is generated by a worker or imported from the Mac.
2. Walid reviews the accumulated unsigned main history, including previously merged fixes, and publishes an operator-signed bootstrap release under existing branch rules. Its content installs no trust merely because it is public. From a previously trusted operator checkout, explicitly install the new verifier, operator-issued grant and public factory certificate on every VM and Mac. [vm-up](../bin/vm-up) already invokes the trust installer, which would be extended for this purpose. Include each powered-off host in a tracked rollout inventory.
3. Disable the old session-authorized factory loop before enabling the isolated one. Migrate no PASS records as authority. Bootstrap the isolated factory from the operator-approved release and anchor, prove workers cannot reach it, then enable it. Do not ask the old factory to squash-merge its own trust bootstrap.
4. Rotate using a new repository-specific key and a higher-epoch operator-signed grant. Install the new public trust on all receivers before using the new key. Overlap grants only for a planned interval, then remove the old one and verify each host's effective fingerprints and checkpoint. A normal main pull is not proof that trust changed.
5. On suspected misuse, stop the controller and signer and revoke the App credentials through an independent operator route. Issue a higher-epoch deny grant and remove the key from each host's effective factory trust. Use the operator Mac/provider or out-of-band administration, not a factory-signed main update that the compromised key can race or suppress. A recovery release must carry Walid's signature. The installed recovery path must accept that operator-authorized repair even when the current factory HEAD is revoked or expired, without executing the refused clone to repair itself. Keep a revocation certificate for the new factory key under operator control, but do not mistake publishing it on GitHub for installing it in `gpgv`'s local trust.

There is no instant fleet revocation in the current system. On a reachable healthy host, denial takes effect when the replacement policy is installed and checked, not at the next main poll. The Mac's update interval and the VM's five-minute update timer do not refresh these files. Offline or unreachable hosts have no finite emergency delivery bound. The proposed 30-day grant limits how long an unupdated healthy host may continue accepting the key, provided host time is trustworthy. On reconnection, install current trust before restarting releases. A host that has already run hostile root or operator code must be treated as compromised and recovered independently, potentially rebuilt. Its own acknowledgment is insufficient.

A stolen single factory key can authorize malicious releases in its granted repository and on every machine consuming it, including host code. Scope checks stop cross-repository or wrong-branch replay on healthy receivers, but do not undo that authority. A compromise of the signing host or controller may expose all its repository keys. Disabling publication alone is insufficient because session-held or stolen GitHub credentials may still push allowed objects.

Record each signed job and publication in a controller-owned audit log and send public release IDs and unexpected-signature alerts to an operator-owned destination outside the worker session. A monitor compares remote signed releases with consumed jobs and receiver checkpoints. Missing jobs, invalid scope, changed signing fingerprints, publication failures and grant expiry must alert. The external copy prevents a worker from erasing the only evidence. Monitoring is detection, not guaranteed prevention, and a fully compromised authority can forge its own log. No recipient message or service is configured by this proposal.

## Credential channels and required attacks

These are named future acceptance probes, not tests claimed to run in this documentation PR. Run them through real service entry points with disposable keys. Retain the existing [check-container attacks](../session/factory-image/attacks.sh) and [clone-trust probe](../probes/clone-trust.sh).

| Channel | Closing mechanism | Attack that must fail and probe name |
| --- | --- | --- |
| Inherited environment | Separate service users and sanitized fixed environments. No signing or App credentials in checked code or the session. | A worker and check step run `env` and inspect parent environment. `factory-no-inherited-secrets`. |
| Sourced files | Controller and signer load only operator-installed files under private owned homes. | Plant `BASH_ENV`, profile and shell startup files in a PR. `factory-no-sourced-input`. |
| Process inspection | Separate UIDs, private service processes and no forwarded descriptors or GPG socket. | Read controller/signer `/proc` environment, memory and descriptors as session/check/judge users. `factory-no-process-access`. |
| Privilege | No sudo, host Docker socket, host mount or service-management capability in worker/check/judge contexts. A narrow trusted runner alone manages check containers. | Try `sudo -n true`, Docker host access and service replacement. `factory-no-escalation`. |
| Tool configuration | Bare private stores and operator-installed command/config policy. PR files are data, never Git configuration. | Plant hooks, filters, `core.fsmonitor` and alternate Git config. `factory-no-config-execution`. |
| Tool subprocesses | No dependency install, candidate executable or lifecycle hook runs in a credential-bearing process. Judge tools only read the job snapshot. | Replace package scripts, Git/GPG helpers or judge tool commands. `factory-no-candidate-subprocess`. |
| Shared writable places | Private per-job storage, no shared caches/hardlinks, no untrusted symlink traversal. Results stay outside check mounts. | Substitute symlinks, rewrite object stores or swap result files. `factory-no-shared-state-forgery`. |
| Shell evaluation | Fixed argument arrays and parsed JSON with validated IDs. Signer constructs canonical payloads. | Inject shell syntax in title, body, branch, status or message fields. `factory-literal-input`. |
| Lookup paths | Fixed absolute tools and private HOME/config paths. No candidate PATH, NODE_PATH or XDG lookup. | Place fake Git, GPG, Python, Node or config modules in PR paths. `factory-fixed-tools`. |
| Output | Public IDs and bounded redacted errors only. No secret-bearing command lines or debug dumps. | Force tool failures and inspect all worker-visible logs. `factory-no-secret-output`. |
| Network | No signer listener visible to sessions or checks. Private authenticated Unix socket only. Check jobs cannot reach host, metadata, control sockets or private services, even during allowed dependency fetches. | Connect directly, forge a wake, or use dependency-network access to reach a signer/controller service. `factory-no-session-signing-route`. |

| Guarantee | Required proof before enabling real trust |
| --- | --- |
| Only isolated factory approval signs | Fabricate session PASS files, comments, status contexts and signer calls. None may produce a signature. `factory-authenticated-job-only`. |
| Exact checked commit lands | Move the head/base, draft the PR, substitute a tree or parent, replay a job, interrupt after merge/push, and supply an unrecorded merge. Publication must stop or reconcile the identical object. `factory-exact-release`. |
| Scope holds at every receiver | Sign wrong repository/branch/epoch/tree/parent and replay a genuine release to another clone. Both Mac and VM refuse it. `factory-scoped-receiver`. |
| Control code needs operator approval | Change each protected dependency, add a new control entry point, or change then revert it across skipped releases. Factory signatures fail, operator-authorized fixtures pass. `factory-control-change-gate`. |
| Revocation and expiry apply to existing HEAD too | Remove a key, roll policy back, expire a grant, alter signature dates or restart from a revoked factory tip. Updates and new trusted launches refuse it. `factory-revoked-head`. |
| No privilege check is lost | Preserve clean/root-owned clone, safe Git config, tracked script, read-only mounts and fast-forward refusal probes. Exercise both ordinary and skipped-release chains. `factory-existing-boundaries`. |

The isolated judge can still make a wrong decision, including after reading hostile PR instructions. That is a quality and authority risk of trusting automated review, not a channel closed by this table. Kernel or container escapes and compromise of VM root, the Mac operator or the trusted platform are outside its isolation claim.

## Can GitHub's existing signatures suffice?

Yes, with a new provenance-verifying receiver and a distinct protected publisher, rather than merely trusting web-flow's key. No additional factory GPG key would be needed for that variant. GitHub would hold the signing key and its authenticated API state would become part of each receiver's authorization decision. The existing local verifier does not implement those checks.

The web-flow key is shared across unrelated users and repositories. GitHub [signs web-interface commits](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification), and [GraphQL `createCommitOnBranch`](https://docs.github.com/en/graphql/reference/commits) automatically signs supported commits as the authenticated credential owner. PR squash/merge through the web UI, `gh pr merge` and [`PUT /repos/{owner}/{repo}/pulls/{number}/merge`](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request) can also produce GitHub-signed commits. The GraphQL mutation is available through `POST /graphql`. Bot commit APIs can sign when authenticated as an App without overriding authorship. Codespaces can use GitHub-managed signing when enabled. Rebase-and-merge does not supply the same signature guarantee.

Consequently, every collaborator, installed App, workflow token or stolen/session token whose permissions and main rules allow those operations can potentially create a GitHub-signed main tip. A user can also push an already signed object if rules permit. Main's rules still decide which operations succeed. The shared signature identifies GitHub, not the factory. It does not bind the repository/ref as an authorization scope, name the automation that approved a PR, or distinguish the factory's use of Walid's token from a worker's use. A committer email, `merged_by: walid-mos`, a green status name or a `verified` flag is insufficient.

A defensible web-flow route would require exact local signature verification, canonical repo/main binding, a merged non-draft PR, the exact merge/head/base/tree relationship, an exclusively controlled factory App actor and authenticated check/verdict provenance tied to that release. It must reject direct GraphQL/web edits, another App's merge and missing evidence, and handle history changes, API outages, evidence retention, token access and revocation on every root launch. GitHub's [persistent verified status survives later key revocation](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification#persistent-commit-signature-verification), so that badge cannot be the revocation policy. Evidence originating in the worker session remains forgeable regardless of GitHub's signature.

Prefer the dedicated factory key. It makes the isolated authority's approval portable in the tip itself, gives each receiver offline verification and repository-specific revocation, and avoids GitHub API access for VM root launches. It adds private-key custody and one landing commit. Both designs need isolation of the approving authority. Neither can safely identify today's same-user factory merely by inspecting GitHub signatures. We must not claim that the new private key alone solves authorization.

## Alternatives and decisions

| Alternative | Why it loses to the recommendation |
| --- | --- |
| Factory key or freely callable signer in the pot session | Every same-user worker and dependency can publish host code without factory review. |
| GitHub web-flow with explicit provenance | Viable with an isolated App/controller, but adds online receiver dependencies and durable provenance validation to every root execution. |
| Blindly accept GitHub signatures | Accepts unrelated allowed web/API activity, not just the factory. Rejected. |
| Operator-signed landing index or countersignature ref | Still requires an automated delegated authority for unattended release, plus another fetched object and freshness/rollback rules. |
| D. Factory judges, Walid signs each release | Keeps a personal approval gate and no online factory signing key. Safe alternative if Walid prefers it, but fails his request for releases without his per-merge signature. |
| Operator key in CI, another pot or a hardware token the session can freely invoke | Reuses or exposes the operator identity and grants broader authority than a separately revocable factory key. Rejected. |

Only Walid can decide these:

- **Delegate or not.** Approve that the factory, not he, decides what runs as root on the pots, for agent-sandbox only. Otherwise option D stays: he signs each release.
- **The Mac.** Recommend the Mac keeps trusting his key only. He can let it follow factory-signed tips instead, which lets a compromised signing VM reach his Mac account.
- **Where the key is created.** Recommend root creates it in the signing VM and he reads it from his Mac. The other choice is to create it on the Mac and carry the private half in.
- **Which pot signs.** Each signing pot gets its own key, and each key is one more authority over every pot.
- **Hardening now or later.** Recommend the smallest path first, then the grant with an expiry and the operator-only control files. Requiring them in the first release means changing the verifier and the launcher too.
- **GitHub.** Nothing is needed. Register the key on a machine account only if he wants the badge or adds a signed-commits rule.
- **Pi and Herdr.** They stay outside this trust until their provisioner checks signatures.

With the smallest path, an offline Mac does not stop landing on the pots. A stopped factory or signer, a missing key or a `main` tip the factory did not make stops factory landing while running processes continue. Disabling the factory leaves the operator-signed path as it is today and never requires accepting GitHub's signature. None of these choices is implementation approval until Walid says so.
