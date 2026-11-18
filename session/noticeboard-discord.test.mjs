import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fixture, authorId, channelId, messageId, threadId, guildId, copyId } from '../probes/fixtures/noticeboards.mjs';
import { noticeboardDiscord } from './noticeboard-discord.mjs';
import { noticeboardDiscordInbox } from './noticeboard-discord-inbox.mjs';
import { noticeboardPass } from './noticeboard-worker.mjs';
import { noticeboardStore } from './noticeboard-store.mjs';
import { noticeboardServicePass } from './noticeboard-service.mjs';

const account = 'fixture-discord';
const appUserId = '88888888888888888';
const createdAt = '2026-01-01T12:00:00.000Z';
const reference = { id: messageId, channel_id: channelId, guild_id: guildId };
const message = { ...reference, type: 19, content: 'Exact @everyone\ntext', timestamp: createdAt, edited_timestamp: null,
  author: { id: authorId, username: 'fixture-user', global_name: 'Fixture Person' }, attachments: [], components: [], embeds: [],
  pinned: false, flags: 0, message_reference: { type: 0, message_id: threadId, channel_id: channelId, guild_id: guildId } };

function gatewayDatabase(t) {
  const folder = mkdtempSync(join(tmpdir(), 'noticeboard-inbox-'));
  const path = join(folder, 'bot.sqlite');
  const database = new DatabaseSync(path);
  database.exec('CREATE TABLE gw_events (id INTEGER PRIMARY KEY, channel TEXT, kind TEXT, raw TEXT)');
  t.after(() => { database.close(); rmSync(folder, { recursive: true, force: true }); });
  return { folder, path, insert: (id, channel, kind, raw) => database.prepare('INSERT INTO gw_events VALUES (?, ?, ?, ?)').run(id, channel, kind, JSON.stringify(raw)) };
}

 test('gateway reads only scoped event references, including partial edits and deletes', t => {
  const gateway = gatewayDatabase(t);
  gateway.insert(1, account, 'message', message);
  gateway.insert(2, account, 'edit', { ...reference, content: 'An edit', referenced_message: message });
  gateway.insert(3, account, 'delete', reference);
  gateway.insert(4, 'other-account', 'message', reference);
  gateway.insert(5, account, 'message', { ...reference, channel_id: threadId });
  gateway.insert(6, account, 'message', { ...reference, guild_id: appUserId });
  gateway.insert(7, account, 'edit', { t: 'MESSAGE_UPDATE', d: reference });
  const { channels } = fixture().configuration;
  const read = noticeboardDiscordInbox(gateway.path, { account, channels });
  assert.deepEqual(read(1), [{ id: 2, channelId, messageId, kind: 'update' }, { id: 3, channelId, messageId, kind: 'delete' }]);
});

function ownerCalls(context, source = message) {
  const methods = [];
  let posted;
  const call = async (channelAccount, method, body) => {
    assert.equal(channelAccount, account);
    methods.push(method);
    if (method === `GET /channels/${channelId}/messages/${messageId}`) return source;
    if (method === `POST /channels/${threadId}/messages`) {
      assert.deepEqual(body.allowed_mentions, { parse: [], users: [], roles: [], replied_user: false });
      posted = { id: copyId, channel_id: threadId, author: { id: appUserId, bot: true }, content: body.content, attachments: [] };
      return { id: copyId, channel_id: threadId };
    }
    if (method === `GET /channels/${threadId}/messages/${copyId}`) return posted;
    assert.fail(`Unexpected route: ${method}`);
  };
  const adapter = noticeboardDiscord({ account, appUserId, channels: context.configuration.channels, call });
  return { client: { ...context.client, ...adapter }, methods, posted: () => posted, replaceCopy: change => { posted = { ...posted, ...change }; } };
}

 test('publishes and verifies one exact attributed text archive in the configured thread', async () => {
  const context = fixture();
  const { client, methods, posted } = ownerCalls(context);
  await noticeboardPass({ ...context, client });
  assert.deepEqual(methods, [`GET /channels/${channelId}/messages/${messageId}`, `POST /channels/${threadId}/messages`, `GET /channels/${threadId}/messages/${copyId}`]);
  const [attribution, manifest] = posted().content.split('\n', 2);
  assert.match(attribution, /Fixture Person/);
  const { original } = JSON.parse(manifest);
  assert.equal(original.content, 'Exact @everyone\ntext');
  assert.equal(original.createdAt, createdAt);
  assert.equal(original.reply.messageId, threadId);
  assert.equal(context.store.records()[0].reason, 'conditional-delete-unavailable');
  assert.deepEqual(context.effects, ['react']);
});

test('a partial edit reacts to the same original linked by the verified thread copy', async t => {
  let store;
  t.after(() => store?.close());
  const gateway = gatewayDatabase(t);
  gateway.insert(1, account, 'edit', { ...reference, content: 'Incomplete event snapshot' });
  const context = fixture();
  const { channels } = context.configuration;
  const readEvents = noticeboardDiscordInbox(gateway.path, { account, channels });
  const { client, methods, posted } = ownerCalls(context, { ...message, edited_timestamp: createdAt });
  store = noticeboardStore(join(gateway.folder, 'archive.sqlite'));
  const reactions = [];
  const react = (route, id) => reactions.push({ channelId: route.channelId, messageId: id });

  await noticeboardServicePass({ ...context, client: { ...client, readEvents, react }, store });

  const [record] = store.records();
  const [, manifest] = posted().content.split('\n', 2);
  const { original } = JSON.parse(manifest);
  assert.deepEqual(reactions, [{ channelId, messageId }]);
  assert.deepEqual(reactions[0], { channelId: original.channelId, messageId: original.id });
  assert.equal(original.content, 'Exact @everyone\ntext');
  assert.deepEqual(record.copy, { id: copyId, channelId: threadId });
  assert.equal(record.stage, 'verified');
  assert.equal(record.reason, 'conditional-delete-unavailable');
  assert.equal(store.cursor(), 1);
  assert.deepEqual(store.events(), []);
  assert.equal(methods.some(method => method.startsWith('DELETE ')), false);
  assert.deepEqual(context.effects, []);
});

 test('unsupported attachment transport holds before reaction or publication', async () => {
  const context = fixture();
  const { client, methods } = ownerCalls(context, { ...message, attachments: [{ id: copyId, filename: 'synthetic.txt', size: 5 }] });
  await noticeboardPass({ ...context, client });
  assert.deepEqual(methods, [`GET /channels/${channelId}/messages/${messageId}`]);
  assert.deepEqual(context.effects, []);
  assert.equal(context.store.records()[0].reason, 'attachment-transport-unavailable');
});

for (const [label, change] of [['readback identity', { id: appUserId }], ['shared app author', { author: { id: authorId, bot: true } }], ['webhook origin', { webhook_id: copyId }]]) {
  test(`does not verify a copy with the wrong ${label}`, async () => {
    const context = fixture();
    const { client, replaceCopy } = ownerCalls(context);
    const readCopy = client.readCopy;
    client.readCopy = (identity, route) => {
      replaceCopy(change);
      return readCopy(identity, route);
    };
    await noticeboardPass({ ...context, client });
    assert.equal(context.store.records()[0].reason, 'copy-verification-failed');
  });
}

 test('a lost text POST response remains unknown without a second send', async () => {
  const context = fixture();
  const { client, methods } = ownerCalls(context);
  const createCopy = client.createCopy;
  client.createCopy = async (...args) => { await createCopy(...args); throw new Error('unconfirmed'); };
  await noticeboardPass({ ...context, client });
  await noticeboardPass({ ...context, client, event: undefined, now: context.now + 10_000 });
  assert.deepEqual(methods, [`GET /channels/${channelId}/messages/${messageId}`, `POST /channels/${threadId}/messages`]);
  assert.equal(context.store.records()[0].stage, 'copy-unknown');
});
