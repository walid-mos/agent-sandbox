# agent-sandbox

Development sandboxes for a Pots bot and its Pi workers. Each sandbox is a SealSkin desktop session on its own Colima VM. The session has its own writable home and nested Docker daemon, with read-only access to the Mac's Development directory.

## Sandboxes

Each sandbox has a directory under `~/.config/agent-sandbox/sandboxes/`, named after it, holding `sandbox.json`. [`sandboxes.example/`](sandboxes.example) holds a starting point, which `./bin/configure-host` copies when the runtime directory has none. That name is also its Colima profile. Every command under `bin/` and `mac/` acts on the sandbox that `SANDBOX` names and stops when it is unset.

| Key | Meaning |
| --- | --- |
| `vm` | Cores, memory, swap file and disk of the VM |
| `serverPort` | Mac-local port of the sandbox's SealSkin server. Each sandbox needs its own |
| `tailnetSshPort` | Port of the Mac's tailnet address where ssh enters the sandbox's session. Each sandbox needs its own |
| `bot` | Name of the Pots bot that bootstrap creates, in one word |
| `rules` | Optional. Path, in the session, of an instruction file that the bot and every worker of the sandbox load |
| `owners` | GitHub owners that the dispatcher and the GitHub wrapper accept, each with the name of its token in the vault's `/tools/github` |
| `secrets` | Other vault folders, each with the names injected from it |
| `onRequest` | Named groups of vault folders and names, injected only into a command that asks for the group |

Beside `sandbox.json`, the directory holds `vault.json` (the vault `project` and `environment`) and, optionally, `git-identity.json` (`name` and `email` for the session's commits). The session mounts that directory read-only at `/etc/agent-sandbox`. The next command reads a changed `owners`, `secrets` or `onRequest`. `vm` applies when the VM next starts, `serverPort` when the server is next created, and `bot` and `rules` at the next bootstrap. The next `./bin/vm-up` applies a changed `vm.swapGiB` to a running VM, with no restart. The watchdog's next check applies a changed `tailnetSshPort`, and the old port stays served until `tailscale serve --tcp=PORT off`.

## Install on the operator's Mac

The configuration targets Apple Silicon macOS. The checkout lives under the Development directory that `~/.config/agent-sandbox/host.json` names as `developmentDirectory`. The VM mounts that directory and its sandbox's directory read-only at the same paths, and the session template, session services, Pots pane and remote connector read the checkout path from the host configuration. Host names, the Git identity and the vault project stay in that private directory, never in this repository: `./bin/import-private OLD_CHECKOUT` copies them out of an older checkout without changing it.

Install Colima, the Docker CLI with Compose, Node, curl and jq first. The Mac also needs the Pi harness in the home directory's `.pi/agent`, its Infisical machine authentication and a binding whose `boats` key identifies the Agents Sandboxes identity. The host identity must be allowed to mint that identity's client secret. Never put credential values in this repository or a command line.

Run these commands from the Mac checkout. Keep `sandbox_repo` and `SANDBOX` set for the later host commands.

```sh
cd /path/to/agent-sandbox
sandbox_repo="$PWD"
export SANDBOX=sealskin
./bin/vm-up
./bin/sealskin-up
```

`vm-up` writes the Colima profile from [the Colima template](colima/colima.yaml) and the sandbox's `vm` values, then starts the VM when it is stopped. It installs Sysbox, the container runtime, and enables the firewall service. Review the template and [the firewall configuration](vm/network.env) before starting. `sealskin-up` starts the server and applies the app template. Applying configuration restarts the SealSkin server and waits for it to load the template and installed app before returning.

Complete SealSkin's initial admin setup through its Mac-local endpoint, `https://127.0.0.1:PORT`, where `PORT` is the sandbox's `serverPort`. The session API requires SealSkin's `/config/root_key`, and the installed Pots app is assigned to `admin`. This repository does not automate that initial admin setup.

Then create the session and bootstrap its tools:

```sh
./bin/pots-session ensure
./bin/session-bootstrap
```

`session-bootstrap` brings a session up in this order, and rerunning it is safe.

1. It provisions the vault credentials when absent.
2. It installs the session tools and the Pi harness. Versions and steps live in [the bootstrap script](session/bootstrap).
3. It adds the sandbox to the Mac's Herdr machines, which copies `hc` into the session, or updates that copy when the entry exists.
4. It restarts the router and seeds it, as [Model router](#model-router) describes.
5. It creates the sandbox's bot when it has none, then links [the bot's instructions](session/bot) and the sandbox's `rules` into the session.
6. It restarts the gateway, the worker watcher and the source watcher.

Bootstrap needs access to the private harness repository and the configured vault paths, and the Mac's Magpie as the source of the seed.

The credential step pipes a newly minted Agents Sandboxes client secret directly from the Mac into the session. It stores the credential at `/config/.config/agent-sandbox/vault.env` with private permissions. The minted secret has no expiry or use limit. Rerunning `./bin/session-credentials` replaces the stored credential without revoking earlier secrets. An installation failure can leave downloaded tools or a partially configured home behind. Fix the reported cause and rerun bootstrap.

The MacBook reaches a session through the Mac Studio. Copy [the connector](mac/sealskin-connect) to its `~/.local/bin`, then add the sandbox there:

```sh
hc machine add --name "$SANDBOX" --via "$HOME/.local/bin/sealskin-connect $SANDBOX"
```

A device whose Herdr adds machines by ssh only, such as the phone, reaches a session at the sandbox's `tailnetSshPort`. Its target is the Mac user's name at the Mac Studio's tailnet name, with that port. Tailscale Serve forwards the port to the VM's sshd, inside the tailnet only.

- `./bin/vm-up` copies the keys of the Mac's `~/.ssh/authorized_keys` into the VM, so a key the Mac accepts enters each sandbox. Run it again after adding a key to the Mac.
- Each key is bound to [a forced command](vm/session-keys). It runs the client's shell line in the session as the session user, with no terminal and no forwarding, and runs nothing in the VM.
- Lima picks a new Mac-local ssh port at each VM start, so [the watchdog's last step](mac/tailnet-ssh) points the tailnet port at the VM again.
- The firewall keeps a session off the Mac's tailnet address, and `./bin/probe-boundary` checks every sandbox's port from the session.

## Agent sources

Each session provisions the Pi harness, the Herdr configuration and, for a sandbox that owns `NextNodeSolutions`, the organization additions. [The source catalog](session/agent-sources.json) names each repository, the vault credential that reads it and its home-relative checkout. Bootstrap runs [the provisioner](session/provision-agents), and [a session service](session/services.d/pots-sources) reruns it on a timer once bootstrap has started a first run. `./bin/session-refresh` runs it on demand.

- A refresh only fast-forwards `main` of a checkout whose tracked files are clean. A checkout on a task branch, with an edited tracked file, or with Git configuration that runs commands, stops the refresh and stays as it is.
- Installers run only after a successful refresh. The receipt `~/.config/agent-sandbox/provisioned.json` advances only after both installers succeed, so a failure retries on the next run.
- The service stops a run that outlives its time limit, so a stalled fetch or installer cannot hold the provisioning lock. The stopped run ends its running command and puts back the files it had set aside, and the next run retries.
- Auth, sessions, settings, model choices and Herdr registrations are never reset. Pi's and Herdr's own contracts say which files each installer owns.
- Herdr's desktop files, the shared mods, Pots and its terminal drawer, reach a session only after Herdr has started there once and written its key bindings. Until then a run installs Pi and Herdr's `headless` profile, and the first run after Herdr's start installs the `desktop` profile. `profile` in the private file, `desktop` or `headless`, overrides this choice, and `desktop` before Herdr's first start stops the run before anything changes.
- Herdr's attachment button opens a native file chooser, so a desktop session gets `zenity` when neither `zenity` nor `kdialog` is installed. A recreated container loses the package and the next run installs it again. A failed package installation fails the run and leaves Pi and Herdr installed.
- Private values live in `~/.config/agent-sandbox/provisioning.json`, never in the repository. A source's `url` replaces the GitHub address, which serves a local or staging origin.

### Switching a checkout to an unrelated origin

A source whose origin differs from the catalog stops with an error. `allowCutover: true` in the private `provisioning.json` lets the next run move that checkout to the new history in place: it fetches the new `main`, keeps the previous head under `refs/agent-sandbox/before-origin-switch`, resets with `--keep` so edited files stop it, then points `origin` at the new address. Untracked files, linked worktrees and task branches stay. An untracked file that collides with a tracked one in the new history stops the switch before anything changes.

For this checkout on a Mac, run `./bin/import-private OLD_CHECKOUT` from a clone of the new repository first. It copies host names, the Git identity, the vault project and the sandbox configurations out of the old checkout into `~/.config/agent-sandbox`, and records the old revision. Then run `python3 lib/source_refresh.py NEW_URL OLD_CHECKOUT --allow-cutover` from that clone. The watchdog's own update keeps following `origin` afterwards. A running session still binds the old `sandboxes/` directory, and its VM keeps the mounts it started with. For each sandbox, once: run `./bin/pots-session stop`, which stops every worker in the session, then `colima stop --profile "$SANDBOX"`, `./bin/vm-up`, `./bin/sealskin-up` and `./bin/pots-session ensure`.

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

[The watchdog's first step](mac/update) keeps the pane current with no command typed. Every minute, on a checkout that is on `main`, it fetches `origin/main` and fast-forwards to it, then runs the installer. The installer writes only the files whose content changed, and Herdr redraws the pane when one does, with no restart. A merge into `main` therefore shows in the pane about a minute later. On any other branch the step leaves the checkout where it is and installs that branch's pane. A checkout that cannot fast-forward, because it holds a commit of its own or an edited file the merge touches, also stays where it is, and the watchdog's log says why. The operator's Herdr config sync then carries the installed `command-center`, `pots` and `pots-terminals` mods to their other Mac. It leaves out a file named like a credential, so `./bin/check` refuses such a name under `herdr/`.

The pane talks to one sandbox's bot at a time. The installer writes each sandbox's machine and bot name into the mod, so a sandbox added or a bot renamed shows in the pane after the watchdog's next run. With more than one sandbox, the pane shows a tab per bot above the conversation. The chosen bot's conversation, workers, routines and gateway fill the pane, a message goes to that bot, and Open and Stop act on that sandbox's workers. Each bot keeps its own draft and its own messages on their way. Herdr remembers the choice on each Mac. `herdr-app do pots.switch` moves to the next bot, and a key can be bound to it.

Terminal, at the start of the control bar under Principal, opens a resizable pane to the left of the conversation. One click opens the pane with a focused shell: on the Mac the first time, afterwards on the last computer you chose. Choosing a computer in the pane's picker opens a shell there, and New adds another on the chosen computer. The picker reads the Mac's Herdr machines, including sandboxes registered during bootstrap, and keeps the last choice independently of the bot tab. An unavailable computer stays unavailable rather than opening a shell elsewhere. New inherits the focused shell's folder when it belongs to that computer, otherwise it starts at home. Each shell has its own native terminal, stacked vertically with draggable boundaries. Hide returns focus to the conversation without ending any shell. End asks for a second click before terminating that shell. The layout keeps the pane's visibility, width, split sizes and terminal addresses across app restarts. A lost kept terminal returns as a shell in its last folder, as Herdr specifies, and does not restart its previous program.

The installer adds Cmd-T to show or hide the pane (the same key hides it again), Cmd-Shift-J for a new shell and Cmd-Alt-J to focus the next shell, scoped to `command-center-pots`. It leaves a shortcut another action already holds untouched, which is why the pane does not use Cmd-J: Command Center binds it. A `keys.json` that is not valid JSON is left alone and reported once on standard error, and the shortcuts are bound on the first run after it is fixed. The commands also work from a terminal: `herdr-app do pots.terminal`, `herdr-app do pots.terminal-new` and `herdr-app do pots.terminal-next`. `herdr-app do pots.terminal-machine` opens the computer picker from the keyboard. Shell keys, including Escape and Ctrl-C, go to the terminal program. A popup computer picker takes Up, Down and Enter, with Escape to dismiss it.

Five toggles sit above the conversation: Workers, Recent wakes, Routines, Pots children and Gateway. Each one shows or hides its section, and the Workers toggle carries the chosen bot's worker count. Every toggle starts off, so the conversation takes the full width. The sections that are on stack in a sidebar to the right of the conversation, or under it when the pane is narrow. A narrow pane with several bots also moves the toggles to their own row under the tabs. Open and Stop in the Workers section act on the chosen sandbox's workers. The toggles keep their state when the bot changes. Herdr does not store them, so they start off again each time the pane loads.

A worker that waits on Pi's `ask_user_question` in its terminal shows that question under its row in the Workers section: each question with its options, and a field for an answer of your own where the question takes one. The Workers toggle counts the workers asking. Answer hands the choices to `control.mjs answer-dialog`, which reads the open question from the worker's Pi session file, the one its terminal's `pi.session` label names, and presses in its terminal the keys a person would press. The row then shows for a minute what the worker received. Those keys start from the question as it opened, so a questionnaire resumed after Discuss, with answers from the terminal, is left to the terminal. So is a secret the worker asks for, and any other dialog: the row says what it waits for, and Open is where to answer it.

The conversation reads in one centered column: your messages are bubbles on the right, and the bot's replies are plain text under its name. The composer is a card under it, with Attach on the left and a round send button on the right. In the composer, Enter sends and Shift+Enter breaks the line. A file chosen with Attach, which opens the Mac's file chooser, a file dropped on the conversation, or an image or Finder file pasted into the composer, leaves with the next message. A sent image shows in the conversation as a thumbnail while the pane stays open; after a reload the message names its files. Each file is at most 8 MB, `hc`'s limit on standard input, and a message carries up to eight. A sent message shows at once and leaves one after another. `control.mjs send` writes it straight into the bot's terminal channel, as `pots chat` does, so the composer never waits for an answer, and a message written while the bot is down waits there until it starts. One that fails stays in the conversation with Retry and Edit, and a message behind it waits rather than overtaking it. Edit puts the message back in the composer, and leaves it there untouched while the composer holds text of its own. While the bot owes an answer, a working line counts the time and the pane looks every second instead of every five. The latest message, and any message under the pointer, offers Copy. A reply also offers What it did, which lists the model calls and tool calls `pots trace` recorded for it since the reply before it.

The composer also runs `/model` and `/route`, typed alone on one line with no file. Without a target they act on the bot: `/model MODEL` writes the `model` of its `bot.json`, which pots applies within seconds, `/route GROUP` sets it to that Magpie group, and `/route auto` puts it back on `magpie/group/router`. `/model @BRANCH MODEL` and `/route @BRANCH GROUP` type the command into that worker's Pi with `hc send`, and Pi runs it at once, also in the middle of a turn. `@` takes a worker's branch, title or name, or any part of one that no other worker shares. While the draft holds a command, the line beside the send button says what Enter runs and for whom, and once it ran, the line above the composer says what changed. `/model` takes the `enabledModels` of the harness's `settings.json`, because Pi opens its picker for any other model; `/route` takes the members of `magpie-routing.json`, and `auto`. A short name such as `max` stands for the only choice that ends with it, and either command with no argument lists its choices. A command runs at once and does not wait behind messages on their way. Any other text, a command the pane does not know included, goes to the bot as a message. A worker's `/route` pin stays in its session, while its `/model` lasts until its terminal restarts on the model its record names.

A reply that carries a `question` block, written as [the bot's instructions](session/bot/AGENTS.md#questions) say, shows its options as buttons under it, and `control.mjs` keeps the block out of the reply's text. A click on an option sends its label as your message. When the question lets you pick several, each option has a box, and Send sends the picked labels one per line. You can answer in the composer instead. Once you answer, the question shows as answered with your picks checked and takes no more clicks: at once when you click, and as soon as a typed message is on its way. A message that fails answers nothing, and a click whose message fails stays answered, with Retry and Edit under it. Saving secrets the bot asked for answers no question.

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

The watchdog starts at user login. Every minute it brings the checkout and the pane up to date, as described above, then checks, for every sandbox under `sandboxes/`, that its VM, its SealSkin server and its session are running, then that [the session still has the checkout's directories bound](mac/session-binds) and that its tailnet ssh port points at the VM. It therefore creates the VM of a directory added there. Its LaunchAgent configuration comes from [the installer](mac/install-watchdog). It does not update the session's tools, mint credentials or rebootstrap the session. Loading the agent with the VM stopped brings all three back, which is the path a login takes. A real Mac reboot has not been exercised.

Keep the Mac checkout on a branch that holds this code. Every session binds directories of the checkout and the Mac reaches each sandbox through its scripts, so a branch without them cuts all sandboxes off until the branch is back. Git recreates the directories on the way back, and the watchdog's next check binds them into the running sessions again, with no restart.

Run the following from the Mac checkout:

```sh
./bin/pots-session name
./bin/pots-session ensure
./bin/sandbox-exec "$sandbox_repo/session/with-vault" pots status
./bin/sandbox-exec hc ls --all
./bin/probe-boundary
```

`name` prints the running session container name, or nothing. `ensure` launches a session if none is running. `ensure` and `restart` hold one lock, so the watchdog's check waits for a restart to finish and never launches a second session on the same home. `sandbox-exec` runs a command as the session user and fails when no session exists. Use `pots status` for the gateway and bot state, and `hc ls --all` for worker terminals.

[The server image](sealskin/compose.yaml) and [the session image](sealskin/installed_apps.yml) are pinned by digest, and SealSkin's hourly image pull is off for the session app. Change an image by committing its new digest, then rerun `./bin/sealskin-up` for the server.

After changing the app template or installed app configuration, apply it before recreating the session:

```sh
./bin/sealskin-apply
./bin/pots-session restart
./bin/session-bootstrap
```

Reapply VM firewall changes with `./bin/vm-up`. Each run replaces the rules in one transaction.

Docker requires the firewall unit. Never stop or restart `pots-firewall.service` by hand, because systemd then stops Docker and every container with it. `sudo systemctl start pots-firewall.service` reloads the rules and touches nothing else.

The unit is a oneshot, so `systemctl is-active pots-firewall.service` answers `inactive` once its run has ended. That is its healthy state, and a run that failed answers `failed`. To check the firewall, read `systemctl show docker.service --property Requires`, which must name the unit, and `sudo iptables -S DOCKER-USER`, which must list the `DROP` rules.

To stop the Pots session deliberately, unload the watchdog first so it will not recreate the session:

```sh
launchctl bootout "gui/$(id -u)/fr.nextnode.agent-sandbox"
./bin/pots-session stop
```

Stopping the session leaves the SealSkin server and Colima VM running. The named Pots home and inner Docker volume hold persistent state. `restart` stops and recreates the session.

A recreated session, or a restarted VM, comes back as follows.

| Part | After the restart |
| --- | --- |
| Router | Starts on its own with its keys and its Claude account, with no seed |
| Gateway and watcher | Start on their own, with no bootstrap |
| Bot | Keeps its conversation and answers again |
| Unfinished worker | Resumed once in a new terminal, then idle until the bot instructs it |
| Completed or stopped worker | Stays closed |
| Containers of a development stack | Kept but stopped. Start their Compose project again |
| Development tunnels on the Mac | Gone. Start them again |

The desktop UI after a restart is unchecked. Rerun the boundary probe after lifecycle changes.

## Model router

Each session runs its own Magpie router as the `pots-router` service, on the session's loopback address. The bot and the workers call it, and the firewall keeps every sandbox off the Mac's Magpie. The router accepts any key because it listens on loopback only, so [the session environment](session/lib.sh) sets `MAGPIE_API_KEY` to a fixed word.

[The bootstrap script](session/bootstrap) installs Magpie and Claude Code at pinned versions. The router answers for Claude models by running that Claude Code. Bootstrap also points the harness clone's `models.json` at the router, which leaves that clone one line away from its remote. [The provisioner](session/provision-agents) sets that line aside while it fast-forwards the clone, then puts it back, and stops on any other edit of the file.

Bootstrap seeds the router. Seed it alone from the Mac checkout while the Mac's Magpie holds the wanted groups and rules:

```sh
./bin/router-seed
```

`router-seed` copies the Mac router's providers, groups, rules and settings into the session, with no key and no sign-in. [The restore step](session/router-restore) gives each provider the key the sandbox lists for it, turns off Magpie's own updates and found groups, and registers the Claude token of the `claude` group under `onRequest`. It waits for the router to listen, verifies a Claude answer and a direct `codex/gpt-6.1-sol` answer, and fails when either is missing or Codex returns another model. Rerun it after changing groups or rules on the Mac, and after rotating a provider key or the Claude token.

Codex credentials come from the same central publication as Pi clients. The signed-in publisher runs `pi-token-sync --publish` and writes access, accountId and expires to `/clients/pi/PI_OAUTH_CODEX` in Infisical. Only that publishing machine owns and renews the refresh token. The sandbox identity needs read access to this path. No sandbox browser login is required.

[The router launcher](session/router.mjs) synchronizes that publication before starting Magpie and every hour thereafter. Within an hour of expiry it schedules the next attempt five minutes before expiry. Failed updates retry every minute and preserve the previous file. [The writer](session/router-codex.mjs) rejects malformed, refresh-bearing, expired or nearly expired publications before touching any file, checks the access token's account ID and expiry, and writes its own private Codex `auth.json` atomically under `~/.local/state/agent-sandbox/codex`. `with-vault --secret` gives this writer only the publication and basic process settings. Magpie's environment excludes vault and GitHub credentials.

The router alone sets `CODEX_HOME` to that managed directory. Magpie 0.1.3350 reads the standard Codex file, uses `account_id` when no ID token is present, and rereads it when tokens change. The file holds empty ID and refresh tokens. Its five-minute expiry guard prevents a stale publication from becoming a new credential. If the publisher stops updating, Codex access eventually fails and the logs name the vault sync failure. Restore still passes `--no-sign-ins`. Existing `~/.codex`, Pi auth and Magpie native sign-ins stay untouched, and no request goes through the Mac's Magpie.

After installing this change, restart `pots-router` through bootstrap before seeding. `router-seed` alone updates the managed credential and verifies a direct Sol answer, but an older running service needs that first restart to adopt `CODEX_HOME`. Pi clients outside the router continue to use the harness's `pi-token-pull`.

| Limit | Consequence |
| --- | --- |
| Magpie reads a provider key from its arguments only | The key shows in the session's process list while the seed runs |
| The central publisher must keep publishing fresh access tokens | A failed hourly sync retries each minute and cannot renew a token locally |
| The Claude step runs the harness's `magpie-claude-token-sync` worker | A harness clone without it cannot register the token |

## The bot and its Pi workers

Each sandbox has one bot, named by its `bot` key. It uses `magpie/group/router` for coordination, and the Pots gateway runs it through the session's service supervisor. Pi workers start on `magpie/group/router`, or `magpie/group/max` when the person asks for it, and use the installed Pi harness and separate Git worktrees under the session's `/config/Development`. The host Development mount remains read-only.

[The bot's instructions](session/bot) are the same in every sandbox. Bootstrap links them into the bot's folder, so the bot reads them and cannot edit them. Change them in this repository. What differs between sandboxes is data. `owners` limits the repositories, and `rules` names an instruction file that bootstrap links at `/config/AGENTS.md`, where Pi loads it for the bot and for every worker.

A sandbox for a client uses `rules` for the client's own instruction file, which can make every push wait for the person's yes. The yes is a rule that the bot and the worker follow, and the sandbox's token can push without it. The bot asks before a start, because the start pushes the branch to open the draft PR. It asks again when a worker stops with unpushed commits, then sends the worker the yes for that one push.

The bot starts and reaches workers itself. To do it by hand, create a brief or a message file inside the session, then run this from the Mac. The dispatcher identifies the repository explicitly when looking up its default branch.

```sh
./bin/sandbox-exec "$sandbox_repo/session/with-vault" node "$sandbox_repo/session/dispatch.mjs" start NextNodeSolutions/REPOSITORY docs/task-name /config/task.md
./bin/sandbox-exec "$sandbox_repo/session/with-vault" node "$sandbox_repo/session/dispatch.mjs" send WORKER /config/message.md
```

`send` pastes the message into the worker's live terminal. A worker whose terminal has closed, or that was stopped, comes back in a new terminal with its conversation and reads the message there.

The dispatcher accepts repositories under the sandbox's `owners`. It clones or fetches the repository, creates a new branch and worktree from the default branch or an optional final base argument, opens a draft PR, and launches Pi through `hc`. Branches must use a supported prefix such as `feat/`, `fix/`, `chore/`, `docs/`, `refactor/` or `test/`, followed by lowercase letters, digits or hyphens. The worker takes its name from the repository and the whole branch, shortened with a digest when the name exceeds hc's limit. A dispatch whose worker name already has a record is rejected before the clone, the worktree and the draft PR. An existing worktree is rejected. A later failure can leave the clone, worktree or draft PR behind, so inspect those before retrying.

Gateway and watcher wrappers wait indefinitely if their prerequisites are missing at service start. Bootstrap restarts both after installing prerequisites. Check their status before relying on automatic reports.

Worker briefs and records live under `/config/.config/agent-sandbox/workers`. The watcher polls their terminal state and wakes the bot with the branch, commit, uncommitted-path count, unpushed-commit count, clean-pass record and PR URL. It marks a worker complete only when its status is `done`, its worktree is clean and no commit is missing from `origin`. That signal does not verify PR checks or a merge. A lost unfinished worker is resumed once per watcher process. A terminal that just started is never treated as lost, because the vault login shows no agent status at first. A completed or stopped worker is relaunched only by a `send`. A stop is a `NAME.stopped` file beside the worker's record, which a `send` removes, and the watcher ends any terminal of a stopped worker that it finds running.

A thread outside the sandbox reports to the bot through the sandbox's Herdr machine, from either Mac. The bot reads the note and tells the person in the Pots pane. `--from` accepts letters, digits, `-` and `_` only, so the thread's title opens the note.

```sh
hc exec --on "$SANDBOX" pots wake --from mac-thread --note "$thread_title: $report"
```

## Clean pass

A worker whose task builds a feature or changes a lot of code runs `/untangle-codebase`, `/code-review` and `/simplify` before its final report, as [its guide](session/clean-pass.md) says. Each pass is Claude Code running the real command in its own terminal, in the worker's worktree, on the person's Claude account. That traffic goes to Anthropic and not through the router, and an empty Claude quota stops the pass.

```sh
node "$sandbox_repo/session/clean-pass.mjs" untangle AREA
node "$sandbox_repo/session/clean-pass.mjs" review
node "$sandbox_repo/session/clean-pass.mjs" simplify
```

[The command](session/clean-pass.mjs) runs from the worktree and opens one pass. It starts Claude Code through `with-vault --with claude`, so the Claude token reaches that terminal and no worker terminal. A pass reads [its settings](session/claude/settings.json), the untangle skill of the harness and its trusted folders from `/config/.config/agent-sandbox/claude`, apart from the home the router's Claude Code uses. Those settings let it run every tool without asking, which the sandbox is there to contain.

The command records the commit each pass started on in `NAME.passes` beside the worker's record, and the watcher's report carries that record. The worker marks its own pull request ready once its work is finished and tested, as [its guide](session/clean-pass.md#ready-for-review) says. The bot puts a pull request back in draft when it lacks the clean pass it owes, or holds it there while it must not merge.

## GitHub authentication

[The session wrapper](session/with-vault) authenticates as Agents Sandboxes and injects only the secrets its sandbox names. Those are the token of each owner from `/tools/github` and the names listed under `secrets`. `with-vault --with GROUP` adds the names of that group under `onRequest`, for the one command that needs them. `with-vault --secret PATH/NAME` gives one command that single vault secret and the basic process settings, without the sandbox's list; the router's Codex sync uses it. A listed name that the vault lacks stops the command. It removes the Universal Auth client secret from that environment after login. The stored credential remains available inside the session.

The access token of that login stays in the command environment as `INFISICAL_TOKEN`, so a wrapped command can run `infisical run` on another vault path. Every child process inherits it, and a tool that writes its environment into a log or an error report leaks it. Keep it out of app containers by passing their variables by name, as [Development services](#development-services-and-memory) describes.

The GitHub CLI wrapper selects a credential by repository owner, from the sandbox's `owners`. Git uses the same selection through an HTTPS credential helper with `useHttpPath` enabled. Only variable names belong in a sandbox's file and in documentation. Use HTTPS Git remotes and supply the repository to `gh` with `--repo`, a `repos/OWNER/REPOSITORY` API endpoint or `GH_REPO`. Otherwise, the wrapper uses the current checkout's `origin`. Outside a checkout, it reads the owner from a GitHub URL argument, such as a pull request's. Unsupported owners and missing credentials fail explicitly.

This read-only probe checks API access and HTTPS Git access for the repositories it is given:

```sh
./bin/sandbox-exec "$sandbox_repo/session/with-vault" sh "$sandbox_repo/probes/github-owners" NextNodeSolutions/agent-sandbox walid-mos/dotfiles
```

The probe reports repository identity, push permission and a HEAD commit without printing tokens. Access does not authorize a push. A wrapped command receives the tokens of its own sandbox's owners and no other.

## Development services and memory

The session's Docker daemon is separate from the VM daemon used by SealSkin. Give each worktree its own Compose project and published ports. Keep overrides and application environment injection outside client repositories. Pass application variables by name into app containers, excluding unrelated provider, GitHub and vault credentials. Client push rules still apply.

[The development tunnel](mac/forward-dev) forwards a Mac-local port into the running session. Keep it in an owned terminal while using it, then publish that local port with `tailnet-link`. Stop the tunnel when the preview is no longer needed.

```sh
./mac/forward-dev LOCAL_PORT SESSION_PORT
```

### CPU

The pane's requests, the bot and the session's Herdr keep the default CPU priority, and worker jobs run behind them. A worker, a clean pass and the processes they start run at niceness 10, set where [their terminal opens](session/workers.mjs). The session user can lower a priority and cannot raise one, so the workers step down. Inner containers, the PR factory's check containers among them, all run under one cgroup. [The Docker service](session/services.d/docker) gives that cgroup a CPU weight of 10 against the session's 100 when it starts, so a running session takes a changed weight at its next restart. A weight on one container, such as `--cpu-shares`, only ranks it among the other containers. Neither setting caps a job: a worker alone on idle vCPUs runs at full speed.

### Memory

The VM never gives memory back to the Mac. Apple's balloon device does not offer free-page reporting and Lima never inflates the balloon. The Mac footprint of the virtualization process grows until it reaches the VM's memory cap, then stays there. Memory that Linux reports as free or cached is not memory the Mac recovered.

The only lever is a lower `vm.memoryGiB` in the sandbox's file. Apply it with `colima stop --profile "$SANDBOX"`, then `./bin/vm-up`. That restart stops the session and every worker in it.

[The memory command](vm/memory.py) reports guest memory, the live balloon features and the balloon counters. Compare its output with the `footprint` of the Mac virtualization process. Host RSS understates the cost because macOS compresses and swaps the rest.

```sh
colima ssh -p "$SANDBOX" -- python3 "$sandbox_repo/vm/memory.py"
```

Size the cap from your own workload, measured with the memory command. Take three figures: the session alone, with its desktop, gateway and Docker daemon, then one worker with no development stack, then the stack a worker starts, both at rest and at its peak. The cap must hold the session plus every worker with its stack at peak whenever the stacks can peak together. Stacks at rest let more workers fit under the same cap. A sandbox whose `vm.swapGiB` is 0 has no swap, so exceeding the cap there ends with the kernel killing a process.

`vm.swapGiB` gives the VM a swap file of that size, `/swapfile` on its root disk. The file takes Mac disk space and no Mac memory, so the memory cap and the Mac's margin stay as they are. [The VM setup](vm/setup.sh) creates, resizes or removes the file to match the setting, and turns it on at every `./bin/vm-up`.

A small sandbox for one worker building next to a started development stack can pair a low cap with a swap file. The build then pages to swap instead of being killed, and the stack keeps answering more slowly. A stack that is still starting leaves less memory than the same stack at rest, so size the swap file for a build that runs during that start.

## Boundary limits

This is a development environment that holds credentials and runs agent-selected code. It is not a vault isolation boundary. The Agents Sandboxes identity can read its authorized vault projects, including secrets beyond the names `with-vault` injects. A sandbox's secret list limits what a process receives, not what that identity can read. The router keeps its provider keys and its Claude token in its configuration folder in the session home, where any code in the session can read them. File permissions and environment cleanup do not prevent code inside the session from using its available credentials. GitHub token selection routes authentication and does not restrict what a token itself permits.

The VM firewall blocks container traffic to private IPv4 and local IPv6 ranges, the Mac's Magpie included. It permits DNS to VM services and blocks other new container connections to those services. It also blocks new connections from outside the SealSkin server into its bridge network. Public internet access remains available. Docker starts only after the firewall has loaded its rules, so a firewall that fails keeps Docker, the SealSkin server and the session down. The SealSkin server is a trusted control component with the VM's Docker socket. The session gets a nested Docker daemon instead of that socket.

`probe-boundary` checks that Docker requires the firewall unit, without provoking a failed start. It checks selected forbidden endpoints from both the VM and session. The sandbox VMs share one network, so those endpoints include the SSH port of every sandbox's VM and every SealSkin server port the Mac publishes. A forbidden endpoint that is also closed from the VM is reported as untestable and fails the probe. It checks allowed npm and GitHub connections, then runs mount, user-mapping and nested-Docker attack probes as both the session user and root. Those probes can pull an Alpine image and run temporary containers. Their success covers the exercised boundaries, not every network destination, kernel escape or credential misuse.

The probe contains no browser UI scenario and restarts nothing itself. A clean result is not proof of either.

A merge into `main` is code that runs with the operator's rights. The watchdog pulls it within a minute, runs its Mac scripts as the operator and installs its pane, which Herdr runs with the operator's rights on every Mac the config sync reaches. Nothing reviews it on the Mac, so the branch rules on `main` are the whole gate. Set them for code that runs with host permissions, and count every token a session holds as able to merge whatever those rules allow.
