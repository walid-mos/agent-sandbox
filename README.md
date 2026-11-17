# agent-sandbox

Development sandboxes for a Pots bot and its Pi workers. Each sandbox is a desktop session on its own VM, a Colima VM on the Mac or a Proxmox VM on a node, started either by plain Docker or, on Colima, by SealSkin. The session has its own writable home and nested Docker daemon, and reads this repository from its VM's own clone. Nothing of the Mac is mounted in the VM or in the session.

## Sandboxes

Each sandbox has a directory under `~/.config/agent-sandbox/sandboxes/`, named after it, holding `sandbox.json`. [`sandboxes.example/`](sandboxes.example) holds a starting point, which `./bin/configure-host [docker|sealskin|proxmox]` copies when the runtime directory has none. `POTS_RUNTIME` names another runtime directory, which keeps a trial sandbox out of the watchdog's sight. That name is also its Colima profile or Proxmox VM name. Every command under `bin/` and `mac/` acts on the sandbox that `SANDBOX` names and stops when it is unset. Inside a VM, a command of its own clone at `/opt/agent-sandbox` run with `POTS_TRANSPORT=local` acts on that VM's sandbox and needs no `SANDBOX`: the keeper and the forced command of the session keys run that way. `vm-up`, `vm-config` and `probe-boundary` refuse it and run only from the operator's checkout.

| Key | Meaning |
| --- | --- |
| `provider` | `colima` (the default) or `proxmox`: where the sandbox's VM runs. [Proxmox sandboxes](#proxmox-sandboxes) describes the second. The Mac's watchdog keeps only the sandboxes on `colima` |
| `proxmox` | `proxmox` only. The node and the VM's network |
| `launcher` | `docker` (the default) or `sealskin`. Docker starts the session image with `docker run`. SealSkin starts it through its server, as before |
| `vm` | Cores, memory, swap file and disk of the VM |
| `serverPort` | `sealskin` only. Mac-local port of the sandbox's SealSkin server. Each sandbox needs its own |
| `bot` | Name of the Pots bot that bootstrap creates, in one word |
| `rules` | Optional. Path, in the session, of an instruction file that the bot and every worker of the sandbox load |
| `maxWorkers` | Optional. Workers that run at once, the others waiting in the order they came. The default divides the session's memory less 2 GiB by 3 GiB, with at least 1. The kernel reports a little less than the VM's size, so a 20 GB VM runs 5, a 10 GB VM 2, and an 8 GB or 2 GB VM 1. The 2 GiB for the session and 3 GiB per worker are estimates until `bin/pots-load` measures a pot |
| `idleStackMinutes` | Optional, 30 by default. Minutes a worker's worktree goes with no live terminal before the watcher stops its Compose projects |
| `owners` | GitHub owners that the dispatcher and the GitHub wrapper accept, each with the name of its token in the vault's `/tools/github` |
| `secrets` | Other vault folders, each with the names injected from it |
| `onRequest` | Named groups of vault folders and names, injected only into a command that asks for the group |
| `role` | Optional. `mastermind` for [the Mastermind](#mastermind). Left out for a pot that owns a domain; any other value stops the session's code |
| `doors` | Optional. The pots this pot can ask through [their doors](#doors), each with one line on what it owns |
| `sources` | Names from [the source catalog](session/agent-sources.json) that the session fetches and installs, such as `["pi", "herdr"]`. A catalog source left out is never fetched |

Beside `sandbox.json`, the directory holds `vault.json` (the vault `project` and `environment`) and, optionally, `git-identity.json` (`name` and `email` for the session's commits). One file serves every pot: `~/.config/agent-sandbox/tailnet.json`, beside the sandboxes, holds `operatorLogin`, the Tailscale login of the operator's devices, which [the pots policy](#tailnet-and-doors) grants and the node checks expect. `./bin/vm-config` copies these files into the VM's `/etc/agent-sandbox`, readable by every user of the VM and writable by root only, and `vm-up` runs it. The session mounts that VM directory read-only at the same path. An edit on the Mac reaches the sandbox at the next `./bin/vm-config`. From there, the next command reads a changed `owners`, `secrets`, `onRequest` or `doors`. `vm` applies when the VM next starts, `serverPort` when the server is next created, `bot`, `rules` and `role` at the next bootstrap, and `maxWorkers` and `idleStackMinutes` when the watcher next starts, which bootstrap does. The next `./bin/vm-up` applies a changed `vm.swapGiB` to a running VM, with no restart.

[The VM's vault broker](vm/vault-broker) refuses a listed name starting with `INFISICAL_`, since such a name carries vault access, and `./bin/check` refuses one in the examples, and an example whose `sources` is not a list of catalog names.

## Install on the operator's Mac

The configuration targets Apple Silicon macOS. A VM mounts nothing of the Mac. `vm-up` clones the public origin that [`session/launch.env`](session/launch.env) names into the VM's `/opt/agent-sandbox`, on the branch the Mac checkout is on, and copies the sandbox's files into `/etc/agent-sandbox`. The session binds both read-only at the same paths. The Mac's LAN address, the Git identity and the vault project stay in `~/.config/agent-sandbox`, never in this repository: `./bin/import-private OLD_CHECKOUT` copies the Git identity and the vault project out of an older checkout without changing it. Its `host.json` holds `macLanAddress`, the Mac's IPv4 address on the Proxmox node's LAN: a private address in 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16, written without leading zeros, whose router, ssh and Postgres ports `probe-boundary` checks a Proxmox pot's session cannot reach.

Install Colima, the Docker CLI with Compose, Node, curl and jq first. The Mac also needs the Pi harness in the home directory's `.pi/agent`, its Infisical machine authentication and a binding whose `boats` key identifies the Agents Sandboxes identity. The host identity must be allowed to mint that identity's client secret. Export the operator's public signing key with `gpg --export --armor KEY_ID > ~/.config/agent-sandbox/trusted-signers.asc`: every VM and the watchdog run only commits a key in that file signed. Never put credential values in this repository or a command line.

Run these commands from the Mac checkout. Keep `SANDBOX` set for the later host commands.

```sh
cd /path/to/agent-sandbox
export SANDBOX=sealskin
./bin/vm-up
./bin/sealskin-up   # launcher sealskin only
```

With the `docker` launcher, `vm-up` is the only step before `./bin/pots-session ensure`: no server starts and no admin setup exists. `pots-session` then runs the session image with `docker run`, with the same runtime, label, home volume `pots-home`, inner Docker volume and binds as SealSkin. [`session/launch.env`](session/launch.env) holds the image digest, runtime and volume names that both launchers read, and `./bin/render-config binds` prints the binds. `sealskin-up` and `sealskin-apply` refuse a docker sandbox.

`vm-up` writes the Colima profile from [the Colima template](colima/colima.yaml) and the sandbox's `vm` values, then starts the VM when it is stopped, with no mount: Colima mounts the Mac home for an empty `mounts` list, so the template sets it to `null` and the start also passes `--mount none`. It clones or fast-forwards `/opt/agent-sandbox`, copies the configuration, installs Sysbox, the container runtime, enables the firewall service and starts the VM's keeper and update timers. A VM started with a mount keeps it until it stops: `pots-session` refuses to launch there, as [the host-path check](vm/check-host-paths) says, and `probe-boundary` fails. Review the template and [the firewall configuration](vm/network.env) before starting. `sealskin-up` starts the server and applies the app template. Applying configuration restarts the SealSkin server and waits for it to load the template and installed app before returning.

With the `sealskin` launcher, complete SealSkin's initial admin setup through its Mac-local endpoint, `https://127.0.0.1:PORT`, where `PORT` is the sandbox's `serverPort`. The session API requires SealSkin's `/config/root_key`, and the installed Pots app is assigned to `admin`. This repository does not automate that initial admin setup.

The VM's keeper launches the session within a minute of `vm-up`. To have it at once, and to bootstrap its tools:

```sh
./bin/pots-session ensure
./bin/session-bootstrap
```

`session-bootstrap` brings a session up in this order, and rerunning it is safe.

1. It stores the VM's vault identity when the VM holds none.
2. It installs the session tools and the Pi harness. Versions and steps live in [the bootstrap script](session/bootstrap).
3. It adds the sandbox to the Mac's Herdr machines, which copies `hc` into the session, or updates that copy when the entry exists.
4. It restarts the router and seeds it, as [Model router](#model-router) describes.
5. It creates the sandbox's bot when it has none, then links [its instructions](#the-bot-and-its-pi-workers), [the pot rules](session/pot/AGENTS.md) and the sandbox's `rules` into the session.
6. It restarts the gateway, the worker watcher and the source watcher.
7. It creates the Factory bot when the pot owns repositories.
8. It serves the pot's files under its tailnet name, as [Pot cloud](#pot-cloud) describes.

Bootstrap needs access to the private harness repository and the configured vault paths, and the Mac's Magpie as the source of the seed.

The credential step pipes a newly minted Agents Sandboxes client secret from the Mac into [a root-only file of the VM](vm/store-vault-identity), `/etc/pots-vault/identity.json`, outside every path the session mounts. Only [the VM's vault broker](vm/vault-broker), a root service, reads it, and the session never holds it. The minted secret has no expiry or use limit. Rerunning `./bin/session-credentials` replaces the stored identity without revoking earlier secrets. An installation failure can leave downloaded tools or a partially configured home behind. Fix the reported cause and rerun bootstrap.

The MacBook and the phone reach a session through its pot's VM node, `<pot>-host` on the tailnet, as [Tailnet and doors](#tailnet-and-doors) describes. The ssh user is the Mac user's name on Colima and `root` on Proxmox, on port 22. A device whose Herdr adds machines by ssh, such as the phone, takes that target as it is. On the MacBook:

```sh
hc machine add --name "$SANDBOX" --via "ssh -o BatchMode=yes USER@$SANDBOX-host"
```

- `./bin/vm-up` copies the keys of the Mac's `~/.ssh/authorized_keys` into the VM, so a key the Mac accepts enters each sandbox. Run it again after adding a key to the Mac.
- Each key is bound to [a forced command](vm/session-keys). It runs the client's shell line in the session as the session user, with no terminal and no forwarding, through the launcher that verifies the VM's clone first, and runs nothing else in the VM.
- The tailnet policy lets the human's devices reach a VM node on port 22 only. The firewall keeps a session off every tailnet address, its own VM's included, and `./bin/probe-boundary` checks the VM node's ports from the session.

## Proxmox sandboxes

A sandbox whose `provider` is `proxmox` runs on a VM of a Proxmox VE node, reached over ssh as root. `./bin/vm-up` creates that VM once and starts it. As on Colima, it installs the trusted launcher, clones this repository into `/opt/agent-sandbox` in the VM, copies the sandbox's files to `/etc/agent-sandbox`, then runs the [VM setup](vm/setup.sh) and [session keys](vm/session-keys). The session binds those two VM paths, and nothing from the Mac is mounted. Push a change to the branch the VM's clone follows for the VM to receive it. [The example](sandboxes.example/proxmox/sandbox.json) is a starting point.

| `proxmox` key | Meaning |
| --- | --- |
| `host` | ssh host name or alias of the node, such as `hp-proxmox`. The Mac's ssh configuration gives it the root user and a key |
| `vmid` | VM id, from 100 |
| `storage` | Storage for the VM's disk and cloud-init drive, such as `local-lvm` |
| `bridge` | Bridge of the VM's network card, such as `vmbr0` |
| `address` | The VM's fixed IPv4 address with its prefix length, such as `192.168.1.201/24`. No other machine or DHCP range may use it |
| `gateway` | IPv4 gateway of that network |
| `cpuUnits` | The VM's CPU weight against the node's other VMs, from 1 to 10000. Proxmox gives a VM 100 by default |

The sandbox's directory name names the VM, so it must be a lowercase host name. `vm.cpu`, `vm.memoryGiB` and `vm.diskGiB` size the VM, and `vm.swapGiB` sizes its swap file as on Colima. A Proxmox sandbox uses the `docker` launcher and has no `serverPort`. Every command checks the sandbox against [the Proxmox rules](proxmox/config.jq) before anything reaches the node, prints each problem and exits with status 2. `./bin/check` applies the same rules to the examples.

On the node, [the VM script](proxmox/ensure-vm.sh) holds a node-wide lock while it works.

1. It creates the node's own VM key, `/root/.ssh/pots-vm_ed25519`, when absent.
2. It lists every guest, VM or container, that holds the VM id or the name. With none, it creates the VM. A single VM with that id, that name and the `pots` tag is the sandbox's own. Anything else stops `vm-up` before it changes a guest.
3. A new VM starts from the Ubuntu 24.04 cloud image pinned by release and SHA-256 in that script. The script takes the image from `/var/lib/vz/template/iso`, downloads it when absent and refuses a file with another checksum. Proxmox's own cloud-init settings give the VM root login with the node's key, its fixed address, public resolvers, no package upgrade at first boot and a start at node boot.
4. It applies cores, memory and CPU weight, grows the disk to `vm.diskGiB` and never shrinks it. Changed cores and memory of a running VM apply at its next start. It then starts a stopped VM and waits for cloud-init to finish with ssh open, trying 60 times, 5 seconds apart.

A command in the VM runs as root through two ssh hops: from the Mac to the node with the Mac's key, then from the node to the VM with the node's key. Each word is quoted once per hop, and stdin and the exit status pass through both. The Mac never holds a key to the VM. The node trusts the VM's host key at its first boot and requires that key afterwards. `./bin/vm-exec COMMAND` runs one such command. Inside the VM, each Mac key's forced command runs with `POTS_TRANSPORT=local`, which reads `/etc/agent-sandbox` and the VM's Docker directly.

The boundary choices:

- Root on the node controls every pot VM on it, so the node is part of the trusted operator side, like the Mac.
- The VM firewall is Colima's. `probe-boundary` also checks the node's ssh and web ports, the gateway's web port, the ssh port of every Proxmox sandbox, and the Mac's router, ssh and Postgres ports at `macLanAddress`, where a pot VM reaches the Mac.
- The VM resolves names through 1.1.1.1 and 9.9.9.9. Docker hands session containers the VM's upstream resolvers, and the firewall drops their traffic to the network's own private resolver.
- The firewall rules name no uplink: a container's traffic to a private range is dropped on every interface but the container bridges, whatever Proxmox's cloud-init names the VM's card.
- `/etc/agent-sandbox` in the VM is readable by every VM user, as the session user needs. It holds no credential: the vault identity lives in `/etc/pots-vault`, readable by root only.

Limits:

- The pinned image is amd64, so the node must be amd64.
- Only cores, memory, CPU weight and a larger disk reach an existing VM. A changed `address`, `storage`, `bridge` or `gateway` needs a new VM, which `vm-up` never creates over an existing one. No command stops or deletes a Proxmox VM.
- As on Colima, the VM's clone takes the pushes to its branch within five minutes, and a changed sandbox file reaches the VM at the next `./bin/vm-config`.
- The SealSkin launcher exists only on Colima.

## Tailnet and doors

Each pot has two tailnet nodes. The pots policy, which [`./bin/tailnet-policy`](bin/tailnet-policy) prints from every pot's `doors`, decides what reaches them, and [the tailnet setup](docs/tailnet-setup.md) lists the one-time steps it needs and what fails without them.

| Node | Name | Tag | Runs | Reachable on |
| --- | --- | --- | --- | --- |
| VM node | `<pot>-host` | `tag:pot-<pot>-host` | the VM's `tailscaled`, with `--netfilter-mode=off --accept-dns=false` | 22 from the operator's devices; 2222 (the door) from the session node of each pot whose `doors` name this pot, and of each pot this pot's `doors` name, to reply |
| Session node | `<pot>` | `tag:pot-<pot>` | [a userspace `tailscaled`](session/services.d/pots-tailnet) in the session, with `--accept-dns=false` | 443, 10001-18790 and 18792-65535 (Serve and tailnet-link previews) from the operator's devices. Never 18791: tailnet-link's file server trusts the login header Serve adds, and a userspace node hands a port without a Serve handler to its loopback |

`./bin/tailnet-up` joins both nodes, then checks the session node before the VM node, and `./bin/session-bootstrap` runs it last. For each node, [the key helper](bin/tailnet-key) mints a key that is single-use, not ephemeral, preauthorized, valid ten minutes and tagged with that node's tag only. The key goes on standard input from the helper to `tailscale up` in the VM or the session, never in an argument or a file. A node joins with shields up, and the control server then sends it none of the peers that may only reach it, the operator's devices included. So `bin/tailnet-up` pipes into the check the operator machine's own `tailscale status --json`, reduced by `jq` to the tailnet name, each device's addresses, tags and user ID, and each user's login. The session node's check gets only the untagged devices of that view and the users they name: a session admits only the operator's devices, so its agent code learns no other pot's tag or address. [The node check](lib/tailnet_node.py) then reads the packet filter the control server sent and the node's capabilities, and dials every peer it sees on ssh, web, Magpie, Postgres, Proxmox, tailnet-link's file server and door ports. It lowers the shields only when each source the policy admits is the one address of a peer that the node's status or that view shows, each judged against its own user list: an untagged device of the login in `tailnet.json` on 22 and the session's ports, another pot's session node on the door port, never `*`, a range or a wider CIDR. The node also needs that login installed, a policy that opens no other port than the table's, the node holds no Funnel, and the node reaches nothing but other pots' doors. The check knows another pot's session node by its tag alone: one `tag:pot-<name>`, not ending in `-host`, not this pot's and not `tag:pot-keys`. The VM holds no list of the mesh, so a merged grant from a session under a tag no pot uses passes too; that node reaches only the door port, where the door's sshd holds no key for it and ssh refuses it with 255. The view counts only from the node's own tailnet, its `Self` counts like any peer, and an address the node's status and the view show under different identities counts for neither. A missing or unreadable view, or one from another tailnet, is one more problem: the shields stay up, or go up on a node whose shields were down. Otherwise the shields stay up and the command prints what it found. The operator's machine sees a session node only once its shields are down, and a VM node's door admits other pots' session nodes, so each check reads a fresh view. In a new mesh, run pot by pot, each VM node's door names only sessions already checked, and every pot passes on its first run. A VM node whose door names a session still shielded fails closed and passes on a later run, once that pot's run has lowered its session: [the tailnet setup](docs/tailnet-setup.md#then-per-pot) gives the order after every node was shielded. A node already joined under another name or tag stops the command with the steps to remove it. [A VM timer](vm/tailnet-guard) reads again, every minute, the packet filter and capabilities each node of the pot receives, judged against that node's own status alone, and raises that node's shields when a policy edit opens more than the table, or when it cannot read or parse what the node receives; only `bin/tailnet-up` lowers them, after its full check. The timer runs the guard from the clone, so a clone the launcher refuses leaves both nodes unjudged: the guard's unit then fails, and its `OnFailure` starts [an installed copy](vm/shields-up). Once the launcher's `verify` confirms the refusal, that copy raises the VM node's shields and those of the running session's node. A session whose init has not finished runs no `tailscaled` yet, so the copy leaves it alone, and the guard's failure a minute later raises its shields. The shields stay up until `bin/vm-up` restores the clone and `bin/tailnet-up` checks both nodes. On a clone that verifies, the copy raises nothing, so a session that breaks its own leg does not raise the VM node's shields. A guard that dies there before judging, for example after a signed commit breaks `lib/tailnet_node.py`'s import, leaves both nodes unjudged with their shields as they were, and `probe-boundary`'s `tailnet-guard-passes` fails. The session user runs the session's `tailscaled` and owns its Tailscale binaries, so a session process can lower that node's shields, change its settings, or replace the binaries the timer reads through; the timer then raises the shields again only while it still reads the too-wide policy. Against such a process the policy itself is the bound: the control server hands the session node's key only to the peers a grant connects to it, so no other node can send it a packet, shields up or down. [The pinned Tailscale release](lib/tailscale.sh) is installed by the VM setup and the session bootstrap, checked by SHA-256.

The session node runs tailnet-link unchanged: `tailnet-link setup`, then `tailnet-link PORT`, publish the session's files and dev servers under the pot's name. The session has no systemd, so [a session service](session/services.d/pots-links) starts tailnet-link's file server once setup has written its owner file. Setup needs a tailnet-link that installs no systemd unit where `/run/systemd/system` is absent and skips its routed self-check on a userspace node.

The session node's filter is the whole protection on those ports, not Serve. A userspace node hands every granted port without a Serve handler to the session's loopback, so the operator's devices reach any session listener on 443 or 10001-65535 other than 18791, served or not. No other user of the tailnet and no pot reaches a session at all. The operator's devices already administer the VM, so this opens nothing they could not reach. [The tailnet-links skill](https://github.com/walid-mos/agent-pi/blob/main/skills/tailnet-links/SKILL.md) names the one local port whose preview stays dead in a pot, 8791.

### Doors

A door carries one note from a pot's bot to another pot's bot. The caller runs `ssh -F /opt/agent-sandbox/session/door.ssh_config -- <pot>-host` with the message on standard input. [That client configuration](session/door.ssh_config) dials through the session's own node with [`tailscale nc`](session/door-dial), checks the door's pinned host key, and forwards nothing.

On the target VM, [a dedicated sshd](vm/door-sshd.conf), run by [its unit](vm/pots-door.service), listens on the VM's tailnet addresses only, port 2222, for the user `door` with keys only. The unit requires the firewall unit, so the door never listens without it: the firewall drops the door port on any other interface and resets a node's third concurrent connection. Each caller's key is bound to `restrict,command="/usr/bin/sudo -n /usr/local/sbin/pots-door CALLER RECEIVER ACCESS"`, where `ACCESS` is `ask` when the caller's `doors` name the receiver and `reply` when only the receiver's `doors` name the caller. The `door` account has no Docker access; [the door](vm/pots-door.py) runs as root only through the sudo rule [the key installer](vm/door-keys.py) writes with each key, naming that key's three arguments; the account may run the door with no other caller, receiver or access. It stops at the first failing step:

| Step | Exit |
| --- | --- |
| `tailscale whois` of the connecting address shows `tag:pot-<caller>` | 77 |
| The caller's lock is free, taken without waiting | 75, `pots-door: busy` |
| At most 16384 bytes | 65 |
| Strict UTF-8 without NUL; first line `request <caller>.<nonce> <hop>` or `reply <receiver>.<nonce>`, ended by LF, nonce of 8 to 32 lowercase letters and digits, hop one digit; a note that is not blank | 64 |
| A `request` comes only on a key bound to `ask` | 77 |
| The caller's delivery bucket holds a token: 10 at most, one back every 120 s. A knock the three steps above refuse spends from a refusal bucket of the same size instead, and gets this exit in place of its own when that bucket is empty, so refused knocks never use up the caller's deliveries | 75, `pots-door: rate` |
| The pot has a running session | 69 |
| The session's init has finished, checked without waiting, so the session user has the uid that owns the session's home | 70 |
| `pots wake --from pot:<caller> --note-file -` in the session, as the session user, does not refuse the message: its status 76 means it kept nothing and would refuse the same bytes again | 76, `pots-door: refused` |
| That command ends with status 0 within 45 s | 70 |

On success it prints `delivered <origin>.<nonce>` and exits 0. Every exit but 70 keeps nothing, and a 76 is final; after a 70 the session may hold the message, so the caller resends the same bytes under the same id. The session's output never reaches the caller. Exit 255 is ssh's own: no route, policy, connection limit, host key, key or forwarding refused.

`./bin/pots-doors POT...`, run from the operator's machine with every pot of the mesh, makes each session's caller key when absent and copies out only its public key. It installs on each VM the caller keys of the pots whose `doors` name that pot, bound to `ask`, and of the pots that pot's `doors` name, bound to `reply`; each session trusts the host keys of those same doors. A pot's key is on no other VM, so its knock at any other door ends with ssh's exit 255. Each run rewrites the whole mesh and refuses `doors` that name a pot outside the list or the pot itself, so a pot left out of the list loses its doors.

## Agent sources

Each session provisions the sources its sandbox selects under `sources`: the Pi harness (`pi`), the Herdr configuration (`herdr`) and the NextNode organization additions (`nextnode`), which Pi loads as an overlay only in a sandbox that selects them. [The source catalog](session/agent-sources.json) names each repository and its home-relative checkout. A private repository also names its `credential`, the vault name of the token that reads it, and that field alone marks a source private. The session fetches a selected private source with its token from the VM's vault broker, which serves the token only for a private source the sandbox selects. It clones a selected public source anonymously over HTTPS, and the broker refuses a token for it. Bootstrap runs [the provisioner](session/provision-agents), and [a session service](session/services.d/pots-sources) reruns it on a timer once bootstrap has started a first run. `./bin/session-refresh` runs it on demand.

- A refresh only fast-forwards `main` of a checkout whose tracked files are clean. A checkout on a task branch, with an edited tracked file, or with Git configuration that runs commands, stops the refresh and stays as it is.
- Installers run only after a successful refresh. The receipt `~/.config/agent-sandbox/provisioned.json` advances only after the installers of the selected sources succeed, so a failure retries on the next run.
- The service stops a run that outlives its time limit, so a stalled fetch or installer cannot hold the provisioning lock. The stopped run ends its running command and puts back the files it had set aside, and the next run retries.
- Auth, sessions, settings, model choices and Herdr registrations are never reset. Pi's and Herdr's own contracts say which files each installer owns.
- A source removed from `sources` is no longer refreshed, and Pi no longer loads `nextnode` as an overlay. Its checkout stays in the session home, at the catalog's `directory`: delete it by hand when a reused home must stop holding that copy.
- Herdr's desktop files, the shared mods, Pots and its terminal drawer, reach a session only after Herdr has started there once and written its key bindings. Until then a run installs Pi and Herdr's `headless` profile, and the first run after Herdr's start installs the `desktop` profile. `profile` in the private file, `desktop` or `headless`, overrides this choice, and `desktop` before Herdr's first start stops the run before anything changes.
- Herdr's attachment button opens a native file chooser, so a desktop session gets `zenity` when neither `zenity` nor `kdialog` is installed. A recreated container loses the package and the next run installs it again. A failed package installation fails the run and leaves Pi and Herdr installed.
- Private values live in `~/.config/agent-sandbox/provisioning.json`, never in the repository. A source's `url` replaces the GitHub address, which serves a local or staging origin.

### Switching a checkout to an unrelated origin

A source whose origin differs from the catalog stops with an error. `allowCutover: true` in the private `provisioning.json` lets the next run move that checkout to the new history in place: it fetches the new `main`, keeps the previous head under `refs/agent-sandbox/before-origin-switch`, resets with `--keep` so edited files stop it, then points `origin` at the new address. Untracked files, linked worktrees and task branches stay. An untracked file that collides with a tracked one in the new history stops the switch before anything changes.

For this checkout on a Mac, run `./bin/import-private OLD_CHECKOUT` from a clone of the new repository first. It copies the Git identity, the vault project and the sandbox configurations out of the old checkout into `~/.config/agent-sandbox`, and records the old revision. Then run `python3 lib/source_refresh.py NEW_URL OLD_CHECKOUT --allow-cutover` from that clone. The watchdog's own update keeps following `origin` afterwards. Each VM's clone has its own origin, and the switch leaves it as it is.

## Daily operations

Start Herdr once so it creates its configuration, then install the Pots pane and the login watchdog from the Mac checkout:

```sh
./bin/install-herdr
./mac/install-watchdog
./bin/check
herdr-app check "$HOME/.config/herdr-app/mods/command-center"
herdr-app check "$HOME/.config/herdr-app/mods/pots"
herdr-app check "$HOME/.config/herdr-app/mods/pots-terminals"
```

`herdrEnabled: true` in the Mac's private `provisioning.json` makes `./bin/install-herdr` install the common Herdr source from the catalog instead of this checkout's `herdr/` folder. It refreshes that checkout the way a session does, then runs its installer with the sandboxes this Mac configures. On the Mac that fetch reads no Git configuration and so no credential helper: the catalog's repository has to be public, or `sources.herdr.url` in the private file has to name an address SSH can read. `herdr` in the same file adds runtime values that installer reads, such as `usageMachine`. A Mac where Herdr has never started stops the command before anything changes.

The Pots pane is its own Herdr mod, `pots`, drawn with Command Center's components and theme, and its terminal drawer is a second mod, `pots-terminals`. The installer writes both mods and switches no layout. Herdr restricts relative imports to one mod folder, so the installer copies Command Center's `ui.js` and `state.js` into each. The pane draws no heading. It publishes its bot, state and model under the shared key that `state.js` names, and Command Center's Principal heading shows them. Copy the complete `command-center`, `pots` and `pots-terminals` mod folders together when syncing another Mac, then check each there.

[The watchdog's first step](mac/update) keeps the pane current with no command typed. Every minute, on a checkout that is on `main`, it fetches `origin/main` and fast-forwards to it when a key in `~/.config/agent-sandbox/trusted-signers.asc` signed the fetched tip, then runs the installer. The installer writes only the files whose content changed, and Herdr redraws the pane when one does, with no restart. A merge into `main` therefore shows in the pane about a minute later. On any other branch the step leaves the checkout where it is and installs that branch's pane. A checkout that cannot fast-forward, because it holds a commit of its own or an edited file the merge touches, or whose fetched tip lacks that signature, also stays where it is, and the watchdog's log says why. The operator's Herdr config sync then carries the installed `command-center`, `pots` and `pots-terminals` mods to their other Mac. It leaves out a file named like a credential, so `./bin/check` refuses such a name under `herdr/`.

The pane talks to one sandbox's bot at a time. The installer writes each sandbox's machine and bot name into the mod, so a sandbox added or a bot renamed shows in the pane after the watchdog's next run. With more than one sandbox, the pane shows a tab per bot above the conversation: the Mastermind's first, then the others by sandbox name. The pane opens on the Mastermind until you choose another bot. The chosen bot's conversation, workers, routines and gateway fill the pane, a message goes to that bot, and Open and Stop act on that sandbox's workers. Each bot keeps its own draft and its own messages on their way. Herdr remembers the choice on each Mac. `herdr-app do pots.switch` moves to the next bot, and a key can be bound to it.

Terminal, at the start of the control bar under Principal, opens a resizable pane to the left of the conversation. One click opens the pane with a focused shell: on the Mac the first time, afterwards on the last computer you chose. Choosing a computer in the pane's picker opens a shell there, and New adds another on the chosen computer. The picker reads the Mac's Herdr machines, including sandboxes registered during bootstrap, and keeps the last choice independently of the bot tab. An unavailable computer stays unavailable rather than opening a shell elsewhere. New inherits the focused shell's folder when it belongs to that computer, otherwise it starts at home. Each shell has its own native terminal, stacked vertically with draggable boundaries. Hide returns focus to the conversation without ending any shell. End asks for a second click before terminating that shell. The layout keeps the pane's visibility, width, split sizes and terminal addresses across app restarts. A lost kept terminal returns as a shell in its last folder, as Herdr specifies, and does not restart its previous program.

The installer adds Cmd-T to show or hide the pane (the same key hides it again), Cmd-Shift-J for a new shell and Cmd-Alt-J to focus the next shell, scoped to `command-center-pots`. It leaves a shortcut another action already holds untouched, which is why the pane does not use Cmd-J: Command Center binds it. A `keys.json` that is not valid JSON is left alone and reported once on standard error, and the shortcuts are bound on the first run after it is fixed. The commands also work from a terminal: `herdr-app do pots.terminal`, `herdr-app do pots.terminal-new` and `herdr-app do pots.terminal-next`. `herdr-app do pots.terminal-machine` opens the computer picker from the keyboard. Shell keys, including Escape and Ctrl-C, go to the terminal program. A popup computer picker takes Up, Down and Enter, with Escape to dismiss it.

Five toggles sit above the conversation: Workers, Recent wakes, Routines, Pots children and Gateway. Each one shows or hides its section, and the Workers toggle carries the chosen bot's worker count. Every toggle starts off, so the conversation takes the full width. The sections that are on stack in a sidebar to the right of the conversation, or under it when the pane is narrow. A narrow pane with several bots also moves the toggles to their own row under the tabs. Open and Stop in the Workers section act on the chosen sandbox's workers. Open shows only for a worker whose terminal runs. The toggles keep their state when the bot changes. Herdr does not store them, so they start off again each time the pane loads.

A worker that waits on Pi's `ask_user_question` in its terminal shows that question under its row in the Workers section: each question with its options, and a field for an answer of your own where the question takes one. The Workers toggle counts the workers asking. Answer hands the choices to `control.mjs answer-dialog`, which reads the open question from the worker's Pi session file, the one its terminal's `pi.session` label names, and presses in its terminal the keys a person would press. The row then shows for a minute what the worker received. Those keys start from the question as it opened, so a questionnaire resumed after Discuss, with answers from the terminal, is left to the terminal. So is a secret the worker asks for, and any other dialog: the row says what it waits for, and Open is where to answer it.

The conversation reads in one centered column: your messages are bubbles on the right, and the bot's replies are plain text under its name. The composer is a card under it, with Attach on the left and a round send button on the right. In the composer, Enter sends and Shift+Enter breaks the line. A file chosen with Attach, which opens the Mac's file chooser, a file dropped on the conversation, or an image or Finder file pasted into the composer, leaves with the next message. A sent image shows in the conversation as a thumbnail while the pane stays open; after a reload the message names its files. Each file is at most 8 MB, `hc`'s limit on standard input, and a message carries up to eight. A sent message shows at once and leaves one after another. `control.mjs send` writes it straight into the bot's terminal channel, as `pots chat` does, so the composer never waits for an answer, and a message written while the bot is down waits there until it starts. One that fails stays in the conversation with Retry and Edit, and a message behind it waits rather than overtaking it. Edit puts the message back in the composer, and leaves it there untouched while the composer holds text of its own. While the bot owes an answer, a working line counts the time and the pane looks every second instead of every five. The latest message, and any message under the pointer, offers Copy. A reply also offers What it did, which lists the model calls and tool calls `pots trace` recorded for it since the reply before it.

The composer also runs `/model` and `/route`, typed alone on one line with no file. Without a target they act on the bot: `/model MODEL` writes the `model` of its `bot.json`, which pots applies within seconds, `/route GROUP` sets it to that Magpie group, and `/route auto` puts it back on `magpie/group/router`. `/model @BRANCH MODEL` and `/route @BRANCH GROUP` type the command into that worker's Pi with `hc send`, and Pi runs it at once, also in the middle of a turn. `@` takes a worker's branch, title or name, or any part of one that no other worker shares. While the draft holds a command, the line beside the send button says what Enter runs and for whom, and once it ran, the line above the composer says what changed. `/model` takes the `enabledModels` of the harness's `settings.json`, because Pi opens its picker for any other model; `/route` takes the members of `magpie-routing.json`, and `auto`. A short name such as `max` stands for the only choice that ends with it, and either command with no argument lists its choices. A command runs at once and does not wait behind messages on their way. Any other text, a command the pane does not know included, goes to the bot as a message. A worker's `/route` pin stays in its session, while its `/model` lasts until its terminal restarts on the model its record names.

A reply that carries a `question` block, written as [the pot rules](session/pot/AGENTS.md#questions) say, shows its options as buttons under it, and `control.mjs` keeps the block out of the reply's text. A click on an option sends its label as your message. When the question lets you pick several, each option has a box, and Send sends the picked labels one per line. You can answer in the composer instead. Once you answer, the question shows as answered with your picks checked and takes no more clicks: at once when you click, and as soon as a typed message is on its way. A message that fails answers nothing, and a click whose message fails stays answered, with Retry and Edit under it. Saving secrets the bot asked for answers no question.

A layout shows the pane with a `{"mod": "pots"}` block. `command-center-pots` is the Command Center layout with that block where the Principal terminal sits, and Command Center's navigation knows that layout by this name. Derive it on each Mac from that Mac's own layout, give it the same keys, then switch to it:

```sh
config="$HOME/.config/herdr-app"
jq '(.. | objects | select(.id? == "principal-chat")) |= (.id = "principal-pots" | .content = {mod: "pots"})' \
  "$config/layouts/command-center.json" > "$config/layouts/command-center-pots.json"
jq '."layout:command-center-pots" = ."layout:command-center"' "$config/keys.json" > "$config/keys.json.next"
mv "$config/keys.json.next" "$config/keys.json"
herdr-app do layout.switch '{"name":"command-center-pots"}'
```

The same last command with `command-center` returns to the Principal terminal.

The watchdog starts at user login. Every minute it brings the checkout and the pane up to date, as described above, then checks, for every sandbox under `sandboxes/` on the `colima` provider, that its VM and its SealSkin server are running. Before the sandboxes, [it removes](mac/retire-forwards) the Mac's tailnet forwards of ports 2223 and 2224, which led to the retired Colima VMs, once nothing listens behind them. It therefore creates the VM of a directory added there. A sandbox on another provider is left to the keeper of its own VM. Its LaunchAgent configuration comes from [the installer](mac/install-watchdog). Loading the agent with the VM stopped brings the VM and its server back, and the VM's keeper the session, which is the path a login takes. A real Mac reboot has not been exercised.

Each VM keeps its own session. `pots-keeper.timer` runs [the keeper](vm/keeper) every minute: it runs `pots-session ensure`, then keeps Magpie at [the bootstrap pin](session/bootstrap), once the session's init has finished (below). It does not update the session's tools, mint credentials or rebootstrap the session. Docker and the timers start with the VM, so a stopped session or a restarted VM comes back within a minute. `pots-update.timer` fast-forwards `/opt/agent-sandbox` every five minutes on the branch the clone is on, with [the refresh](lib/source_refresh.py) the sessions use for their sources. A clone with an edited file, on no branch, or with Git configuration that runs commands stays as it is, and so does one whose fetched tip no operator key signed. `journalctl -u pots-update` in the VM says why. The units run the clone's scripts in place, so a fast-forward reaches the keeper with no reinstall. A changed unit file, launcher, firewall or Sysbox version waits for the next `./bin/vm-up`.

Root in a VM runs the clone's code only through [the trusted launcher](lib/trusted_source.py), which [`./bin/vm-trust`](bin/vm-trust) installs from the Mac checkout at each `vm-up`. It lands at `/usr/local/lib/agent-sandbox`, outside the clone, and the operator's public key at `/etc/agent-sandbox/trusted-signers.asc`. Before it runs a script, the launcher requires every path of the clone to be root-owned and writable by root only, its Git configuration to hold nothing that runs a command, no edited or untracked file, and a `HEAD` that a key in that file signed. The script must be a file the clone tracks. The keeper, the update, the vault broker, the tailnet guard, the VM node's tailnet commands, `pots-session`, `store-config`, the VM setup, the session keys and every forced command go through it. That guarantee rests on the clone and the launcher: the clone is root-owned, clean and at an operator-signed tip, and every root path into it in this tree goes through the launcher. [`./bin/check`](bin/check) adds [the root-call check](lib/check_vm_root.py), a tripwire for a regression written in the call spellings this repository uses, not a proof that no other spelling reaches VM root. It reads files ending in `.sh` or whose first line is exactly `#!/bin/sh` or `#!/bin/bash`, directly or through `/usr/bin/env`, and unit files ending in `.service`, `.socket`, `.timer`, `.path` or `.mount`. A unit line may not name the clone's path as written, and each `Exec` line, however spaced or prefixed, must start the launcher or an installed copy under `/usr/local/sbin`, with no `..`. A call written `sandbox_vm ...` or `.../vm-exec ...` counts as VM root, with or without `sudo`, since the Proxmox provider reaches the VM as root. Past `sudo`'s user, non-interactive and listing options and `env`'s assignments, the call must run the launcher, an installed copy or a literal command from the check's list of VM management commands, and a `find` among them may run only such a command. A variable command, an interpreter, any other `sudo` or `env` option, a `colima ssh`, `limactl shell`, `qm guest exec` or `ssh ... root@` line outside the providers, and a launcher path assigned outside `lib/sandbox.sh` are refused. The one exception is `./bin/vm-exec`'s own `sandbox_vm "$@"`, the operator's command line. Outside its coverage: Docker daemon operations, which run as root in the VM (`sandbox_docker` and the arguments of a listed `docker`); the values `env` assigns, a loader path included; VM-side installs, meaning where a listed `install` writes and what a script running as VM root, such as `vm/setup.sh`, places under `/usr/local/sbin`, a link to the clone included; transports spelled otherwise, such as a quoted or variable function name, `eval`, another `colima` or `ssh` form, or a Lima ssh config; and unit drop-ins under `*.service.d/`, a clone path written with `//` or `/./`, and a shell script whose shebang carries flags. GitHub's verified badge is not an operator signature: only the keys in that file count.

No session reads the Mac checkout, so switching its branch changes no running session. The Mac still reaches each sandbox through the checkout's scripts, so a branch whose scripts predate this layout cannot reach the sandboxes until the branch is back.

Run the following from the Mac checkout:

```sh
./bin/pots-session name
./bin/pots-session ensure
./bin/sandbox-exec /opt/agent-sandbox/session/with-vault pots status
./bin/sandbox-exec hc ls --all
./bin/probe-boundary
```

`name` prints the running session container name, or nothing. `pots-session` runs in the VM: from the Mac it hands its command to the VM's clone through `sudo`. `ensure` launches a session if none is running, once the VM shows no path of the Mac. `ensure` and `restart` hold one lock in the VM, `/run/pots-session.lock`, so the keeper's check waits for a restart to finish and never launches a second session on the same home. `sandbox-exec` runs a command as the session user and fails when no session exists. Every command that the scripts run in the session as the session user, `sandbox-exec`, the keeper and `session-bootstrap` included, first waits inside its one `docker exec`, for up to a minute, until `s6-rc -a list` shows the image's `init-services`. That init gives the session user its uid and gid, and `usermod` cannot change them while a process runs as that user, so a command started earlier would leave the session unable to write its home. A session whose init has not finished within the minute fails the command before anything runs as the session user, and the message says which log to read. Use `pots status` for the gateway and bot state, and `hc ls --all` for worker terminals.

[The server image](sealskin/compose.yaml) and [the session image](session/launch.env) are pinned by digest, and SealSkin's hourly image pull is off for the session app. Change the session image by committing its new digest in `session/launch.env`, then run `./bin/pots-session restart` (after `./bin/sealskin-apply` for SealSkin). Change the server image in its compose file and rerun `./bin/sealskin-up`.

After changing the app template or installed app configuration, apply it before recreating the session:

```sh
./bin/sealskin-apply
./bin/pots-session restart
./bin/session-bootstrap
```

Reapply VM firewall changes with `./bin/vm-up`. Each run replaces the rules in one transaction.

Docker requires the firewall unit. Never stop or restart `pots-firewall.service` by hand, because systemd then stops Docker and every container with it. `sudo systemctl start pots-firewall.service` reloads the rules and touches nothing else.

The unit is a oneshot, so `systemctl is-active pots-firewall.service` answers `inactive` once its run has ended. That is its healthy state, and a run that failed answers `failed`. To check the firewall, read `systemctl show docker.service --property Requires`, which must name the unit, and `sudo iptables -S DOCKER-USER`, which must list the `DROP` rules.

To stop the Pots session deliberately, stop the VM's keeper first so it will not recreate the session:

```sh
./bin/vm-exec sudo systemctl stop pots-keeper.timer
./bin/pots-session stop
```

`sudo systemctl start pots-keeper.timer` in the VM, the next `./bin/vm-up` or a VM restart brings the keeper back.

Stopping the session leaves the SealSkin server and Colima VM running. The named Pots home and inner Docker volume hold persistent state. `restart` stops and recreates the session.

A recreated session, or a restarted VM, comes back as follows.

| Part | After the restart |
| --- | --- |
| Router | Starts on its own with its keys and its Claude account, with no seed |
| Gateway and watcher | Start on their own, with no bootstrap |
| Bot | Keeps its conversation and answers again |
| Unfinished worker | Queued once for a resume in a new terminal, then idle until the bot instructs it |
| Completed or stopped worker | Stays closed |
| Containers of a development stack | Kept but stopped. Start their Compose project again |
| Desktop | Starts with the session, and stops after 60 seconds with no client attached |
| Development tunnels on the Mac | Gone. Start them again |

The desktop UI after a restart is unchecked. Rerun the boundary probe after lifecycle changes.

## Model router

Each session runs its own Magpie router as the `pots-router` service, on the session's loopback address. The bot and the workers call it, and the firewall keeps every sandbox off the Mac's Magpie. The router accepts any key because it listens on loopback only, so [the session environment](session/lib.sh) sets `MAGPIE_API_KEY` to a fixed word.

[The bootstrap script](session/bootstrap) installs Magpie and Claude Code at pinned versions. The router answers for Claude models by running that Claude Code. Bootstrap also points the harness clone's `models.json` at the router, which leaves that clone one line away from its remote. [The provisioner](session/provision-agents) sets that line aside while it fast-forwards the clone, then puts it back, and stops on any other edit of the file.

Bootstrap seeds the router. Seed it alone from the Mac checkout while the Mac's Magpie holds the wanted groups and rules:

```sh
./bin/router-seed
```

The seed remains the source of provider definitions, groups and rules. It copies no key or sign-in. Rerun it when those definitions change on the Mac. [The restore step](session/router-restore) applies the seed, runs the same credential sync as the launcher, and verifies exact Claude and Sol answers.

Credential production stays outside Magpie. The human stores the Claude setup token in Infisical, and the external Codex publisher stores its access-only publication there. [One table](session/router-credentials.mjs) names each provider, its vault location and its Magpie input. The sync asks the VM's vault broker for the entries of that table the sandbox lists under `secrets` or `onRequest`, the Codex publication included, and the Magpie commands it runs receive no GitHub token and no vault access.

The consumer imports API keys with `magpie provider keys PROVIDER add -` and the Claude setup token with `magpie accounts import claude /dev/stdin --yes`. Values travel on stdin. Existing keys are skipped, and Magpie retains previous imported keys and setup-token accounts under its native routing rules. The sandbox does not generate or renew either subscription credential.

For Codex, [the adapter](session/router-codex.mjs) validates the publication and atomically writes its private `auth.json` under `~/.local/state/agent-sandbox/codex`. Its ownership, symlink, account-ID and expiry checks prevent an invalid publication from replacing the file. Only the router sets `CODEX_HOME` to that directory. Magpie [documents that file-discovery interface](https://github.com/yetone/magpie/blob/v0.1.4340/docs/subsystems/providers-accounts.md), and its [reference](https://github.com/yetone/magpie/blob/v0.1.4340/docs/reference.md#signed-in-agents-as-providers) says it reads the agent's credentials each time. Acceptance of this access-only file without an ID token is verified behavior, rather than a documented minimum schema.

[The launcher](session/router.mjs) runs the shared sync at startup and on refresh. The gateway starts listening first so a slow vault read does not make the watchdog restart it. Each provider syncs on its own: a missing or failing credential is reported and skipped, the others still import, and the round retries after one minute. Its schedule follows the publication expiry, and failures retry without stopping the gateway. This also lets a first installation wait for its seed. A stale Codex publication cannot replace the previous file, and an expired access token cannot be renewed in the sandbox. Existing Codex and Pi sign-ins stay outside the managed directory.

On every check, the VM's keeper compares both the installed Magpie and the running gateway against [the bootstrap pin](session/bootstrap). A mismatch installs the verified binary with `--router-only`, replaces the executable atomically, and restarts only `pots-router`. The next start imports fresh vault values. The upgrade keeps the same home, sign-ins, provider definitions and groups, without restoring the seed again. The keeper retries an incomplete upgrade on its next check, and a failed attempt leaves no download behind: the bootstrap removes the staging directory of the install it was running when it exits. No manual Mac command or restart of Principal, Factory, the Pots gateway or the worker watcher is required.

## The bot and its Pi workers

Each sandbox has one bot, named by its `bot` key. It uses `magpie/group/router` for coordination, and the Pots gateway runs it through the session's service supervisor. Pi workers start on `magpie/group/router`, or `magpie/group/max` when the person asks for it, and use the installed Pi harness and separate Git worktrees under the session's `/config/Development`.

A pot's bot follows [the work center's instructions](session/bot), and the Mastermind's bot [its own](session/mastermind). Every bot of a pot also loads [the pot rules](session/pot/AGENTS.md), which bootstrap links at `~/.pots/AGENTS.md`, above the bots' folders and outside the workers' `/config/Development`: questions, doors and reports from a Mac. These instructions are the same in every sandbox. Bootstrap links them into the bot's folder, so the bot reads them and cannot edit them. Change them in this repository. What differs between sandboxes is data. `owners` limits the repositories, and `rules` names an instruction file that bootstrap links at `/config/AGENTS.md`, where Pi loads it for the bot and for every worker.

A sandbox for a client uses `rules` for the client's own instruction file, which can make every push wait for the person's yes. The yes is a rule that the bot and the worker follow, and the sandbox's token can push without it. The bot asks before a start, because the start pushes the branch to open the draft PR. It asks again when a worker stops with unpushed commits, then sends the worker the yes for that one push.

The bot starts and reaches workers itself. To do it by hand, create a brief or a message file inside the session, then run this from the Mac. The dispatcher identifies the repository explicitly when looking up its default branch.

```sh
./bin/sandbox-exec /opt/agent-sandbox/session/with-vault node /opt/agent-sandbox/session/dispatch.mjs start NextNodeSolutions/REPOSITORY docs/task-name /config/task.md
./bin/sandbox-exec /opt/agent-sandbox/session/with-vault node /opt/agent-sandbox/session/dispatch.mjs send WORKER /config/message.md
```

`send` pastes the message into the worker's live terminal. A worker whose terminal has closed, or that was stopped, comes back in a new terminal with its conversation and reads the message there, once a slot is free.

The dispatcher accepts repositories under the sandbox's `owners`. It clones or fetches the repository, creates a new branch and worktree from the default branch or an optional final base argument, opens a draft PR, and queues the worker. `start` prints the worker's record with `ahead`, the requests queued before it, and `maxWorkers`. Branches must use a supported prefix such as `feat/`, `fix/`, `chore/`, `docs/`, `refactor/` or `test/`, followed by lowercase letters, digits or hyphens. The worker takes its name from the repository and the whole branch, shortened with a digest when the name exceeds hc's limit. A dispatch whose worker name already has a record is rejected before the clone, the worktree and the draft PR. An existing worktree is rejected. A later failure can leave the clone, worktree or draft PR behind, so inspect those before retrying.

Gateway and watcher wrappers wait indefinitely if their prerequisites are missing at service start. Bootstrap restarts both after installing prerequisites. Check their status before relying on automatic reports.

Worker briefs and records live under `/config/.config/agent-sandbox/workers`, and the requests of `start` and `send` wait in its `queue` folder, one file each, named by the time they came. The watcher launches Pi through `hc` for the oldest request while fewer than `maxWorkers` workers have a live terminal. A request for a stopped worker leaves the queue. A launch that fails wakes the bot once with the status `not started` and the reason, and its request leaves the queue. A message for a worker that has not shown a status yet waits in the queue until it does. The watcher follows `hc events` and looks at the workers when a terminal starts, ends, or changes status or turn, so it runs no command while nothing changes. It reopens the stream five seconds after hc's core restarts. It wakes the bot with the worker's title, branch, commit, uncommitted-path count, unpushed-commit count, clean-pass record and PR URL. When a worker reports `done`, the watcher writes its screen to `NAME.screen` beside its record and names that file in the note, then ends and removes its terminal, which frees its slot. A message that started a new turn meanwhile keeps the terminal open. Any other end of a worker's terminal, a stop, a crash or a resume, also keeps its screen in that file and removes the terminal, so hc lists no finished worker terminal. It marks a worker complete only when its status is `done`, its worktree is clean and no commit is missing from `origin`. That signal does not verify PR checks or a merge. A lost unfinished worker is queued for a resume once per watcher process. A terminal that just started is never treated as lost, because the vault login shows no agent status at first. A completed, closed or stopped worker is relaunched only by a `send`, with its conversation. A stop is a `NAME.stopped` file beside the worker's record, which a `send` removes, and the watcher ends any terminal of a stopped worker that it finds running.

A thread outside the pots reports to the Mastermind through its Herdr machine, from either Mac. The Mastermind reads the note and tells the person in the Pots pane. A report starts no work. `--from` accepts letters, digits, `-` and `_` only, so the thread's title opens the note.

```sh
hc exec --on mastermind pots wake --from mac-thread --note "$thread_title: $report"
```

## Mastermind

The Mastermind is the pot whose `sandbox.json` sets `role` to `mastermind`, as [its example](sandboxes.example/mastermind/sandbox.json) does. It is the person's single point of entry: its bot hands each request through a door to the pot that owns the domain, follows it and reports. It owns no domain. Its `owners` is empty, so the dispatcher refuses every repository and bootstrap creates no Factory bot. Its secrets are only the router's model credentials. The person can still talk to any pot in its own tab.

## Pots and doors

A pot reaches another pot only through that pot's [door](#doors), which hands each message to `pots wake --from pot:CALLER --note-file -` in the session, as the session user. `doors` in `sandbox.json` names the pots this one may ask. [The pot rules](session/pot/AGENTS.md) tell each bot how to ask, how to reply, and that a neighbour's note is a request it may refuse, never an order from the person.

```sh
/opt/agent-sandbox/session/pots ask POT --need "TEXT" [--for REQUEST_ID]
/opt/agent-sandbox/session/pots reply REQUEST_ID --text "TEXT"
/opt/agent-sandbox/session/pots resend REQUEST_ID
/opt/agent-sandbox/session/pots requests [--all]
```

Run these four commands by their full path because the package's `pots` can come first on a bot's `PATH` and does not provide them. Usage and error hints derive the wrapper's full path in [`door-command.mjs`](session/door-command.mjs). `pots wake`, `pots status` and the package's other commands stay bare.

[The session's `pots`](session/pots) runs these four and the door's exact `wake`, through [`doors.mjs`](session/doors.mjs), and hands every other command, `wake --from mac-thread` included, to the installed `pi-durable-bot`. `ask` signs its request ID with this pot's tailnet name, saves the request as `unknown`, then knocks on the neighbour's door, and `reply` does the same with its reply. Only a door exit that keeps nothing (64, 65, 69, 75, 77) makes it `undelivered`. Exit 76, the neighbour's session refusing it, makes it `refused`: closed, out of `requests` without `--all`, and refused by `resend`, since the same message would be refused again. A timeout, a cut line, a failed wake and any other exit leave it `unknown`, because the neighbour may hold it. `resend` sends either again under the same ID, byte for byte, and the neighbour takes a message it already holds as a no-op, so a resend never starts the work twice. The record keeps a fixed reason for each exit, never what the door or the neighbour printed.

A request carries a hop count: one past the deepest request this pot received and has not answered, 0 when there is none. While a request that already came through three doors waits for this pot's reply, `ask` refuses, with or without `--for`, and the receiving pot refuses a request beyond two hops, so pots asking each other in a loop stop at the third door. `--for` only names the received request the new one serves, and the reply's wake names it back. How often a pot may knock is the door's limit, in the VM, where a compromised caller cannot skip it.

Each request is a JSON file under `~/.config/agent-sandbox/requests`. A delivery wakes the bot with a JSON note only once it is saved, and a delivery whose wake fails is removed again. The session refuses a request in another pot's name, a reply to a request this pot never asked, a second different reply, a 21st unanswered request from the same pot, a request beyond two hops, and a message over 16 KiB, empty, holding a NUL byte or not UTF-8. Each of those refusals exits 76, which the door passes on as its own exit; a failed wake, the lock held past 30 s and any other failure exit 1, which the door reports as 70. A reply only closes a request, so it can never open one. Deliveries, and the changes `ask`, `reply` and `resend` make, run one at a time under `flock` on that folder, so parallel knocks cannot pass the cap or save two texts under one ID. [`probes/door-deliveries.sh`](probes/door-deliveries.sh), which `./bin/probe-boundary` runs in the session, sends those forged deliveries through the command the door runs and checks each is refused and leaves the requests unchanged. In a scratch home, it also checks that a pot holding an unanswered request at the end of a chain asks nothing.

## Pot cloud

Bootstrap's last step runs [`cloud.mjs`](session/cloud.mjs), which runs `tailnet-link setup` in the session: the pot serves its own `~/Public/deliverables` and its dev servers under its own tailnet name, and rerunning it is safe. The step comes last because it needs the pot's tailnet node. `tailnet-link` never receives `TS_AUTHKEY`, so it cannot join a node of its own.

On the Mastermind, the step also writes `~/Public/deliverables/pots/index.html`, which links and frames the root page of every pot that `doors` names, the Mastermind's first. Each root page lists that pot's files and servers live, so the index holds no copy. The step prints the index's address, and `tailnet-link ~/Public/deliverables/pots/` prints it again.

## Clean pass

A worker whose task builds a feature or changes a lot of code runs `/untangle-codebase`, `/code-review` and `/simplify` before its final report, as [its guide](session/clean-pass.md) says. Each pass is Claude Code running the real command in its own terminal, in the worker's worktree, on the person's Claude account. That traffic goes to Anthropic and not through the router, and an empty Claude quota stops the pass.

```sh
node /opt/agent-sandbox/session/clean-pass.mjs untangle AREA
node /opt/agent-sandbox/session/clean-pass.mjs review
node /opt/agent-sandbox/session/clean-pass.mjs simplify
```

[The command](session/clean-pass.mjs) runs from the worktree and opens one pass. It starts Claude Code through `with-vault --with claude`, so the Claude token reaches that terminal and no worker terminal. A pass reads [its settings](session/claude/settings.json), the untangle skill of the harness and its trusted folders from `/config/.config/agent-sandbox/claude`, apart from the home the router's Claude Code uses. Those settings let it run every tool without asking, which the sandbox is there to contain.

The command records the commit each pass started on in `NAME.passes` beside the worker's record, and the watcher's report carries that record. The worker marks its own pull request ready once its work is finished and tested, as [its guide](session/clean-pass.md#ready-for-review) says. The bot puts a pull request back in draft when it lacks the clean pass it owes, or holds it there while it must not merge.

## GitHub authentication

[The session wrapper](session/with-vault) asks [the VM's vault broker](vm/vault-broker) for the secrets its sandbox names and injects them. Those are the token of each owner from `/tools/github` and the names listed under `secrets`. `with-vault --with GROUP` adds the names of that group under `onRequest`, for the one command that needs them. A listed name that the vault lacks stops the command.

The broker runs as root in the VM and is the only reader of the Agents Sandboxes identity. Its socket, `/run/pots-vault/vault.sock`, is bound into the session. It answers for the names the VM's `/etc/agent-sandbox/sandbox.json` lists, for one listed name, or for the token of a private catalog source selected under `sources`, and refuses any other request without reaching the vault. It follows no vault redirect, refuses a name starting with `INFISICAL_`, and its refusals and log carry names, never values. The wrapper removes every `INFISICAL_` variable from the command's environment, so no wrapped command holds vault access. The injected values still reach every child of the command, and a tool that writes its environment into a log or an error report leaks them. Keep them out of app containers by passing their variables by name, as [Development services](#development-services-and-memory) describes.

The GitHub CLI wrapper selects a credential by repository owner, from the sandbox's `owners`. Git uses the same selection through an HTTPS credential helper with `useHttpPath` enabled. Only variable names belong in a sandbox's file and in documentation. Use HTTPS Git remotes and supply the repository to `gh` with `--repo`, a `repos/OWNER/REPOSITORY` API endpoint or `GH_REPO`. Otherwise, the wrapper uses the current checkout's `origin`. Outside a checkout, it reads the owner from a GitHub URL argument, such as a pull request's. Unsupported owners and missing credentials fail explicitly.

This read-only probe checks API access and HTTPS Git access for the repositories it is given:

```sh
./bin/sandbox-exec /opt/agent-sandbox/session/with-vault sh /opt/agent-sandbox/probes/github-owners NextNodeSolutions/agent-sandbox walid-mos/dotfiles
```

The probe reports repository identity, push permission and a HEAD commit without printing tokens. Access does not authorize a push. A wrapped command receives the tokens of its own sandbox's owners and no other.

## Development services and memory

The session's Docker daemon is separate from the VM daemon used by SealSkin. Give each worktree its own Compose project and published ports. Keep overrides and application environment injection outside client repositories. Pass application variables by name into app containers, excluding unrelated provider, GitHub and vault credentials. Client push rules still apply.

The watcher stops the Compose projects of a worker's worktree once no live hc terminal has had its folder in that worktree for `idleStackMinutes`. It finds them by their `com.docker.compose.project.working_dir` label, at or under the worktree, runs `docker compose -p PROJECT stop` from `/`, and removes no container and no volume. `docker compose start` brings a project back, and each worker's brief says so. The clock starts when the watcher starts or the worktree's last terminal ends, and a terminal in the worktree resets it. A project outside every worker's worktree keeps running.

A development server in the session gets its link from the session's own tailnet node: run `tailnet-link PORT` in the session, as on any machine. The link names the pot.

### Load

```sh
./bin/pots-load --seconds 30
```

[The load command](session/load.mjs) measures the running session over a window, 10 seconds unless `--seconds` says otherwise, and prints one JSON line. Inside a pot, `node /opt/agent-sandbox/session/load.mjs` prints the same line. The session reads its VM's `/proc`, so the CPU, pressure and memory figures are the VM's as the session sees them.

| Field | Meaning |
| --- | --- |
| `schema` | 1. A field that changes meaning raises it |
| `bot`, `at`, `windowSeconds` | The sandbox's bot, the end of the window in UTC, and its length |
| `cpu.busyPercent`, `cpu.iowaitPercent`, `cpu.stealPercent` | Shares of all vCPU time over the window, from `/proc/stat`: running, idle with a read or write pending, and taken by the hypervisor |
| `cpu.load1` | The one-minute load average |
| `pressure.cpu`, `pressure.io`, `pressure.memory` | `/proc/pressure`. Under `some`, at least one task waited for the resource, and under `full`, every task did. `avg10`, `avg60` and `avg300` are the kernel's averages in percent, and `windowPercent` is the share of this window |
| `memory` | `totalKiB`, `availableKiB`, `swapTotalKiB` and `swapFreeKiB` from `/proc/meminfo`, and `sessionKiB`, what the session container holds |
| `terminals` | hc's `live` and `finished` terminals, and `workersLive` and `workersFinished` among them |
| `containers` | The `running` and `total` inner containers, and under `composeProjects` each Compose project with its own `running` and `total` |
| `unavailable` | Each part that could not be read, with the reason. Its fields are `null` |

CPU wait is `cpu.iowaitPercent`, and `pressure.io.some.windowPercent` is the share of the window in which a task waited on a disk. Compare two runs of the same length, taken under the same work.

### CPU

The pane's requests, the bot and the session's Herdr keep the default CPU priority, and worker jobs run behind them. A worker, a clean pass and the processes they start run at niceness 10, set where [their terminal opens](session/workers.mjs). The session user can lower a priority and cannot raise one, so the workers step down. Inner containers, the PR factory's check containers among them, all run under one cgroup. [The Docker service](session/services.d/docker) gives that cgroup a CPU weight of 10 against the session's 100 when it starts, so a running session takes a changed weight at its next restart. A weight on one container, such as `--cpu-shares`, only ranks it among the other containers. Neither setting caps a job: a worker alone on idle vCPUs runs at full speed.

### Desktop

The session's desktop, XFCE with every window opened in it, Herdr's among them, runs only while a client watches its stream. [The desktop service](session/services.d/pots-desktop), which s6 runs as root, reads the kernel's TCP table every two seconds for an established socket on 127.0.0.1:8082, where nginx hands the stream to Selkies. A check starts no process. A client that attaches starts the desktop at the next check, and its autostart entries run again. Sixty seconds with no client stops it: s6 ends the desktop and every process under it, and the service ends the session bus and accessibility bus the desktop leaves behind. Save your work in a desktop window before you leave it.

Xvfb, Selkies and nginx keep running, so a client connects at once and sees the desktop a few seconds later. The hc core leaves the process tree of whatever starts it, the desktop included, so the bot, the workers and the Pots pane, which reaches the session through hc over ssh, keep running while the desktop is down. The X display stays up for a worker's browser or test runner.

### Memory

The VM never gives memory back to the Mac. Apple's balloon device does not offer free-page reporting and Lima never inflates the balloon. The Mac footprint of the virtualization process grows until it reaches the VM's memory cap, then stays there. Memory that Linux reports as free or cached is not memory the Mac recovered.

The only lever is a lower `vm.memoryGiB` in the sandbox's file. Apply it with `colima stop --profile "$SANDBOX"`, then `./bin/vm-up`. That restart stops the session and every worker in it.

[The memory command](vm/memory.py) reports guest memory, the live balloon features and the balloon counters. Compare its output with the `footprint` of the Mac virtualization process. Host RSS understates the cost because macOS compresses and swaps the rest.

```sh
colima ssh -p "$SANDBOX" -- python3 /opt/agent-sandbox/vm/memory.py
```

Size the cap from your own workload, measured with the memory command. Take three figures: the session alone, with a client attached so its desktop runs, its gateway and Docker daemon, then one worker with no development stack, then the stack a worker starts, both at rest and at its peak. The cap must hold the session plus every worker with its stack at peak whenever the stacks can peak together. Stacks at rest let more workers fit under the same cap. A sandbox whose `vm.swapGiB` is 0 has no swap, so exceeding the cap there ends with the kernel killing a process.

`vm.swapGiB` gives the VM a swap file of that size, `/swapfile` on its root disk. The file takes Mac disk space and no Mac memory, so the memory cap and the Mac's margin stay as they are. [The VM setup](vm/setup.sh) creates, resizes or removes the file to match the setting, and turns it on at every `./bin/vm-up`. The file has no boot entry, so a VM that starts without `vm-up`, such as one that reboots on its own, runs without swap until the next `vm-up`.

A small sandbox for one worker building next to a started development stack can pair a low cap with a swap file. The build then pages to swap instead of being killed, and the stack keeps answering more slowly. A stack that is still starting leaves less memory than the same stack at rest, so size the swap file for a build that runs during that start.

## Boundary limits

This is a development environment that holds credentials and runs agent-selected code. Every pot shares the Agents Sandboxes identity, which can read its authorized vault projects, including secrets beyond the names any pot lists. The identity stays in the VM, readable by root only, so code in a session obtains only the names its own `sandbox.json` lists, through the vault broker. Root in the VM, root on a Proxmox node and the holder of an operator signing key can reach the identity. The router keeps its provider keys and its Claude token in its configuration folder in the session home, where any code in the session can read them. File permissions and environment cleanup do not prevent code inside the session from using its available credentials. GitHub token selection routes authentication and does not restrict what a token itself permits.

The VM firewall blocks container traffic to private IPv4 and local IPv6 ranges, the Mac's Magpie and the whole tailnet range included, and drops everything a container sends through a tailnet interface. A session reaches the tailnet only through its own userspace node, whose traffic leaves as public WireGuard and HTTPS, so the tailnet policy alone decides what that node reaches. It permits DNS to VM services and blocks other new container connections to those services. It also blocks new connections from outside the SealSkin server into its bridge network. Public internet access remains available. Docker starts only after the firewall has loaded its rules, so a firewall that fails keeps Docker, the SealSkin server and the session down. The SealSkin server is a trusted control component with the VM's Docker socket. The session gets a nested Docker daemon instead of that socket.

`probe-boundary` checks that Docker requires the firewall unit, without provoking a failed start. It checks selected forbidden endpoints from both the VM and session. The sandbox VMs share one network, so those endpoints include the SSH port of every sandbox's VM and every SealSkin server port the Mac publishes; a stopped Colima sandbox has neither and is skipped. A forbidden endpoint that is also closed from the VM is reported as untestable and fails the probe. The endpoints also include the VM node's ssh and door ports and Tailscale's resolver. They name no tailnet address of a Mac: a VM reaches those only through its own node, and the node check below covers them. A second Mac, such as a laptop, is not listed at its LAN address, which changes; the rule that drops a session's traffic to every private range covers it, and the gateway, node and VM endpoints exercise that rule. It checks that the VM's rules drop tailnet egress before any other rule, cap door connections, and leave Tailscale's own chains out; that the tailnet guard's timer is active, its failure starts the shields unit, and the guard passes; that the door listens on tailnet addresses only and its account has no Docker access; and, through [the node check](lib/tailnet_node.py), that both nodes match the pots policy and reach no other service of any peer, the Mac's Magpie and other pots' sessions included. It checks allowed npm and GitHub connections, then runs mount, user-mapping and nested-Docker attack probes as both the session user and root, writes to `/opt/agent-sandbox` and `/etc/agent-sandbox` among them. [The vault probe](probes/vault-attacks.sh) runs as both too. It fails when the session sees the identity's path or a `vault.env`, when a wrapped command holds an `INFISICAL_` variable, when the broker's directory is writable, or when the broker answers an unlisted name, a path with `..`, an unknown request, a vault-access name, a source outside the catalog, or the token of a catalog source that is public or that the pot's `sandbox.json` does not select. In the VM, `probe-boundary` checks that the identity is root-only and unreadable to `nobody`, and [the clone probe](probes/clone-trust.sh) checks that the launcher verifies the clone, refuses an unsigned or forged candidate and a script outside the clone, and that an unprivileged user can write neither the clone, the launcher nor the signer keys. It runs [forged door deliveries](#pots-and-doors) as the session user. It fails when the VM or the session sees a path of the Mac: a `/Users` or `/Volumes` directory, or a virtiofs, 9p or sshfs share other than Colima's Rosetta share, which holds Apple's translator and no file of the operator. [The tailnet attacks](probes/tailnet-attacks.sh), as both, check that every tailscaled socket the session reaches is its own node, that the session cannot plant door state, and that a peer's door refuses a shell command, a forged origin, a reply to another pot, a missing hop, an empty or oversized note and forwarding, then rate-limits those refusals while it still delivers a well-formed reply to an ID the peer never asked, which the peer's session refuses with 76 before keeping or waking anything, and that every other pot's door it sees refuses its key; the door files must be unchanged afterwards. Those probes can pull an Alpine image and run temporary containers. Their success covers the exercised boundaries, not every network destination, kernel escape or credential misuse.

The probe contains no browser UI scenario and restarts nothing itself. A clean result is not proof of either.

A merge into `main` is code that runs with the operator's rights. The watchdog pulls it within a minute, runs its Mac scripts as the operator and installs its pane, which Herdr runs with the operator's rights on every Mac the config sync reaches. The watchdog lands a tip only when an operator key signed it, so that signature and the branch rules on `main` are the whole gate. A merge GitHub makes carries GitHub's signature, so it lands nowhere: merge by fast-forward to a tip the operator signed. Set the branch rules for code that runs with host permissions, and count every token a session holds as able to push whatever those rules allow.

Each VM fast-forwards its clone within five minutes of a push to the branch it follows, and runs that code as root in the VM: the keeper, the vault broker, the tailnet guard, `pots-session` and the update come from the clone. Only a tip an operator key signed lands, so a push without that signature runs on no VM. The clone reads the public repository over HTTPS, so the VM holds no GitHub credential. A VM cloned from a checkout on another branch follows that branch's pushes, which no rule on `main` reviews. Put it back on `main` from inside the VM with `sudo git -C /opt/agent-sandbox fetch origin main` then `sudo git -C /opt/agent-sandbox switch --create main FETCH_HEAD`.
