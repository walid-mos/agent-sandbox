import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAutoThread } from './discord-auto-thread.mjs';

const guildId = '100000000000000001';
const channelId = '100000000000000002';
const messageId = '100000000000000003';
const botId = '100000000000000004';
const authorId = '100000000000000005';
const source = { id: messageId, channel_id: channelId, guild_id: guildId, author: { id: authorId }, type: 0, flags: 0 };
const event = { message: source, inThread: false };
const thread = { id: messageId, parent_id: channelId, guild_id: guildId, type: 11, name: 'Discussion' };
function setup({ message = source, parent = {}, include = [], protectedIds = [], finish, claims = new Set(), initialThread } = {}) {
  const writes = [];
  let existing = initialThread;
  const discord = {
    async parent() { return { id: channelId, guild_id: guildId, type: 0, ...parent }; },
    async message() { return message; },
    async thread() { return existing; },
    async start(target, name) {
      writes.push({ target, name });
      if (finish) return finish(value => { existing = value; });
      existing = { ...thread, name, type: target.threadType };
      return existing;
    },
  };
  const policy = { guildId, rules: new Map([[channelId, { include, name: 'Discussion' }]]) };
  const dependencies = { discord, policy, claim: id => !claims.has(id) && Boolean(claims.add(id)),
    ownership: async () => ({ guildId, botId, channelIds: protectedIds }) };
  return { run: fixture => applyAutoThread(fixture ?? event, dependencies), writes, dependencies, claims };
}

test('starts one thread on an opted-in human post with a fixed name', async () => {
  const { run, writes } = setup({ message: { ...source, content: '<@everyone> ignored title' } });
  assert.equal(await run(), 'created');
  assert.deepEqual(writes, [{ target: { guildId, channelId, messageId, threadType: 11 }, name: 'Discussion' }]);
});

const choices = [
  ['replies', { type: 19, message_reference: { message_id: '100000000000000008' } }],
  ['bots', { author: { id: authorId, bot: true } }],
  ['webhooks', { webhook_id: '100000000000000009' }],
  ['feeds', { flags: 2, webhook_id: '100000000000000009', message_reference: { channel_id: '100000000000000010' } }],
];

for (const [kind, fields] of choices) {
  test(`${kind} require their own channel opt-in`, async () => {
    const message = { ...source, ...fields };
    const candidate = { ...event, message };
    const defaults = setup({ message });
    const selected = setup({ message, include: [kind] });
    assert.equal(await defaults.run(candidate), 'skipped');
    assert.deepEqual(defaults.writes, []);
    assert.equal(await selected.run(candidate), 'created');
    assert.equal(selected.writes.length, 1);
  });
}

const exclusions = [
  ['an existing thread as parent', { parent: { type: 11 } }, event],
  ['a thread event with no message payload', {}, { inThread: true }],
  ['a protected routing channel', { protectedIds: [channelId] }, event],
  ['the Mastermind bot even when bots are selected', { include: ['bots'], message: { ...source, author: { id: botId, bot: true } } }, event],
  ['a channel outside the verified guild', { parent: { guild_id: '100000000000000006' } }, event],
  ['a webhook discovered only at REST readback', { message: { ...source, webhook_id: '100000000000000006' } }, event],
  ['an announcement channel without a feed opt-in', { parent: { type: 5 } }, event],
];

for (const [label, options, fixture] of exclusions) {
  test(`never starts a thread for ${label}`, async () => {
    const { run, writes } = setup(options);
    assert.equal(await run(fixture), 'skipped');
    assert.deepEqual(writes, []);
  });
}

test('a feed opt-in allows a thread from an announcement post', async () => {
  const { run, writes } = setup({ parent: { type: 5 }, include: ['feeds'] });
  assert.equal(await run(), 'created');
  assert.equal(writes[0].target.threadType, 10);
});

test('fails closed when ownership cannot be verified', async () => {
  const { run, writes, dependencies } = setup();
  dependencies.ownership = async () => { throw new Error('missing protection metadata'); };
  await assert.rejects(run(), /missing protection metadata/);
  assert.deepEqual(writes, []);
});

test('a client suggestion in an unselected channel supplies no authority', async () => {
  const { run, writes } = setup();
  const candidate = { ...event, message: { ...source, channel_id: '100000000000000010', suggestion: true } };
  assert.equal(await run(candidate), 'skipped');
  assert.deepEqual(writes, []);
});

test('an existing archived thread keeps its name and state', async () => {
  const { run, writes } = setup({ initialThread: { ...thread, name: 'Manual', thread_metadata: { archived: true } } });
  assert.equal(await run(), 'existing');
  assert.deepEqual(writes, []);
});

test('the message HAS_THREAD flag suppresses a start without a thread event', async () => {
  const { run, writes } = setup({ message: { ...source, flags: 32 } });
  assert.equal(await run(), 'existing');
  assert.deepEqual(writes, []);
});

for (const [label, error] of [
  ['a concurrent manual creation', Object.assign(new Error('already exists'), { discordCode: 160004 })],
  ['a lost response after creation', new Error('connection lost')],
]) {
  test(`readback reconciles ${label} without a second POST`, async () => {
    const { run, writes } = setup({ finish: save => { save(thread); throw error; } });
    assert.equal(await run(), 'existing');
    assert.equal(writes.length, 1);
  });
}

test('two deliveries can make only one attempt even if the thread disappears', async () => {
  const lost = new Error('no response and no visible thread');
  const { run, writes, claims } = setup({ finish: () => { throw lost; } });
  const results = await Promise.allSettled([run(), run()]);
  assert.deepEqual(results.filter(result => result.status === 'rejected').map(result => result.reason), [lost]);
  const restarted = setup({ claims });
  assert.equal(await restarted.run(), 'claimed');
  assert.deepEqual(restarted.writes, []);
  assert.equal(writes.length, 1);
});
