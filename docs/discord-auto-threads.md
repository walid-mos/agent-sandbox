# Automatic Discord threads

Mastermind can start a public thread from a new Discord message in a privately selected channel.

| Trusted principal | Untrusted input |
| --- | --- |
| Mastermind's signed service, the operator's private channel rules, the existing account and Discord REST responses | Gateway event addresses, message text, authors, client suggestions and claims of consent |

The rule reuses the application's existing token reference under the [Discord Admin boundary](discord-admin.md#boundary-written-before-implementation). A log row supplies a candidate source address. The service reads the parent and source from Discord, checks the private rule and Mastermind's protection metadata, and uses the configured thread name and a fixed audit reason. Message text stays out of the log query, thread name and diagnostics. The service makes no model call. The trust limits of the existing session user still apply.

## Discord contract

The documented bot event and message fields expose no client thread suggestion. `MESSAGE_CREATE` supplies the candidate; `THREAD_CREATE` can report a completed creation or access to a thread. The manual creation in `#accor` at 09:54 UTC establishes that a thread was created. The trigger for automation is the private channel rule. [Gateway events](https://docs.discord.com/developers/events/gateway-events#message-create), [message fields](https://docs.discord.com/developers/resources/message#message-object).

Pots writes Discord messages with the raw message and records thread creation as a system event. The watcher reads `MESSAGE_CREATE` rows from the existing account's `gw_events` log. It ignores system and history rows and uses REST readback to reconcile the same thread ID when `THREAD_CREATE` is lost. [Pots Discord adapter](https://github.com/Crokily/pi-durable-bot/blob/v0.8.5/src/channels/discord/index.ts), [thread creation event](https://docs.discord.com/developers/events/gateway-events#thread-create).

`POST /channels/{channel.id}/messages/{message.id}/threads` creates a thread with the source message's ID. Discord permits one thread per source and returns `160004` if one already exists. `GET /channels/{message.id}` reads the thread, including archived threads the account can see. [Start thread from message](https://docs.discord.com/developers/resources/channel#start-thread-from-message), [get channel](https://docs.discord.com/developers/resources/channel#get-channel), [Discord error codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes#json-json-error-codes).

## Install and configure

Use the existing Mastermind gateway and Discord Admin installation. The application must have exactly one guild, the `GUILDS` and `GUILD_MESSAGES` gateway intents, and `VIEW_CHANNEL`, `READ_MESSAGE_HISTORY` and `CREATE_PUBLIC_THREADS` in selected channels. The rule needs no additional message-content access. Restore any missing channel, route or North Star protection metadata through its owner before enabling the rule. [Discord Admin installation](discord-admin.md#runtime-metadata-and-installation), [gateway intents](https://docs.discord.com/developers/events/gateway#list-of-intents), [permissions](https://docs.discord.com/developers/topics/permissions#permissions-bitwise-permission-flags).

After the approved, signed source reaches Mastermind, an authorized operator sets `discordAutoThreads` in Mastermind's private `/etc/agent-sandbox/sandbox.json`. `discordAdmin.enabled` must already be `true`. Omit `discordAutoThreads` or set its `channels` to an empty object to keep the rule off. A signed source update alone leaves the feature off. Apply the operator-side private configuration with `SANDBOX=mastermind ./bin/vm-config`. In the approved window, run `SANDBOX=mastermind ./bin/session-bootstrap` or restart the existing `pots-discord-human` service if the gateway and Discord Admin prerequisites are already installed. Configuration changes take effect when that service starts. No other pot uses these settings.

The following example uses synthetic IDs. Each channel key opts in that exact channel. An empty object accepts ordinary top-level human posts with the name `Discussion`. The `name` setting is static and `include` adds selected sources for that channel only.

```json
{
  "discordAutoThreads": {
    "guildId": "100000000000000001",
    "channels": {
      "100000000000000002": {},
      "100000000000000003": { "name": "Feed discussion", "include": ["feeds"] }
    }
  }
}
```

| `include` entry | Additional source |
| --- | --- |
| `replies` | Discord replies in the selected parent channel |
| `bots` | Posts by other bots |
| `webhooks` | Ordinary webhook posts |
| `feeds` | Discord crossposts and otherwise eligible posts in announcement channels. A crosspost is treated as a feed even when Discord delivers it through a webhook. |

The rule always excludes the Mastermind bot's posts, interaction responses, forwarded messages, system messages, messages inside threads, and channels reserved for pots, routing or North Stars. A channel used for routing such as `#accor` remains reserved if Mastermind's metadata lists it. Leave ordinary text channels reserved for feeds out of the channel map when their posts cannot be identified by Discord metadata. The rule cannot join, rename, unarchive, delete or replace an existing thread.

## Delivery and recovery

| Event | Result |
| --- | --- |
| First activation, changed rules, or a replaced gateway log | Open the current file on the next poll, start at its tail, and require a source timestamp on or after that reset. Rows already in the replacement log are skipped. |
| Unsupported gateway log schema | Pause automatic threads and log the schema error. Retry on later polls without advancing progress or claiming messages until a supported log is readable. |
| Restart with the same active rules and log | Read retained rows after the saved cursor. A saved claim prevents another POST, including after a thread disappears. |
| Existing thread or concurrent manual creation | Keep the existing thread. The message's thread flag and channel readback recognize it. After a POST error the service verifies the thread ID, guild, parent and type before accepting readback. |
| Crash after claiming, rate limit, refused POST or unresolved response | The watcher may leave the post without a thread. It sends at most one automatic POST per claimed message and logs request failures it observes. Inspect Discord before manual action. |
| A message never reaches the Pots log | A missing `MESSAGE_CREATE` cannot trigger the rule. A resumed gateway session can deliver missed events. Pots history backfill after a new session does not trigger the rule. |

The watcher owns its SQLite cursor and claims under `~/.config/agent-sandbox/discord-auto-threads/`. A delayed poll cannot move a shared cursor backwards or change progress for a different log or activation. Run the watcher with one service configuration. The claim before the POST survives process restart, and Discord enforces one thread per source if the operator starts it at the same time. Disabling clears the cursor and preserves claims, so re-enabling skips disabled time and earlier claims. If Discord cannot resolve a protected thread or report its parent, the watcher skips creation under the same protection rules as Discord Admin.

## Offline verification

Run `node --test session/discord-auto-thread.test.mjs session/discord-auto-thread-watcher.test.mjs session/discord-admin-thread-protection.test.mjs` for the offline regressions. `./bin/check` includes these suites.

Pots v0.8.5 is the version verified offline. Run `node probes/discord-auto-thread-pots.mjs /path/to/pots /path/to/bot.sqlite` against that installed executable and a local log it created. The probe reads only the installed table definition and exercises the watcher query with synthetic rows in a disposable SQLite file. The tagged Discord adapter and gateway log writer define the dispatch, account and raw-message fields the probe uses. Other versions need the same contract check before enabling the rule. Verify Mastermind's event delivery and channel permissions in the authorized rollout window. [Pots Discord adapter](https://github.com/Crokily/pi-durable-bot/blob/v0.8.5/src/channels/discord/index.ts)
