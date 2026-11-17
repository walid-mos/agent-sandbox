# Tailnet setup

The pots join the human's tailnet through two one-time human steps in the Tailscale admin console, then one vault entry. No pots command changes the tailnet policy or creates the OAuth client. [The README](../README.md#tailnet-and-doors) describes the nodes and the doors.

## 1. Apply the pots policy

On the operator's machine, write your Tailscale login, the one your devices sign in with, then print the pots entries from it and every pot's `doors`:

```sh
printf '{"operatorLogin": "%s"}\n' you@example.com > ~/.config/agent-sandbox/tailnet.json
./bin/tailnet-policy mastermind nextnode accor personal
```

`./bin/vm-config`, which `./bin/vm-up` runs, installs that file in each VM, where the node checks read the same login.

Merge what it prints into the tailnet policy file (Access controls, JSON editor): add its `tagOwners` entries and its `grants` entries to the existing ones.

| Entry | Effect |
| --- | --- |
| `tag:pot-keys` owned by `autogroup:admin` | The tag of the OAuth client below. No node carries it, so no pot may be named `keys` |
| `tag:pot-<pot>` and `tag:pot-<pot>-host`, owned by `tag:pot-keys` | The client can mint keys for these tags and no other |
| Your login to every `tag:pot-<pot>`, tcp 443, 10001-18790 and 18792-65535 | Your devices open the session's Serve links and tailnet-link previews. A userspace node hands each of these ports without a Serve handler to the session's loopback, so your devices reach every session listener on them, served or not. No other user of the tailnet and no pot reaches a session. 18791 stays out: tailnet-link's file server listens there and trusts the login header Serve adds, and a userspace node hands a port without a Serve handler to its loopback, so a direct grant would let a device forge that header |
| Your login to every `tag:pot-<pot>-host`, tcp 22 | Your devices enter a session through the VM's forced ssh command |
| `tag:pot-<x>` to `tag:pot-<y>-host`, tcp 2222, when the `doors` of x name y or the `doors` of y name x | A session node knocks at a door its `doors` name, or at the door of a pot that asked it, to reply. Never at its own VM, never at another session |

The rest of the policy must not widen these grants. `bin/tailnet-up` keeps a node's shields up and stops when the filter the node receives:

- holds a rule with the source `*`, such as the default allow-all grant;
- opens any other port to a pot node, through `autogroup:member`, a group or a user;
- lets the node use Funnel through `nodeAttrs`;
- lets the node reach any other service of any peer.

`bin/check` refuses a generator that grants another port, grants a port to anyone but the given login or a pot tag, opens a door off the `doors`, or prints `nodeAttrs`, `autoApprovers` or `ssh`.

Adding a pot or changing a pot's `doors` means running `bin/tailnet-policy` again and replacing the earlier pots entries with what it prints, then running `bin/pots-doors`.

## 2. Create the OAuth client

In Settings, OAuth clients, create a client with the scope **Auth Keys, write** and the tag `tag:pot-keys`. No other scope is needed: no pots command lists, renames or deletes devices.

## 3. Store the client secret

Store the client secret in the vault as `TAILSCALE_POTS_OAUTH_CLIENT_SECRET`, at the folder that `tools.tailscale.path` names in `~/.config/agent-secrets/core-vault.json` on the operator's machine. [`bin/tailnet-key`](../bin/tailnet-key) reads it through the machine's Infisical CLI with the Universal Auth credentials of the shell, posts it to Tailscale's token endpoint, and keeps no copy.

No sandbox's vault identity may read that folder. The client mints keys for every pot tag, so a session holding it could join as another pot and pass that pot's door check.

## Then, per pot

```sh
SANDBOX=nextnode ./bin/tailnet-up
./bin/pots-doors mastermind nextnode accor personal
```

`bin/session-bootstrap` runs `bin/tailnet-up` last. `bin/pots-doors` takes every pot of the mesh in one run, after each pot's nodes have joined, and installs each door's keys from the same `doors` as the policy.

## What fails without each step

| Missing | Symptom |
| --- | --- |
| The policy's `tagOwners` | `tailnet-key: Tailscale refused a key for tag:pot-...`; no node joins |
| The policy's grants, or a wider grant left in place | `tailnet_node: shields stay up: ...` naming the port, source or peer; the node is joined and takes no connection |
| A grant left in place that opens an allowed port to another source: another user, a pot tag, a tagged device, a range or a CIDR | `tailnet_node: shields stay up: the policy lets [...] reach ports 54321-54321, which only the operator's untagged devices may reach`, or `which only other pots' session nodes may reach` on the door port; the VM guard prints the same after `shields raised:` |
| `~/.config/agent-sandbox/tailnet.json`, or `bin/vm-config` after writing it | `tailnet_policy: ... tailnet.json must hold {"operatorLogin": ...}`; on a node, `shields stay up:` with the same line |
| The operator's machine on the pots tailnet, with `tailscale` and `jq`, when `bin/tailnet-up` runs | `tailnet_node: shields stay up: standard input held no operator view of this node's tailnet`; a node whose shields were down raises them |
| The OAuth client, or its tag | `tailnet-key: Tailscale refused the OAuth client` or the key refusal above |
| The vault entry, or Universal Auth in the shell | `tailnet-key: The vault did not return TAILSCALE_POTS_OAUTH_CLIENT_SECRET` |
| `bin/pots-doors` | A door call ends with ssh's exit 255 (no key, unknown host key); `probe-boundary` reports the door attacks untestable |

A device left from an earlier join keeps its name, so a new node would get `<pot>-1`. `bin/tailnet-up` refuses such a node and says to delete the old device in the admin console, run `tailscale logout` on the node, and run it again.
