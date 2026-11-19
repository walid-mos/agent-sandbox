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

The watcher owns its SQLite cursor and claims under `~/.config/agent-sandbox/discord-auto-threads/`. A delayed poll cannot move a shared cursor backwards or change progress for a different log or activation. Run the watcher with one service configuration. The claim before the POST survives process restart, and Discord enforces one thread per source if the operator starts it at the same time. Disabling clears the cursor and preserves claims, so re-enabling skips disabled time and earlier claims.

One deleted thread still tracked by the routing map or North Star registry can stop all automatic thread creation and Discord Admin mutations when Discord cannot verify its parent. The watcher logs the gateway row ID for the skipped post and can include Discord code `10003`. The row ID identifies the post that was skipped. Use the shared Discord Admin procedure to identify the unresolved thread and have its owner repair the record. [Recover from an unresolved protected thread](discord-admin.md#recover-from-an-unresolved-protected-thread)

The watcher rereads protection on the next eligible post. The saved cursor advances past skipped posts, so the watcher does not retry them. After the repair, use a fresh top-level human post in an already opted-in, unprotected channel during the authorized recovery window. Confirm that a public thread exists under the post and the watcher reports no protection failure for that row.

## Offline verification

Run `node --test session/discord-auto-thread.test.mjs session/discord-auto-thread-watcher.test.mjs session/discord-admin-thread-protection.test.mjs` for the offline regressions. `./bin/check` includes these suites.

## Verify the installed gateway before enabling

In the authorized rollout window, run the following as the session user from the approved source checkout on Mastermind. Use the actual bot home and the Pots executable that runs the gateway. The session wrapper delegates to the upstream executable shown here. [Pots wrapper](../session/pots) · [Executable path](../session/lib.sh)

```sh
bot_home="$HOME/.pots/bots/$(jq -er '.bot | ascii_downcase' /etc/agent-sandbox/sandbox.json)"
pots="$HOME/.local/libexec/pots/bin/pots"
node probes/discord-auto-thread-pots.mjs "$pots" "$bot_home/bot.sqlite"
```

The probe reports the installed version and tests the table definition from Mastermind's existing, Pots-created log using synthetic rows in a disposable database. Record the version and result. It accepts the version verified offline. Keep automatic threads off if the installed version or schema fails the probe, and verify the installed contract before proceeding. [Pots log probe](../probes/discord-auto-thread-pots.mjs)

The probe uses synthetic adapter IDs. To verify the actual account match, use the same bot home in that shell and run the reader against its native log. It uses the sole Discord account's `id` from `bot.json` and checks for a recent `MESSAGE_CREATE` row stored under that adapter ID in `gw_events.channel`. On a readable log, the command reports only whether it found a match. It makes no Discord request.

```sh
node --input-type=module - "$bot_home" <<'NODE'
import { join } from 'node:path';
import { discordAccount } from './session/discord-admin-runtime.mjs';
import { autoThreadInbox } from './session/discord-auto-thread-store.mjs';

const botHome = process.argv[2];
const inbox = autoThreadInbox(join(botHome, 'bot.sqlite'), discordAccount(botHome).id);
try {
  const reader = inbox.refresh();
  const matches = reader.after(Math.max(0, reader.latest() - 1000));
  if (matches.length) {
    console.log('Recent gateway message matches the configured Discord adapter.');
  } else {
    console.error('No recent gateway message matches the configured Discord adapter.');
    process.exitCode = 1;
  }
} finally {
  inbox.close();
}
NODE
```

If there is no match, confirm the bot home and adapter, then have the operator send a fresh ordinary test message through the existing gateway during the rollout window and rerun the read-only check. Keep automatic threads off until both checks pass. Record the result without copying adapter IDs, message content or credentials. After separately authorized activation, use a fresh post in a selected channel to verify end-to-end delivery and thread permissions. [Pots gateway channel registry](https://github.com/Crokily/pi-durable-bot/blob/v0.8.5/src/gateway/channels.ts) · [Pots log writer](https://github.com/Crokily/pi-durable-bot/blob/v0.8.5/src/gateway/log.ts)
