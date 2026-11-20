# Protected Mac launch installation

This page is an operator-reviewed installation contract for each Mac. Account creation, file grants, credentials and launchd changes happen only during a separately approved native installation. Source tests on Linux do not authorize or prove them.

Read the [threat model and message contract](mac-launch.md) first. Run the native checks before installing the daemon. Verify a click on a harmless prompt before relying on the installation. If the native sandbox or protected Herdr path is unavailable, stop with that exact limitation. Never substitute the operator account.

## Ownership and staging

| Location | Required owner and mode | Purpose |
| --- | --- | --- |
| `/Library/AgentSandbox` and protected ancestors | root, no group/world write or extended ACL grants | Prevent replacement of protected trees |
| `/Library/AgentSandbox/MacLaunch` | root, 0700 | Gate HOME, private Herdr context, settings and token |
| `MacLaunch/code` | root, directories 0755 or stricter, files not group/world writable, no symlinks or extended ACL grants | Installed reviewed source and its imported configuration |
| `MacLaunch/settings.json`, `discord-token`, launch records and markers | root, 0600 | Gate authority |
| `/Library/AgentSandbox/Runtime` | root, no writable dependencies, symlinks or extended ACL grants | Dedicated Node, Pi entry, standalone Herdr and explicitly installed task tools |
| `/Library/AgentSandbox/Delegations` and its credential files | root, directory 0700, files 0600, no extended ACL grants | Dedicated model/task credentials and selected SSH files |
| `/Library/AgentSandbox/Execution` and `runs` | root, traversable but not execution-writable | Prevent replacing run roots and their ownership markers |
| `Execution/work/SELECTED_WORK` | Dedicated execution UID/GID, 0700 | The selected work directory, never the operator's HOME |
| A fresh `runs/ID/home` | Dedicated execution UID/GID, 0700, under a root-owned run directory | Run-only HOME, preferences, delegated files, scratch and session report |
| `/Library/LaunchDaemons/fr.nextnode.agent-sandbox.mac-launch.plist` | root, 0644 | Fixed system launch daemon |

Stage a reviewed source snapshot, not the operator's writable checkout. Stage the runtime under the dedicated Runtime tree rather than pointing at Homebrew or the operator's package directories. Resolve installation symlinks into reviewed files before use. The source checker refuses symlinks and writable dependencies instead of trusting a package manager's mutable install. The standalone Herdr executable must support private `HC_SESSION` and `HC_SOCKET` contexts. No operator socket is shared.

Create a dedicated `_maclaunch...` non-admin account with unique numeric UID/GID, no supplementary groups, a disabled login shell and no sudo delegation. The native checker verifies the directory-service identity, uniqueness, shell and sudo denial. Do not copy the operator's home, browser, Keychain, SSH agent, vault state, signing key, subscription login or Herdr configuration into it.

The installer reviews the actual account ID, selected work, runtime sources, file permissions, ACLs and credential scopes before applying them. These are installation facts, not a choice of security mode.

## Private manifest

Write a root-private JSON manifest and pass its filename to `configure`. These are shape examples with placeholders, not a runnable credential grant. Numeric account IDs must be the reviewed native account's actual IDs. Network addresses below are documentation addresses and must be replaced with reviewed provider destinations. The explicit `system-dns` delegation permits hostname queries through the macOS resolver, including arbitrary query names. Direct connections remain limited to the selected endpoints.

```json
{
  "name": "mac-studio",
  "label": "Mac Studio",
  "guildId": "GUILD_ID",
  "channelId": "LAUNCH_CHANNEL_ID",
  "announcers": ["MASTERMIND_BOT_ID"],
  "pots": ["mastermind", "accor"],
  "humanDiscord": {"userId": "OPERATOR_ID"},
  "directory": "/Library/AgentSandbox/Execution/work/SELECTED_WORK",
  "tools": {
    "node": "/Library/AgentSandbox/Runtime/bin/node",
    "pi": "/Library/AgentSandbox/Runtime/pi/cli.mjs",
    "hc": "/Library/AgentSandbox/Runtime/bin/hc"
  },
  "execution": {
    "user": "_maclaunch",
    "uid": 65001,
    "gid": 65001,
    "model": {
      "resolver": "system-dns",
      "provider": "openai",
      "name": "MODEL_ID",
      "credential": "/Library/AgentSandbox/Delegations/model.json",
      "network": [{"address": "192.0.2.1", "port": 443}]
    },
    "grants": []
  }
}
```

The model credential JSON holds only the selected provider's supported API-key environment name. The source contract supports dedicated OpenAI, Anthropic and Google API credentials. Use a newly scoped model credential with a reviewed budget, never the operator's auth file. Enter its value through the masked secret flow available to the setup session. Do not put it in shell arguments, chat or logs.

A delegated task capability has this shape:

```json
{
  "name": "boat",
  "acts": ["spend"],
  "credential": "/Library/AgentSandbox/Delegations/boat.json",
  "files": [],
  "network": [{"address": "192.0.2.2", "port": 443}]
}
```

The credential file may contain only the supported Boat/GitHub environment names. The execution contract defines that allowlist. Each capability may also name selected SSH files with `source` under the Delegations tree and `destination` equal to `.ssh/config`, `.ssh/id_ed25519` or `.ssh/known_hosts`. Use dedicated keys restricted to selected remote accounts and commands. Review the SSH configuration and actual server-side restriction. Neither a capability name nor a port allowlist restricts what an overly broad SSH key can do remotely.

A capability is included only when the request declares every act it names. Duplicate environment keys, delegated destinations or capability names are refused. Provider and task IP changes require an operator-reviewed manifest update. There is no wildcard network, inherited proxy, local privileged socket or automatic operator fallback. A task needing unsupported VM, restart, signing, gate or credential-administration authority stays manual.

The gate's own Herdr configuration is separate. Under its private HOME and XDG paths, configure only the selected pots and dedicated transport credentials. This transport lets the gate fetch proposals and send fixed status commands. Do not copy the operator's Herdr or SSH configuration wholesale. The execution UID never receives that context.

## Native commands and proof

Use the staged launcher as an explicitly authorized administrator. `configure ROOT_PRIVATE_MANIFEST` copies validated private settings. `token` reads the dedicated Discord token at a masked terminal prompt and saves it only in the gate home.

`check` verifies protected staging, native ACLs, account identity, absence of sudo delegation and native sandbox behavior. Its disposable native fixture checks UID/groups, denied gate read/write, inability to regain root or use sudo, denied Keychain access, selected-directory access and scratch/report writing. It records ownership outside its run, cleans on exit and detects an interrupted proof on the next check. A failed native proof blocks activation and names its failed check or sandbox process.

`check` also verifies the Discord application, intent, channel, operator membership and clock, protected runtime availability and each configured pot through the gate's own Herdr. It does not spend model tokens or prove provider connectivity, complete Pi startup, native GUI discovery or sleep/wake behavior.

After that check and separate installation approval, run `install` to make the launcher available. The daemon checks protected settings and native isolation before opening its gateway connection. The gate refuses missing settings, identity, sandbox or model delegation.

For the clicked proof, have a selected pot request a harmless prompt with no privileged acts. Read the offer's exact prompt, identity, work path and capability/network list, then press its button yourself. Confirm one tracked `ml-` terminal, exact prompt execution and a final report on the requesting pot. Repeat the same press, cancel/replace an unclaimed request and test a stale press after sleep. They must not start another run.

The protected Herdr context is separate from the operator's normal terminal list. `watch LAUNCH_ID`, invoked by the authorized operator/admin, validates the saved terminal's label and creation identity before `hc attach`. It allows watching and takeover of that restricted Pi. No general root command API or socket grant is exposed to the model. The terminal is not kept as a root recovery shell after the wrapper ends. Native app discovery and this cross-account interactive path still require an actual Mac check. If attachment cannot work safely, disable the daemon and report the limitation.

Run `disable` to disable and unload the daemon in launchd. Run `remove` to unload it and delete its plist. Both preserve decision and execution records. Revoke the Discord application token separately and remove its root-private token file only through the reviewed uninstall. Never reset decisions to make an old approval reusable.

## Mac Studio setup prompt

```text
Prepare protected Mac launch installation on this Mac Studio. Read docs/mac-launch.md and docs/mac-launch-install.md from the reviewed signed source first. This task does not authorize installation yet.

Show me the exact root-owned staging plan, dedicated non-login execution UID/GID, selected work location, runtime source, native sandbox restrictions, selected pots and proposed dedicated model/task credentials with their scopes and budget. Include file ownership, modes, ACL checks and the private Herdr context. Explain which Workspace/Boat operations work through those explicit capabilities and which remain unavailable. Do not propose my operator account as an execution mode. Wait for my explicit approval before creating an account, copying real directories, granting credentials, installing software or changing launchd.

After my approval, apply only that reviewed installation plan. Set the manifest name to mac-studio and label to Mac Studio. Never copy my browser, Keychain, vault, SSH agent, signing key, model subscription or Herdr session. Stop on an unavailable native mechanism. No same-user or unsandboxed fallback is allowed.

Ask me to create a separate Discord application named Mac Studio launcher with Message Content intent and channel permissions to view, send, attach files and read history. Collect private IDs without publishing them. I enter its token in the staged launcher's masked token prompt. Other credentials use the setup session's masked secret flow and the reviewed dedicated delegation locations.

Run configure with the reviewed root-private manifest, then check. Show every check result without a credential value. Stop on failure. Ask before installing the daemon. Shared Pots configuration and any pot restart require separate explicit approval, with paid work left undisturbed.

Then ask a selected pot for a harmless prompt, have me read its offer and click, and verify the protected Herdr terminal, restricted UID, selected work, operator watching/takeover and final report. Check replay, unclaimed cancellation/replacement and a stale press. No gate, signing, VM-root or unsupported credential operation is authorized by this proof. Disable the daemon if native sandbox, provider or protected Herdr interaction cannot be proved. Finish with the exact disable/remove commands for the staged launcher.
```

## MacBook Pro setup prompt

```text
Prepare protected Mac launch installation on this MacBook Pro. Read docs/mac-launch.md and docs/mac-launch-install.md from the reviewed signed source first. This task does not authorize installation yet.

Show me the exact root-owned staging plan, dedicated non-login execution UID/GID, selected work location, runtime source, native sandbox restrictions, selected pots and proposed dedicated model/task credentials with their scopes and budget. Include file ownership, modes, ACL checks and the private Herdr context. Explain which Workspace/Boat operations work through those explicit capabilities and which remain unavailable. Do not propose my operator account as an execution mode. Wait for my explicit approval before creating an account, copying real directories, granting credentials, installing software or changing launchd.

After my approval, apply only that reviewed installation plan. Set the manifest name to macbook-pro and label to MacBook Pro. Never copy my browser, Keychain, vault, SSH agent, signing key, model subscription or Herdr session. Stop on an unavailable native mechanism. No same-user or unsandboxed fallback is allowed.

Ask me to create a distinct Discord application named MacBook Pro launcher with Message Content intent and channel permissions to view, send, attach files and read history. It must not reuse the Mac Studio application. Collect private IDs without publishing them. I enter its token in the staged launcher's masked token prompt. Other credentials use the setup session's masked secret flow and the reviewed dedicated delegation locations.

Run configure with the reviewed root-private manifest, then check. Show every check result without a credential value. Stop on failure. Ask before installing the daemon. Shared Pots configuration and any pot restart require separate explicit approval, with paid work left undisturbed.

Then ask a selected pot for a harmless prompt, have me read its offer and click, and verify the protected Herdr terminal, restricted UID, selected work, operator watching/takeover and final report. Check replay, unclaimed cancellation/replacement and a stale press after sleep. No gate, signing, VM-root or unsupported credential operation is authorized by this proof. Disable the daemon if native sandbox, provider or protected Herdr interaction cannot be proved. Finish with the exact disable/remove commands for the staged launcher.
```

## Shared Pots setup

The Mac setup does not authorize changes to pots. During the separately approved phase, configure targets for the pots that can request Mac launches and set the launch channel on Mastermind. Apply those settings through `vm-config`. Preserve all other settings and wait while paid work is active.
