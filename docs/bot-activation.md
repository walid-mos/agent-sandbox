# Activate a registered bot

Mastermind uses this command to install an optional bot after a checked owner decision. Follow the provider rollout and live cancellation procedure for the installed Discord approval service. [Discord Admin rollout](discord-admin-activation.md)

## Run from Mastermind

The provider sets `botActivation` in the private `sandbox.json`. Each registered bot has its own boolean key and defaults to disabled. The installed source supplies the bot definition and approval handler.

Run `node /opt/agent-sandbox/session/bot-activate.mjs BOT_ID` with one of these modes.

| Mode | Effect |
| --- | --- |
| `status` | Reports whether the bot is disabled, awaiting approval, pending installation, or active. Use `pots status` to check current bot health. |
| `prepare` | Returns the exact approval scope and a disabled display. Post the returned message through the existing shared application. |
| `register` | Accepts the returned dialog ID and its one display's channel and message IDs on stdin. Enable the exact controls after `registered: true` and `state: "acknowledged"`. |
| `apply DIALOG_ID` | Checks the current owner and registration, records the decision, installs the fixed bot and confirms it with the running Pots gateway. |

If installation stops after approval, `status` returns `installation_pending` and the original approval ID. Restore Pots and retry that ID. The same signed scope and current owner must still match. A change to the pending scope or a conflicting bot home requires provider inspection. A completed installation returns `already_active` on repeat.

## Trust boundary

| Trusted principal | Untrusted input |
| --- | --- |
| The operator who signs the installed source and sets the private opt-in, the registered approval adapter and its verified owner, the installed approval service, the existing Pots gateway | CLI input, bot and door text, proposed displays, unregistered clicks and claims written by an older handler |

The installed registry is the only source of bot definitions and permitted approval handlers. An opt-in names a registered bot and carries a boolean. The public command accepts only a registry ID, a mode and mode-specific input. Each approval binds the bot, its installed definition and instructions, its handler and the issuing session. The adapter adds and verifies its own authority and display context. The Discord owner adapter serves Discord Admin and Session Status. Session Status reads local Pots status and has a terminal channel. The adapter uses the shared Discord application's existing long-lived token. Only its REST adapter reads the token. Bot activation adds no credential or privilege.

| Channel | Mechanism |
| --- | --- |
| Inherited environment, process inspection and privilege | Pots and the installer run as the session user. The Discord adapter keeps its token in process memory. The command uses no provider, Docker, supervisor or host control. |
| Sourced files, lookup paths and subprocesses | The signed registry fixes the instruction directory and the approval handler. The installed Pots CLI receives separate arguments. JSON never supplies executable code, a path, service name or command line. |
| Writable files and state | A per-bot lock serializes installation. The approval adapter saves consumption before Pots runs. Resume uses that exact receipt and scope. The session user already controls its dialog files, gateway log and bot home. These checks assume that user and its installed tools are intact. |
| Output and network | The generic installer uses the existing local gateway. The Discord adapter verifies the exact registered display, shared application and current guild owner. It exposes approval status and dialog evidence without token values. |

The public CLI fixtures cover distinct registered bots, cross-bot receipt refusal, exact scope, repeat invocation and interrupted installation. The Discord fixtures exercise wrong authors, altered displays, wrong owners, cancellation, stale-handler clicks and Discord failure. Old handlers can keep their startup imports after signed source rolls forward. An installed handler must record the approved verifier revision before a click can enable a bot. On the first rollout to a session whose running handler lacks that verifier, the provider restarts `pots-discord-human` through the installed service lifecycle. Future bots using the same verifier reuse the running handler.
