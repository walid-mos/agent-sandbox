# Questions, approvals and secrets from Discord

The owning pot keeps the answer record. Mastermind displays its questions in Discord and relays clicks with their audit metadata.

```mermaid
sequenceDiagram
    autonumber
    participant A as Agent or work center
    participant P as Owning pot
    participant M as Mastermind
    participant D as Discord
    A->>P: Register immutable question and scope
    P->>M: Door request with question block
    M->>D: Post disabled question messages
    M->>P: Register posted message context
    M->>D: Enable registered components
    D->>M: Operator click
    M->>M: Check identity and commit first pick
    M->>D: Show answered and disable components
    M-->>P: Reply with answers and click evidence
    P->>P: Check origin, message, scope and first answer
    P->>A: Complete waiting dialog
    P-->>M: Answered notification
    M->>D: Show the owning pot's final answer
```

## Private configuration

Ordinary questions have no role, permission or user allowlist check. The operator waived those checks for the server they use alone. The handler still requires the exact registered message and originating request and stores the actual clicker, time and message link.

Push approvals stay off until this PR is merged and verified live. After that rollout is authorized, configure `humanDiscord.userId` privately and enable `humanDiscord.pushApprovalsEnabled` in each involved pot's `/etc/agent-sandbox/sandbox.json`. Push acceptance compares the clicker with that one operator ID. Missing or disabled configuration rejects push clicks. Never commit personal identifiers, message links containing them, or runtime answer records.

Secret pages require Pots' `publicUrl` and `pagePort` in `~/.pots/settings.json`. Publish the loopback page port with `tailnet-link`, then set `publicUrl` to that exact HTTPS origin. Changing an existing public URL can break old links, so check its existing links and obtain authorization before changing it. The bridge checks Tailscale Serve's mapping and rejects a public URL that is absent, unrelated to the loopback page port, or enabled for Funnel. It never starts a tunnel or changes Serve.

Read the installed Pots `pages` and `discord-channel` skills when setting up pages or rendering questions. The private page is Pots' supported `pots page secret` page. Mastermind posts its link through `pots call` with `flags: 4` to suppress previews. A secret value never belongs in a Discord field, form, message, door payload or model result.

## Ownership and durable state

The human store owns records under `~/.config/agent-sandbox/human/`. A dialog's source identifies it across restarts. Reopening that source with different questions, scope, policy or destination fails. Separate file locks serialize changes to each dialog, and atomic renames publish records. Results contain answers or a secret write receipt, never secret values.

The agent must use the store for terminal submissions as well as external submissions. The first result committed in the owning pot wins. Mastermind independently commits the first click for each question before updating Discord. Its immediate acknowledgement says delivery is pending. A terminal answer that reached the owning store first remains authoritative, even if a click is still travelling through a door. The final notification corrects Discord to that answer.

Mastermind's private Discord records hold its registered messages, first picks, pending message updates and answer deliveries. Its reader queries the supported `gw_events` interaction log without selecting interaction tokens. Message edits use the supported `pots call` command, whose token stays inside the gateway. Polling and message edits run without a model turn. Only the actual gateway and Discord server can establish click-to-edit latency.

```mermaid
stateDiagram-v2
    [*] --> Waiting
    Waiting --> Answered: First accepted answer
    Waiting --> Paused: Discuss in terminal
    Waiting --> Cancelled: Cancel in terminal
    Waiting --> Expired: Secret deadline
    Answered --> ReportPending
    Paused --> ReportPending
    Cancelled --> ReportPending
    Expired --> ReportPending
    ReportPending --> Reported: Door confirmation
    ReportPending --> ReportPending: Retry same request ID
```

| Failure | What remains |
| --- | --- |
| Door undelivered or unknown | The saved request is retried under its original ID. |
| Door refused | The record retains the refusal and the terminal remains available. |
| Invalid answer or operator evidence | No answer is committed and the dialog records the issue. |
| Relay or watcher restart | Requests, receipts, pending Discord edits and deliveries remain on disk. |
| Answered notification arrives before rendering | Mastermind saves a closure record and refuses later registration. |
| Secret writer or browser handoff interrupted | The dialog records an uncertain write, removes the page's staging file, revokes its link and refuses another write. A new call is needed. |

## Door packets

Use `node /opt/agent-sandbox/session/doors.mjs ask|reply|resend|requests` on installations whose bare `pots` lacks those commands. The session wrapper supports the same operations. Transport still authenticates only a neighbouring pot. The explicit operator-click rule permits the narrowly checked answer packet below, not arbitrary neighbour text.

Question requests have a context line followed by a fenced `question` block. Its JSON is:

```json
{"type":"human.question","version":1,"dialog":"DIALOG_ID","for":"ORIGINAL_REQUEST_ID","digest":"QUESTION_DIGEST","policy":"push","scope":"Push feat/example to origin, commits FULL_SHA_A and FULL_SHA_B, one push","context":"May I push these commits?","questions":[{"id":"push","prompt":"May I push these commits?","multiple":false,"options":[{"label":"Push these commits","detail":"One push to origin","recommended":true},{"label":"Keep local","detail":"","recommended":false}]}]}
```

A work-center question block may set `"for":"REQUEST_ID"` to keep its original thread. `for` is omitted when no original request exists. It is in the packet because the door wire does not transmit the local `--for` field. Human notices keep this association in their packet instead of depending on an original request that may close before a retry. The digest comes from the shared question-digest function over the dialog ID, normalized questions, context, policy and exact approval scope. Labels travel unchanged. `policy` is `ordinary`, `push` or `local`. Local questions are not offered to Discord.

Mastermind sends an additional door request before enabling its messages:

```json
{"type":"human.posted","version":1,"dialog":"DIALOG_ID","request":"QUESTION_DOOR_ID","digest":"QUESTION_DIGEST","guildId":"CONFIGURED_GUILD_ID","at":"ISO_TIMESTAMP","messages":[{"question":"push","messageUrl":"https://discord.com/channels/GUILD/CHANNEL/MESSAGE"}]}
```

Register one distinct message for every question. The pot replies `{"type":"human.posted-ack","version":1}`. Unknown or undelivered requests are resent with the same ID. `human.posted` ties subsequent click evidence to the actual question messages.

Mastermind replies to the original question door request once every question has an answer:

```json
{"type":"human.answer","version":1,"dialog":"DIALOG_ID","request":"QUESTION_DOOR_ID","digest":"QUESTION_DIGEST","answers":[{"id":"push","labels":["Push these commits"],"text":""}],"clicks":[{"question":"push","userId":"CONFIGURED_OPERATOR_ID","guildId":"CONFIGURED_GUILD_ID","messageUrl":"https://discord.com/channels/GUILD/CHANNEL/MESSAGE","at":"ISO_CLICK_TIMESTAMP"}]}
```

`labels` can hold several exact labels for a multiple choice. A free answer has `labels: []` and its words in `text`. Each answer names its stable question ID. `clicks` preserves evidence for every question, including a questionnaire answered across several messages. The pot checks the stored door's direction, Mastermind origin, request ID, question ID, digest and registered message context. Only a push also requires the configured operator ID and enabled rollout switch. Approval receipts preserve the exact scope, digest, question IDs and evidence. A later push needs its own question and receipt.

Whenever a question completes, including in the terminal, the pot sends a new door request because the original cannot be withdrawn:

```json
{"type":"human.answered","version":1,"dialog":"DIALOG_ID","request":"QUESTION_DOOR_ID","digest":"QUESTION_DIGEST","status":"answered","origin":"terminal","answers":[{"id":"push","labels":["Keep local"],"text":""}]}
```

Mastermind updates all registered messages, disables their components, discards pending conflicting deliveries, and replies `{"type":"human.answered-ack","version":1}`. Treat an early notification as a closure record. The same mechanism carries `cancelled`, `paused`, `expired` or the `stored` receipt for a secret. Secret notifications contain no values or keys' contents.

A secret request sends only metadata and the owning pot's supported page link:

```json
{"type":"human.secret-link","version":1,"dialog":"DIALOG_ID","for":"ORIGINAL_REQUEST_ID","purpose":"Connect the issue tracker","url":"https://POT.TAILNET.ts.net:PORT/s/OPAQUE_PAGE_REFERENCE","expiresAt":0}
```

`expiresAt` is the owning dialog's deadline in Unix milliseconds. The URL is a one-time bearer page reference. Anyone who can read the Discord message and reach the tailnet origin may submit it. Link previews are not access control, and submission does not establish the operator's identity. Use this page only to write the declared secret destination, never as approval. It carries no vault credential or entered secret. Mastermind posts it with previews suppressed and never submits it itself.

## Agent-pi integration

Agent-pi must adopt this contract in its own repository. Reading a Pi transcript and injecting terminal keys cannot arbitrate a simultaneous terminal answer safely. The key-based pane route remains available for unpublished dialogs, but those dialogs are not relayed to Discord.

Invoke `node /opt/agent-sandbox/session/human.mjs open` with JSON on stdin when a dialog opens:

```json
{"kind":"question","source":{"type":"worker","worker":"WORKER_NAME","session":"ABSOLUTE_PI_SESSION_PATH","call":"TOOL_CALL_ID"},"policy":"ordinary","context":"Choose a deployment target","questions":[{"id":"target","prompt":"Choose a deployment target","multiple":false,"options":[{"label":"Preview","detail":"","recommended":true},{"label":"Production","detail":"","recommended":false}]}]}
```

Use the session path from the terminal's `pi.session` label. The CLI inherits the worker's `servedRequest` when dispatch started it with `--for`. Work without that association goes to the pot's channel. Use `policy: "push"` and a complete immutable `scope` for one push approval. Other actions needing special approval stay local until a separate contract is authorized. Do not infer push approvals from labels or classify them as ordinary.

Keep the returned `id`. Poll `human.mjs get ID` while the terminal stays interactive. Submit the terminal's normalized answer through `human.mjs answer ID` with `{"answers":[...]}` on stdin, then use the receipt it returns. A competing answer may already have won. The tool result must preserve the receipt's scope and evidence. Map labels back to Pi option values only after validation. Watching the external receipt must close the dialog and render it as answered. Cancel or abort through `cancel ID`, and Discuss through `pause ID` before returning Pi's paused result. A resumed dialog needs a new tool-call source and must preserve its draft state.

For `ask_user_secret` with an Infisical target, register:

```json
{"kind":"secret","source":{"type":"worker","worker":"WORKER_NAME","session":"ABSOLUTE_PI_SESSION_PATH","call":"TOOL_CALL_ID"},"purpose":"Connect the issue tracker","target":{"destination":"infisical","projectId":"PROJECT_ID","environment":"dev","path":"/","name":"ISSUE_TRACKER_TOKEN","replace":false}}
```

The broker also accepts `destination: "pots"` with `file` and `keys`. Terminal secret input goes only through `human.mjs secret ID` on stdin. The CLI returns metadata. The supported page writes a unique private staging file. The pot notices it, claims the same dialog lock, writes the declared destination, and returns `stored` only after the writer confirms success. On success or cancellation it revokes its link and removes its staging file. A relay restart resumes from that file and the private record. It never examines or cleans another dialog's page or file.

Agent-pi must complete its waiting secret tool from that receipt without requesting the value again.

### Browser secrets

A browser target hands the value to the waiting Pi tool. That tool parks it with its own origin-bound frontend secret API in the same process. The broker never sees, stores or returns the resulting `sec:` handle, and no vault or file receipt stands in for one.

The waiting tool call creates a random private folder (mode 0700), one socket in it (mode 0600) and an unpredictable capability of 43 to 256 URL-safe characters. It registers this target, which only trusted local processes see. No door packet, Discord message, log or tool result carries it.

```json
{"kind":"secret","source":{"type":"worker","worker":"WORKER_NAME","session":"ABSOLUTE_PI_SESSION_PATH","call":"TOOL_CALL_ID"},"purpose":"Sign in to the issue tracker","target":{"destination":"browser","origin":"https://tracker.example.com","socket":"/run/user/1000/pi-human-RANDOM/call.sock","capability":"CAPABILITY"}}
```

`origin` must equal its own `URL.origin`, so it has no path and no default port. The socket path is absolute and at most 107 bytes. Only worker sources take a browser target. The page and the terminal use the single key `SECRET`, so terminal input is `{"SECRET":"VALUE"}` on `human.mjs secret ID`. Run that command asynchronously, because the broker connects to the tool's socket while it runs.

After a submission wins the dialog lock, the broker checks that the socket and its folder belong to its user, with modes 0600 and 0700 respectively. It then sends one JSON line:

```json
{"version":1,"dialog":"DIALOG_ID","source":{"type":"worker","worker":"WORKER_NAME","session":"ABSOLUTE_PI_SESSION_PATH","call":"TOOL_CALL_ID"},"origin":"https://tracker.example.com","capability":"CAPABILITY","value":"VALUE"}
```

The socket input is at most 65536 UTF-8 bytes. The tool checks the capability, dialog, canonical source, origin and its pending state, and parks the value once. It generates a separate handoff ID of 32 random lowercase hexadecimal characters, keeps the handle in memory and replies with one line holding exactly these fields:

```json
{"version":1,"dialog":"DIALOG_ID","source":{"type":"worker","worker":"WORKER_NAME","session":"ABSOLUTE_PI_SESSION_PATH","call":"TOOL_CALL_ID"},"origin":"https://tracker.example.com","handoff":"HANDOFF_ID"}
```

The broker waits at most 10 seconds or the dialog's remaining lifetime and reads at most 4096 UTF-8 bytes. Any other reply fails the write, including one with an extra field such as a handle, a closed connection or a missed deadline. Only a matching reply commits the receipt, which `human.mjs get ID` returns as `result`:

```json
{"status":"stored","origin":"page","at":0,"dialog":"DIALOG_ID","request":"QUESTION_DOOR_ID_IF_PRESENT","target":{"destination":"browser","origin":"https://tracker.example.com"},"handoff":"HANDOFF_ID"}
```

The receipt's `origin` is where the value was entered, `page` or `terminal`. `target.origin` is the browser origin. `request` is omitted when no delivery was registered. The tool checks `dialog`, and `request` against `view.delivery.id` when present. It completes only when `handoff` and `target.origin` match the handle it parked. A failed handoff leaves the dialog with `isWriting: true` and no result. The broker then refuses any second write, removes the page's staging file and revokes its link. When the tool has no matching receipt within its own deadline, it discards any parked value, runs `human.mjs cancel ID` and returns a failure that requires a new call. Cancellation, expiry, tool exit and completion close the socket. Nothing retries with a second handoff or falls back to the vault.

## Mastermind rendering and click integration

Post each question as a separate Discord message with disabled components first. Use the Discord channel skill's supported components and stored forms. Respect Discord's content and component limits when rendering context. The renderer must show the exact approval scope before the person clicks.

Custom IDs use zero-based question and option indexes:

| Input | Custom ID and submitted value |
| --- | --- |
| Single-choice button | `human:DIALOG_ID:QUESTION_INDEX:OPTION_INDEX` |
| Multiple select | `human:DIALOG_ID:QUESTION_INDEX:select`, values are decimal option indexes |
| Free answer | Stored form button `form:human-answer:DIALOG_ID:QUESTION_INDEX`, text input custom ID `answer` |

A stored form opens through Pots' gateway and is accepted only on its modal-submit event. Never use a Discord form for secrets.

Run `node /opt/agent-sandbox/session/discord-human.mjs register` with this registration on stdin:

```json
{"request":"QUESTION_DOOR_ID","pot":"OWNER_POT","channelAccount":"discord","guildId":"GUILD_ID_FROM_POSTED_MESSAGE","question":{"type":"human.question","version":1,"dialog":"DIALOG_ID","digest":"QUESTION_DIGEST","policy":"ordinary","context":"Choose","questions":[{"id":"target","prompt":"Choose","multiple":false,"options":[{"label":"Preview"},{"label":"Production"}]}]},"messages":[{"channelId":"CHANNEL_ID","messageId":"MESSAGE_ID","components":[{"type":1,"components":[{"type":2,"style":1,"label":"Preview","custom_id":"human:DIALOG_ID:0:0"},{"type":2,"style":2,"label":"Production","custom_id":"human:DIALOG_ID:0:1"}]}]}]}
```

Use the exact received packet, not a reconstruction. The helper checks it against the stored incoming door request and sends `human.posted`. Enable the messages only after registration succeeds. Keep the enabled component definitions in the registration so the helper can disable them after a click. The Mastermind session service reads interactions and retries edits and replies independently of its model. Do not run the old model-driven click helper on these custom IDs.

Live verification belongs in Mastermind's pot: confirm its gateway stores standard Discord interaction objects in `gw_events.raw`, that component and modal submissions retain the originating message ID, and that `pots call` can edit those messages. Measure authorized click-to-edit time there, including duplicate clicks and gateway restarts. Verify an ordinary click needs no operator allowlist and that clicks in a different registered-message context cannot commit an answer. After the merged rollout is enabled, verify a push click requires the one configured operator ID. A canceled question must display its canceled state, never an answer or consent. This checkout cannot establish those live facts or inspect the Mac's pane.
