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

The reply is the bot's terminal answer. Mastermind posts it as [the hand-off](#reply-hand-off-and-message-identity) says, or renders the exact returned approval message. The bot has no Discord channel and creates no parallel chat transport. Both bots use the existing router group. The original request's French words ask for channels, threads and users. The selected operations and relay design implement the coordinator's accepted interpretation. The North Star drafts provide proposed guidance only.

The bot uses `node /opt/agent-sandbox/session/discord-admin.mjs actions` for the authoritative action and payload vocabulary. Modes taking JSON read it on stdin:

| Mode | Input and result |
| --- | --- |
| `inspect` | `{"view":"diagnostics"}` or channels, roles, threads, members, bans. Lists are bounded by the Discord endpoint. Members and bans return only the first page. |
| `operate` | `guildId`, `action`, `reason`, optional typed resource IDs and `payload`. Returns `completed`, `approval_required`, `approval_pending` or `declined`. |
| `register` | `dialog` and one `messages` entry containing `channelId` and `messageId`. Reads the actual bot-authored message and verifies its canonical content and disabled controls before acknowledging it. |
| `approve` | `{"approval":"DIALOG_ID"}`. Loads the saved operation rather than accepting a replacement payload, rechecks current policy and consumes the exact click once. |

Every mutation includes an audit reason. Normal operations require no operator allowlist. Local checks cover selected permission and hierarchy conditions, including non-Administrator channel overwrites. They do not predict every Discord refusal, including equal-position role ordering, ban target hierarchy and implicit permission dependencies. Discord remains the final authority. The `actions` output and implementation are the single source for protected operations and approval rules. This command provides no webhook operations.

Discord archives threads, not ordinary channels or categories. A request to archive an ordinary channel must specify the intended permission change, which uses the channel-edit operation. Thread creation supports text and announcement channels, with announcement threads tied to a parent message. Creating forum posts is outside that endpoint. Inspection lists active threads, not all archived history.

## Reply hand-off and message identity

Discord Admin posts nothing itself. Its answer to Mastermind names each text and where it goes:

```text
Reply: OUTCOME FOR THE REQUESTER
Server log: CHANGE. Reason: AUDIT REASON
```

- `Reply` goes to the thread of the request Mastermind is serving.
- Each `Server log` line reports one completed change with the audit reason sent to Discord, and goes to the server log channel. An answer that changed nothing has no such line.

Mastermind posts both as text that pings nobody, under its voice identity `discord-admin`. Mastermind's own posting helper holds that identity's webhook, avatar and display name and the server log channel ID. They live in Mastermind's runtime and never in this repository. The voice shows as `Server Admin`, because Discord refuses a webhook name containing "discord". `Discord Admin` stays the Pots bot title.

Approval questions keep the shared application's name and avatar. Registration and click acceptance require the message author to be the application's own bot user, so a voice copy of the canonical message stays unregistered and its clicks claim nothing. `session/discord-admin-approvals.test.mjs` probes that with a webhook-authored copy. Post an `approval_required` message, like every dialog, only through the shared application account as the next section describes, never through the voice helper.

## Render an irreversible operation question

1. Post the exact `message` body returned with `approval_required` through Mastermind's existing Discord account. The trusted renderer includes the full saved scope as literal JSON, escapes formatting controls, disables mentions and creates disabled approval buttons. Never reconstruct, shorten or append to that body. Oversized scopes are rejected before question creation.
2. Register the actual returned message IDs via this command's `register` mode. Registration fetches the message from Discord and checks its author, channel, complete canonical content, controls and absence of attachments or embeds. Caller-supplied component definitions supply no authority. Incorrect content leaves the question unregistered.
3. Enable those exact controls only after `registered: true` and `state: "acknowledged"`. This question is owned locally in Mastermind, so registration acknowledges the verified saved question without a door round trip. The existing `pots-discord-human` service verifies the full bot-authored message snapshot in the gateway interaction before accepting the owner click. Text-only events, omitted snapshots and changed content or controls claim nothing. A later message edit cannot replace the operation the person approved. The service stores the claim, disables controls and wakes Mastermind with the dialog ID. Ordinary questions retain their existing policy.
4. Delegate that ID back with `pots chat --bot discord-admin --message 'Run approve for dialog DIALOG_ID and return the result.'` The bot runs `approve`. A duplicate wake cannot repeat a mutation. Cancellation, prose agreement, an unregistered click or another user's click supplies no authorization.

Approvals bind guild, operation, targets, payload and audit reason. They expire and are consumed before the network mutation. A changed operation, stale owner, missing protection, changed permission or failed/uncertain mutation needs a new decision. Consumption records the click evidence. A restart retains both the claim and consumption.

## Runtime metadata and installation

Only a sandbox with the Mastermind role installs the bot. Its ID and title are defined in `session/discord-admin-approvals.mjs`. The installer creates it through `pots bot new`, checks the router model and absence of a Discord gateway, and links its versioned instructions and responsibilities into its bot home.

Protection discovery validates Mastermind's owning `workspace/discord/routes.json` and `north-star-threads.json` against the contracts its coordinator supplied, alongside configured pot names, the existing account and live guild/channel/role metadata. Routes are keyed by door request ID and protect `channel`, `thread` and optional `origin.channel`. Generic `message` fields are validated but never treated as channels. The North Star registry requires its type/version, overview message URL, thread entries, starter message URLs and posts. Exact Discord URLs must match this guild, and only channel/thread path components are protected. Missing fields, unknown fields, empty required maps or wrong URL/guild shapes fail closed. Sanitized fixtures under `probes/fixtures/discord-admin-metadata/` follow these owner-supplied runtime formats. It caches pot channel IDs privately so renames retain protection. Missing maps, missing pot channels, ambiguous guild membership or a missing managed role fail closed. Missing runtime maps must be restored by their owner, never replaced with invented empty protection lists. No private guild, person, channel or application IDs belong in this repository.

The feature defaults off through the private switch documented under [human-dialogs.md private configuration](human-dialogs.md#private-configuration). While off, every CLI mode refuses before reading credentials or making network requests, and bootstrap creates no bot. No private setting is changed by this PR. A signed source update alone therefore activates nothing. Initial installation requires a separately authorized enable setting and the existing `bin/session-bootstrap` path for Mastermind after its separate signed source tip is available. That path restarts Mastermind's router, gateway and dialog services. Coordinate that restart before running it. This implementation did not execute bootstrap, restart services, connect a gateway, change app settings or mutate live Discord. Other pots install no Discord Admin bot, and no router pin or configuration changes here.

After installation, source-linked instructions follow the signed checkout. Changes to the click service still need its normal service restart. Mastermind reported live API verification after the operator completed setup: Server Members Intent is enabled, public bot and public integration installation are disabled, and the existing bot role has the requested permissions. These are coordinator-verified operator setup facts, separate from this task's mocked operation probes. No further portal step or credential request is needed. PR rollout remains held for coordinator review and a separate signed tip. Signing, installation and restarts are outside this implementation run.
