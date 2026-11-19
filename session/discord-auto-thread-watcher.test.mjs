import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { autoThreadDiscord } from './discord-auto-thread-api.mjs';
import { autoThreadPolicy } from './discord-auto-thread-policy.mjs';
import { autoThreadInbox, autoThreadState, UnsupportedPotsLog } from './discord-auto-thread-store.mjs';
import { autoThreadPoll } from './discord-auto-thread-watcher.mjs';

const guildId = '100000000000000001';
const channelId = '100000000000000002';
const botId = '100000000000000004';
const authorId = '100000000000000005';
const messageId = number => `1000000000000000${String(number).padStart(2, '0')}`;
const account = 'mastermind-discord';
const startTime = Date.parse('2026-11-19T10:00:00.000Z');
const config = { role: 'mastermind', discordAdmin: { enabled: true }, discordAutoThreads: { guildId, channels: { [channelId]: {} } } };

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'feat-discord-auto-threads-'));
  const logPath = join(folder, 'bot.sqlite');
  const statePath = join(folder, 'state.sqlite');
  let writer = makeLog(logPath);
  const readers = [];
  t.after(() => {
    readers.forEach(reader => reader.close());
    writer.close();
    rmSync(folder, { recursive: true, force: true });
  });
  function makeLog(path, columns = 'channel TEXT, inbox_event TEXT, kind TEXT, thread TEXT, raw TEXT') {
    const connection = new DatabaseSync(path);
    connection.exec(`CREATE TABLE gw_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ${columns})`);
    return connection;
  }
  function replaceLog(columns) {
    const replacement = join(folder, 'replacement.sqlite');
    writer.close();
    makeLog(replacement, columns).close();
    renameSync(replacement, logPath);
    writer = new DatabaseSync(logPath);
  }
  const messages = new Map();
  const calls = [];
  function add(number, { channel = account, dispatch = 'MESSAGE_CREATE', kind = 'message', thread, at = startTime, fields } = {}) {
    const id = messageId(number);
    const message = { id, guild_id: guildId, channel_id: channelId, timestamp: new Date(at).toISOString(), type: 0, author: { id: authorId }, ...fields };
    messages.set(id, message);
    writer.prepare('INSERT INTO gw_events (channel, inbox_event, kind, thread, raw) VALUES (?, ?, ?, ?, ?)')
      .run(channel, `${dispatch}:gateway-session:${number}`, kind, thread ?? null, JSON.stringify(message));
  }
  async function api(method, path, body, reason) {
    if (method === 'POST') {
      calls.push({ method, path, body, reason });
      return { id: path.split('/')[4], guild_id: guildId, parent_id: channelId, type: 11 };
    }
    if (path === `/channels/${channelId}`) return { id: channelId, guild_id: guildId, type: 0 };
    if (path.includes('/messages/')) return messages.get(path.split('/').at(-1));
    throw Object.assign(new Error('unknown channel'), { discordCode: 10003 });
  }
  const errors = [];
  let clock = startTime;
  function connect(configuration = config, now, ownership = async () => ({ guildId, botId, channelIds: [] })) {
    const state = autoThreadState(statePath);
    const inbox = autoThreadInbox(logPath, account);
    readers.push(state, inbox);
    const dependencies = { policy: autoThreadPolicy(configuration), discord: autoThreadDiscord(api), ownership };
    const poll = autoThreadPoll(inbox, state, dependencies, message => errors.push(message), () => now ?? clock);
    return { poll, state };
  }
  return { add, calls, connect, errors, replaceLog, advanceClock: time => { clock = time; }, clearRows: () => writer.exec('DELETE FROM gw_events') };
}

test('the watcher uses only fresh message rows from the existing Discord account', async t => {
  const { add, calls, connect, errors } = fixture(t);
  add(10);
  const { poll } = connect();
  add(11, { kind: 'system', dispatch: 'THREAD_CREATE', fields: { newly_created: true } });
  add(12, { channel: 'slack' });
  add(13, { thread: 'discord:#thread' });
  add(14, { at: startTime - 1000 });
  add(15);
  add(16, { fields: { author: { id: authorId, bot: true } } });
  add(17, { dispatch: 'history' });
  await poll();
  assert.deepEqual(calls, [{ method: 'POST', path: `/channels/${channelId}/messages/${messageId(15)}/threads`,
    body: { name: 'Discussion' }, reason: 'Automatic thread under Mastermind private channel rule' }]);
  assert.deepEqual(errors, []);
});

test('a restart processes retained rows and keeps the durable message claims', async t => {
  const { add, calls, connect } = fixture(t);
  const { poll } = connect();
  add(10);
  await poll();
  add(10);
  add(11);
  await connect(config, startTime + 1000).poll();
  assert.deepEqual(calls.map(call => call.path.split('/')[4]), [messageId(10), messageId(11)]);
});

test('a changed rule or disable then enable starts at the log tail', async t => {
  const { add, calls, connect } = fixture(t);
  const original = connect();
  add(10);
  const changed = { ...config, discordAutoThreads: { guildId, channels: { [channelId]: { name: 'New posts' } } } };
  const { poll, state } = connect(changed, startTime + 1000);
  add(11, { at: startTime + 1000 });
  await original.poll();
  await poll();
  state.disable();
  add(12, { at: startTime + 1000 });
  await poll();
  assert.equal(state.progress(), undefined);
  const resumed = connect(changed, startTime + 1000);
  await resumed.poll();
  assert.deepEqual(calls.map(call => [call.path.split('/')[4], call.body.name]), [[messageId(11), 'New posts']]);
});

test('a running reader reopens an atomically replaced log at the tail and ignores history', async t => {
  const { add, calls, connect, replaceLog, advanceClock } = fixture(t);
  const { poll } = connect();
  add(10);
  await poll();
  replaceLog();
  const resetTime = startTime + 1000;
  advanceClock(resetTime);
  add(11, { at: resetTime });
  await poll();
  add(12, { dispatch: 'history', at: resetTime });
  add(13, { at: resetTime });
  add(14, { at: startTime });
  await poll();
  assert.deepEqual(calls.map(call => call.path.split('/')[4]), [messageId(10), messageId(13)]);
});

test('a delayed watcher cannot move a shared cursor backwards', async t => {
  const { add, calls, connect } = fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const owned = { guildId, botId, channelIds: [] };
  const slow = connect(config, startTime, async () => { entered.resolve(); return release.promise; });
  const fast = connect();
  add(10);
  const pending = slow.poll();
  await entered.promise;
  add(11);
  try { await fast.poll(); }
  finally { release.resolve(owned); await pending; }
  assert.equal(fast.state.progress().cursor, 2);
  assert.deepEqual(calls.map(call => call.path.split('/')[4]), [messageId(10), messageId(11)]);
});

test('an unsupported replacement pauses reads without advancing progress and recovers at the next supported tail', async t => {
  const { add, calls, connect, replaceLog } = fixture(t);
  const { poll, state } = connect();
  add(10);
  await poll();
  const saved = state.progress();
  replaceLog('channel TEXT, kind TEXT, thread TEXT, raw TEXT');
  await assert.rejects(poll(), UnsupportedPotsLog);
  assert.deepEqual(state.progress(), saved);
  replaceLog();
  add(11);
  await poll();
  add(12);
  await poll();
  assert.deepEqual(calls.map(call => call.path.split('/')[4]), [messageId(10), messageId(12)]);
});

test('pruning every row keeps the cursor and the activation cutoff for the same log', async t => {
  const { add, connect, clearRows } = fixture(t);
  const { poll, state } = connect();
  add(10);
  await poll();
  const saved = state.progress();
  clearRows();
  await poll();
  assert.deepEqual(state.progress(), saved);
});

test('the feature requires Mastermind, Discord Admin activation and a nonempty rule list', () => {
  const disabled = [{ ...config, role: undefined }, { ...config, discordAdmin: {} }, { ...config, discordAutoThreads: undefined },
    { ...config, discordAutoThreads: { guildId, channels: {} } }];
  for (const configuration of disabled) assert.equal(autoThreadPolicy(configuration), undefined);
});

test('invalid channel rule shapes fail closed', () => {
  for (const channels of [{ '*': {} }, { [channelId]: { include: ['everything'] } }, { [channelId]: { name: 'a\u0000b' } }]) {
    assert.throws(() => autoThreadPolicy({ ...config, discordAutoThreads: { guildId, channels } }), /valid channel rules/);
  }
});

test('thread lookup only treats Discord Unknown Channel as absent', async () => {
  const refused = Object.assign(new Error('missing access'), { discordCode: 50001 });
  const discord = autoThreadDiscord(async () => { throw refused; });
  await assert.rejects(discord.thread({ messageId: messageId(10) }), refused);
});
