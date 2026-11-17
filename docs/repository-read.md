# Exact repository reads

`session/repository-read OWNER/REPOSITORY DESTINATION [COMMIT...]` obtains a Git bundle from the VM broker and imports it into a new bare repository. It never checks out files or installs a remote. The destination's parent must already exist and belong to the caller. Existing destinations and symlink components are refused before contacting the broker.

The operator configures an exact, case-sensitive policy key in the pot's private `sandbox.json`:

```json
{
  "readRepositories": {
    "ExampleOrg/reference": {"credential": "GITHUB_TOKEN_REFERENCE"}
  }
}
```

The credential is a variable name under `/tools/github` in the pot's configured vault project and environment. No entry is added to `owners` or `sources`. Policy permits no extra entry fields and no public or unauthenticated mode. The broker constructs `https://github.com/OWNER/REPOSITORY.git` itself. Requests contain only `kind`, `repository` and up to 16 full SHA-1 commit IDs.

## Trust boundary

| Trusted | Untrusted |
| --- | --- |
| Operator, VM root, operator-signed source, root-owned policy and vault identity | Session code, request bytes, session environment, destinations and fetched Git objects |
| Broker holds the vault login and selected GitHub token for the request | Session receives a bundle, never a secret pair from this grant |
| Dedicated VM fetch account holds the GitHub token during fetch | Session users cannot inspect the VM process tree |

| Channel | Closure |
| --- | --- |
| Environment and lookup paths | Git receives a built environment, fixed executable and exec path, no inherited proxies, executable overrides or Git settings. |
| Tool configuration | Fresh private bare repository, empty template, no system/global config, hooks, fsmonitor, maintenance, recursion or external filters. |
| Credential helper | Fixed helper answers only HTTPS github.com and the selected exact path, with redirects disabled. Token travels in child environment, never argv or files. |
| Files and process inspection | Fetch runs as a dedicated non-root VM account, with no session mounts, login, home or supplementary groups. Temporary files are private and removed after each request. |
| Shell evaluation | Validated strings become argument-list elements. No request text becomes shell code. |
| Output | Broker returns bundle bytes encoded as base64, or fixed error text. Git stderr, credentials and child environment never enter replies or logs. |
| Network | Only the canonical HTTPS GitHub URL, no redirects or URL rewrites. Bundle import is offline. |
| Resource use | One read at a time, bounded fetch time, file size and bundle size. A compromised session can repeatedly request allowed reads and occupy that slot. |

The operator can change the policy or replace the credential and can access VM root. A compromised session can read all objects this repository advertises and request named commits the server permits. This policy cannot reduce the GitHub permissions of a token. The token might write to other repositories. Existing owner and source release routes and the session's own vault login remain separate exposure paths, including any source that already releases the same token. This change does not restrict those paths.

Actual GitHub access is unverified until the operator activates the grant. A fine-grained or app token may be restricted to one resource owner. An authenticated refusal requires an operator to replace the credential with one that can read the selected repository. Never add an owner, widen the grant or fall back to another token.

## Proofs

`./bin/check` includes `probes/repository-read-policy.py` and `probes/repository-read.py`. They reject malformed policy, prove unchanged owner releases and no grant-token release, exercise the command with six generated commits, leave existing destinations untouched, suppress poisoned config and executable overrides, and reject redirects and missing commits. All credentials and repositories are invented.

`node probes/repository-read-vm.mjs` builds the repository's factory image if necessary, runs its isolation attacks, then starts a disposable root fixture container with no external network and this source mounted read-only. Only this fixture has the capabilities to create and inspect a dedicated fetch account. Inside it, a local HTTPS Git server answers the canonical github.com URL using a generated certificate and fake token. The probe checks all six commits, the worker's non-root UIDs, bundle-only output, authenticated refusal, redirect refusal without credential release, and temporary-directory cleanup. The runner records a unique container name and ownership label and removes it on success, failure or timeout. The fixture's CA changes and account disappear with the container. It never runs against a live VM.

The broker permits at most 16 named commits, one read at a time, a 100-second worker deadline, 60 seconds per Git operation, a 64 MiB file and bundle limit, and a 512 MiB worker address-space limit. These bounds can refuse large repositories. They do not impose a total storage quota across every pack file.

## Activation

Keep the pull request in draft while its coordinator holds it. A merge alone activates nothing. After the hold is lifted, the operator signs the approved main tip, edits the pot's private policy, and runs `SANDBOX=POT ./bin/vm-up` from the Mac. `vm-config` carries policy to the VM. VM setup creates the fetch account and restarts `pots-vault.service` and `pots-door.service`. It restarts `tailscaled` only when its pinned version changes, starts the firewall without restarting it, and enables the keeper, update and tailnet-guard timers. Announce the brief broker and door interruption first. No session restart or bootstrap is needed.

After installation:

```sh
/opt/agent-sandbox/session/repository-read ExampleOrg/reference /config/Development/reference COMMIT_ID
/usr/bin/git -C /config/Development/reference cat-file -t COMMIT_ID
```

Only after the real objects are verified should the client instruction file record its exact command and that the named operator credential stays on the VM. A plain clone uses the separate owner route and is not authorized by this grant.
