# Upstream contributions

The GitHub wrapper acts only for owners in `owners`, so it refuses an upstream repository such as `Crokily/pi-durable-bot`. `session/contribute` is the one narrow route for contributing to such a repository from a personal fork. It does not change the wrapper, the owner map or the vault.

## Policy

The pot's private `sandbox.json` names each upstream, the one fork that serves it and the operations allowed:

```json
"contributions": {
  "Crokily/pi-durable-bot": {
    "fork": "walid-mos/pi-durable-bot",
    "operations": ["fork", "issue", "push", "pull-request"]
  }
}
```

[`session/contribution-policy.mjs`](../session/contribution-policy.mjs) refuses a key that is not canonical `OWNER/REPOSITORY`, any field besides `fork` and `operations`, an unknown or empty operation list, a fork equal to its upstream, a fork or upstream listed twice, a fork owner outside `owners` and an upstream owner inside `owners`. The credential is the `owners` entry of the fork's owner, so no credential name appears in the policy. `./bin/check` validates the examples. The VM copies the file with `./bin/vm-config`, as for any other key.

## Operations

Run each through `/opt/agent-sandbox/session/contribute`, which starts [`contribute.mjs`](../session/contribute.mjs) under `with-vault`. Output is JSON and holds no credential. A write accepts `--dry-run`, which does every read and check and prints the plan, including the exact repositories, account, branch and commit, and for a body its SHA-256 and size. Quote that plan in an approval request.

| Operation | What it sends | Checks before sending |
| --- | --- | --- |
| `check UPSTREAM` | Reads only | Credential account, upstream state, fork state and its push permission |
| `fork UPSTREAM` | `POST /repos/UPSTREAM/forks` with the policy's fork name, default branch only | Account equals the fork owner, upstream is public and active, the fork is absent, and the created repository is that fork of that parent |
| `issue UPSTREAM --title T --body-file F` | `POST /repos/UPSTREAM/issues` | Account, upstream public, active, Issues enabled, no issue by that account with the same title (a retry returns it), a one-line title and a nonempty body up to 64 KiB |
| `push UPSTREAM --branch B --commit C [--expect R] [--worktree D]` | One Git push of `C` to `refs/heads/B` of the fork | Fork readback (`fork: true`, parent, not archived, push permission), a topic branch, local `B` at the full commit `C`, the fork's `B` absent, already at `C` (no-op) or at `R`, and the fork's `B` at `C` afterwards |
| `pull-request UPSTREAM --branch B --commit C --title T --body-file F` | `POST /repos/UPSTREAM/pulls`, draft, base the upstream's default branch, `maintainer_can_modify` false | The fork's `B` is at `C`, no open pull request already uses that head (the same commit returns it), and the answer has that head, base and draft state |

Every GitHub call is to `https://api.github.com`, with redirects refused and a 30 second limit. A failure names the HTTP status and GitHub's message. A 401, 403 or 404 adds that the credential lacks the permission, and exits 3. Nothing retries or tries another credential or route.

## Trust boundary

- The caller supplies repository names only to select a policy entry. The account, token and URLs come from the policy and the owner map.
- The command reads the token from the environment, then reduces its own environment to basic settings, so no other vault value reaches a child process.
- `push` runs Git in an empty bare repository with no system or global configuration, no hooks and no redirects, reading objects from the checkout. The checkout's hooks never run. Git commands that read the checkout (the branch check and one lookup of its object directory) hold no credential in their environment, and the branch check also disables `core.fsmonitor` and hooks. The token reaches Git through a helper that reads it from a variable named for the push alone. A push never forces: an existing fork branch moves only to a descendant, and only from the head the caller expects.
- Issue and pull request text is read from a regular file by the command and sent as JSON, never passed through a shell or to `gh`.

## Approval

`push`, `issue` and `pull-request` write to GitHub outside the pot's own repositories. Before one, apply the [push policy](human-dialogs.md#when-to-ask-for-push-approval) and the pot's `rules`. Scope the question to one operation, naming the dry run's plan: upstream, fork, branch and full commit for a push; upstream, head, base, commit and body SHA-256 for a pull request. The tool does not itself read an approval, so run the real operation only after the matching yes.

## Limits and blockers

- The credential must be allowed to do the action. A token limited to its own resource owner may not create issues or pull requests in a repository owned by another account. This was not exercised and no live write was made. GitHub's refusal is surfaced, never worked around.
- The credential's account must be the fork's owner, and a personal fork only is supported: no organization fork or other target.
- The issue duplicate check reads the account's most recent 100 issues.
- Release: the route reaches a pot only with a signed `main` that holds this change, an operator update of the VM clone and `./bin/vm-config` with the `contributions` entry. None ran from this worktree.
