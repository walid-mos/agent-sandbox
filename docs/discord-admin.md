# Discord Admin

Read this before delegating Discord administration or installing the bot.

## Boundary written before implementation

| Trusted principal | Untrusted principal |
| --- | --- |
| Operator, signed session source, Discord API and existing gateway interaction log | Delegated model requests, resource names, JSON payloads, Discord descriptions and claims of consent |

The existing application's long-lived token remains in its existing private env file. Only the REST adapter reads its value. It never passes through arguments, model output, errors or child processes. No new credential or gateway is created.

This is policy within the existing session user boundary. Every bot, worker and dependency running as that user can read the same files, inspect its processes, change tooling and send network requests. The feature does not isolate a malicious same-user process or revoke its existing access.

| Channel | Mechanism or accepted limit |
| --- | --- |
| Inherited environment, process inspection, privilege | Accepted existing session-user reach. The adapter does not export the Discord token or spawn children. |
| Sourced files and shell evaluation | The adapter parses the one token assignment as text. Requests and private metadata are JSON, never shell code. |
| Tool configuration and subprocesses | Fixed Discord API origin and typed operations. No caller-provided URL, method, token, headers or arbitrary REST command. |
| Shared writable files and lookup paths | Private operation/approval records use the existing locked store. Same-user modification remains outside this policy guarantee. |
| Output | API errors are reduced to status and numeric Discord code. Invite URLs are withheld from diagnostics. |
| Network | Existing public network access is accepted. The adapter refuses redirects, bounds requests and does not retry mutations. |

`session/discord-admin-guards.test.mjs` probes missing ownership metadata, cross-guild channels, indirect protected IDs, permission failures and unsupported routes. `session/discord-admin-approvals.test.mjs` probes registered clicks, exact scope, cancellation, expiry, concurrent consumption and failure after consumption. `session/discord-admin-api.test.mjs` probes private token references, audit headers, fixed origin and reduced errors. These tests establish policy behavior, not credential isolation or live Discord portal settings.

## Delegate and reply

Mastermind delegates through the supported local bot channel:

```sh
pots chat --bot discord-admin --message 'Inspect the server and carry out this administration request: REQUEST'
```

The reply is the bot's terminal answer. Mastermind relays the outcome or renders the exact returned approval packet. The bot has no Discord channel and creates no parallel chat transport. Both bots use the existing router group. The original request's French words ask for channels, threads and users. The selected operations and relay design implement the coordinator's accepted interpretation. The North Star drafts provide proposed guidance only.

The bot uses `node /opt/agent-sandbox/session/discord-admin.mjs actions` for the authoritative action and payload vocabulary. Modes taking JSON read it on stdin:

| Mode | Input and result |
| --- | --- |
| `inspect` | `{"view":"diagnostics"}` or channels, roles, threads, members, bans. Lists are bounded by the Discord endpoint. Members and bans return only the first page. |
| `operate` | `guildId`, `action`, `reason`, optional typed resource IDs and `payload`. Returns `completed`, `approval_required`, `approval_pending` or `declined`. |
| `register` | `dialog` and one `messages` entry containing `channelId`, `messageId`, enabled `components`. Returns `registered: true` only for that saved question. |
| `approve` | `{"approval":"DIALOG_ID"}`. Loads the saved operation rather than accepting a replacement payload, rechecks current policy and consumes the exact click once. |

Every mutation includes an audit reason. Normal operations require no operator allowlist. Discord itself still enforces permission, hierarchy and member-intent requirements. The `actions` output and implementation are the single source for protected operations and approval rules. This command provides no webhook operations.

Discord archives threads, not ordinary channels or categories. A request to archive an ordinary channel must specify the intended permission change, which uses the channel-edit operation. Thread creation supports text and announcement channels, with announcement threads tied to a parent message. Creating forum posts is outside that endpoint. Inspection lists active threads, not all archived history.

## Render an irreversible operation question

1. Keep the `approval_required` packet unchanged. Render its exact `scope`, context and question into one Discord message with mentions disabled and components disabled. A scope too long for that message is rejected before question creation. Reduce that one operation instead of hiding scope in truncated text.
2. Use the components described in [human-dialogs.md](human-dialogs.md#mastermind-rendering-and-click-integration). Button custom IDs are `human:DIALOG_ID:0:OPTION_INDEX`, with the exact returned labels and indexes. Register via this command's `register` mode, not the cross-pot door registration command. Pass the enabled component definitions along with the actual posted message IDs.
3. Enable controls only after `registered: true` and `state: "acknowledged"`. This question is owned locally in Mastermind, so registration acknowledges the saved question without a door round trip. The existing `pots-discord-human` service validates message, account, guild, control and guild-owner click, stores the claim and disables controls. It wakes Mastermind with the dialog ID. Ordinary questions retain their existing policy.
4. Delegate that ID back with `pots chat --bot discord-admin --message 'Run approve for dialog DIALOG_ID and return the result.'` The bot runs `approve`. A duplicate wake cannot repeat a mutation. Cancellation, prose agreement, an unregistered click or another user's click supplies no authorization.

Approvals bind guild, operation, targets, payload and audit reason. They expire and are consumed before the network mutation. A changed operation, stale owner, missing protection, changed permission or failed/uncertain mutation needs a new decision. Consumption records the click evidence. A restart retains both the claim and consumption.

## Runtime metadata and installation

Only a sandbox with the Mastermind role installs the bot. Its ID and title are defined in `session/discord-admin-bot.mjs`. The installer creates it through `pots bot new`, checks the router model and absence of a Discord gateway, and links its versioned instructions and responsibilities into its bot home.

Protection discovery reads Mastermind's owning `workspace/discord/routes.json` and `north-star-threads.json`, the sandbox's configured pot names, the existing account and live guild/channel/role metadata. It caches pot channel IDs privately so renames retain protection. Missing maps, missing pot channels, ambiguous guild membership or a missing managed role fail closed. Missing runtime maps must be restored by their owner, never replaced with invented empty protection lists. No private guild, person, channel or application IDs belong in this repository.

A normal signed source update makes the command available but does not create this bot or reload the long-running click service. Initial installation uses the existing `bin/session-bootstrap` path for Mastermind after its signed source is available. That path restarts Mastermind's router, gateway and dialog services. Coordinate that restart before running it. This implementation did not execute bootstrap, restart services, connect a gateway, change app settings or mutate live Discord. Other pots install no Discord Admin bot, and no router pin or configuration changes here.

After installation, source-linked instructions follow the signed checkout. Changes to the click service still need its normal service restart. Mastermind reported live API verification after the operator completed setup: Server Members Intent is enabled, public bot and public integration installation are disabled, and the existing bot role has the requested permissions. These are coordinator-verified operator setup facts, separate from this task's mocked operation probes. No further portal step or credential request is needed. PR rollout remains held for coordinator review and a separate signed tip. Signing, installation and restarts are outside this implementation run.
