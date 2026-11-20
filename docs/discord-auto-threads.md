# Discord task threads

Mastermind assigns one Discord thread to each task it accepts. Ordinary chat, feed posts, client thread suggestions and questions in `#decisions` do not admit tasks. A real task is work Mastermind has accepted to do or route, with an expected outcome and an owning pot or coordinator.

## Stable task identity

Mastermind allocates an opaque `taskId` once, at admission, and saves it in its own runtime. The ID survives retries, follow-ups, handoffs and changes of owning pot. Mastermind maps each routed door request to that ID. A task split across pots keeps one ID and one thread. Discord message IDs, pot names, worker and PR IDs, and door request IDs are references to the task. A follow-up requires a known task association before it can reuse the thread. If the association is unclear, resolve it before allocating or posting a starter.

Mastermind owns the task-to-thread record and is the only component that may create or adopt the task thread. Save the verified guild and parent as `guildId` and `channelId`. Save the canonical Discord `threadId` once it is known. For a new thread, also save one `starterMessageId` in the chosen parent before attempting creation. Save the starter under the task ID before handing off work that could race to create a thread. Serialize admission and starter selection in the owning runtime and assign each starter or canonical thread to at most one task.

## Source contract

The local resolver reads a task ID and Mastermind's already admitted records. Its output gives Mastermind the next thread target. It has no Discord or credential access. The signed source can be exercised offline with synthetic IDs.

```sh
printf '%s\n' '{"task-37":{"guildId":"100000000000000001","channelId":"100000000000000002","starterMessageId":"100000000000000003"}}' |
  node session/discord-task-thread.mjs task-37
```

| Result | Mastermind action |
| --- | --- |
| `none` | No target. Continue chat, or finish admission and save the canonical address or starter first. |
| `reuse` | Use the saved `threadId` after verifying the thread ID, guild, parent and thread type. If the thread is archived, inaccessible or missing, reconcile the same binding through the owner before posting. |
| `ensure-from-starter` | The returned `threadId` is both the starter message ID and the expected thread ID. Read that channel ID first. Adopt a verified match, or start a thread from that same message if Discord confirms absence. |

If Mastermind's routed-task path already owns or created a thread, feed its verified canonical `threadId` to the resolver and use `reuse`. A pot, a watcher and a second runtime must not create threads from route copies or follow-up messages. Keep `routes.json` in its existing format and point each relevant route at the canonical thread. Keep task identities and route-to-task references in Mastermind's owning runtime. [Task thread resolver](../session/discord-task-thread.mjs) · [Routing metadata](discord-admin.md#runtime-metadata-and-installation)

Discord uses the starter message ID for a thread started from a message and permits one thread per starter. When a start request races with manual creation, returns `160004`, or has an uncertain result, read the expected thread ID and verify its guild, parent and type before saving it. Reuse the same saved starter for retry and readback across restarts. If a starter post or standalone thread creation had an uncertain outcome, reconcile it in the owning runtime before creating anything else. Adopt an existing thread only after checking that it belongs to this task. [Start thread from message](https://docs.discord.com/developers/resources/channel#start-thread-from-message) · [Discord error codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes#json-json-error-codes)

## Where updates go

Mastermind posts detailed progress, proof and follow-ups inside the canonical task thread. It posts meaningful milestones and outcomes at top level using the owning pot's existing webhook voice and includes a link to the task thread. Route replies give Mastermind the details it needs to post in both places. Question messages in `#decisions` keep their existing rendering, registration, acknowledgement and exact receipts. A message in a task thread grants no approval. [Human-dialog contract](human-dialogs.md)

## Verify

Run `node --test session/discord-task-thread.test.mjs` for task eligibility, stable starter selection on retry, and reuse of a canonical thread across pots. For authorized rollout, Mastermind must first map its admitted records and routed request references to this contract. Verify one real task across a retry and a follow-up routed to another pot, with one canonical thread and a matching top-level outcome. Check that ordinary chat opens no task and that a `#decisions` click still yields the exact receipt for its registered question.
