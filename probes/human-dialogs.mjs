import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'human-proof-'));
process.env.HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));
const { humanStore } = await import('../session/human-store.mjs');
const { openDialog, cancelDialog } = await import('../session/human-dialogs.mjs');
const { storeDialogSecret } = await import('../session/human-secrets.mjs');
const { syncSecretPage } = await import('../session/human-pages.mjs');
const { syncBotDialogs } = await import('../session/human-bot.mjs');
const { targetOf } = await import('../session/human-contract.mjs');
const VALUE = 'dummy-browser-value';
const ORIGIN = 'https://example.test';
const CAPABILITY = 'c'.repeat(43);
const HANDOFF = 'a'.repeat(32);
const folder = () => mkdtempSync(join(home, 'case-'));
const source = () => ({ type: 'worker', worker: 'pots-proof', session: '/tmp/proof-session.jsonl', call: randomBytes(8).toString('hex') });

async function owner(t, respond) {
  const directory = folder();
  const socket = join(directory, 'call.sock');
  const received = [];
  const peers = new Set();
  const server = createServer(connection => {
    peers.add(connection);
    connection.on('close', () => peers.delete(connection));
    connection.on('error', () => {});
    let line = '';
    connection.setEncoding('utf8');
    connection.on('data', chunk => {
      line += chunk;
      if (!line.includes('\n')) return;
      const request = JSON.parse(line.slice(0, line.indexOf('\n')));
      received.push(request);
      respond(connection, request);
    });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  chmodSync(socket, 0o600);
  t.after(() => { for (const peer of peers) peer.destroy(); server.close(); });
  return { directory, socket, received };
}

const ack = request => ({ version: 1, dialog: request.dialog, source: request.source, origin: request.origin, handoff: HANDOFF });
const parked = (connection, request) => connection.end(`${JSON.stringify(ack(request))}\n`);
const open = (store, socket) => openDialog({ kind: 'secret', source: source(), purpose: 'Sign in', target: { destination: 'browser', origin: ORIGIN, socket, capability: CAPABILITY } }, store);
const enter = (store, id, origin = 'terminal') => storeDialogSecret(id, { SECRET: VALUE }, { store, origin });

function assertNoLeaks(directory) {
  const records = readdirSync(directory).filter(name => name.endsWith('.json')).map(name => readFileSync(join(directory, name), 'utf8')).join('');
  assert.equal(records.includes(VALUE), false);
  assert.equal(records.includes('sec:'), false);
}

test('a reply after a newer bot question settles only the newer question', async () => {
  const store = humanStore(folder());
  const question = (id, options) => ({ id, type: 'message', person: 'bot', text: `Choose\n\`\`\`question\n${JSON.stringify({ purpose: 'ordinary', options })}\n\`\`\`` });
  const older = question('m-q1', ['Yes', 'No']);
  const newer = question('m-q2', ['Red', 'Blue']);
  await syncBotDialogs(store, [older, newer]);
  await syncBotDialogs(store, [older, newer, { id: 'm-r', type: 'message', person: 'abc', text: 'Red' }]);
  const answers = Object.fromEntries(store.all().map(dialog => [dialog.source.message, dialog.result?.answers ?? null]));
  assert.deepEqual(answers, { 'm-q1': null, 'm-q2': [{ id: 'answer', labels: ['Red'], text: '' }] });
});

test('browser target requires an exact web origin, absolute socket, capability and worker source', async () => {
  const target = { destination: 'browser', origin: ORIGIN, socket: '/tmp/pi-x/call.sock', capability: CAPABILITY };
  for (const change of [{ origin: `${ORIGIN}/login` }, { socket: 'call.sock' }, { capability: 'short' }, { origin: 'file:///tmp' }]) {
    assert.throws(() => targetOf({ ...target, ...change }), /waiting browser tool/);
  }
  await assert.rejects(openDialog({ kind: 'secret', purpose: 'Sign in', source: { type: 'bot', message: 'm-bot' }, target }, humanStore(folder())), /waiting worker tool/);
});

test('one terminal/page winner sends bound input and records only a matching owner receipt', async t => {
  const directory = folder();
  const store = humanStore(directory);
  const pi = await owner(t, parked);
  const dialog = await open(store, pi.socket);
  await store.locked(({ get, save }) => save({ ...get(dialog.id), delivery: { id: 'proof.delivery' } }), dialog.id);
  const [first, second] = await Promise.all([enter(store, dialog.id), enter(store, dialog.id, 'page')]);
  assert.equal(pi.received.length, 1);
  assert.deepEqual(pi.received[0], { version: 1, dialog: dialog.id, source: dialog.source, origin: ORIGIN, capability: CAPABILITY, value: VALUE });
  assert.deepEqual(first.result, { status: 'stored', origin: 'terminal', at: first.result.at, dialog: dialog.id, request: 'proof.delivery', target: { destination: 'browser', origin: ORIGIN }, handoff: HANDOFF });
  assert.deepEqual(second.result, first.result);
  await enter(store, dialog.id);
  assert.equal(pi.received.length, 1);
  assertNoLeaks(directory);
});

const badReplies = {
  'wrong dialog': request => ({ ...ack(request), dialog: 'f'.repeat(32) }),
  'wrong source': request => ({ ...ack(request), source: { ...request.source, call: 'other' } }),
  'wrong origin': request => ({ ...ack(request), origin: 'https://other.test' }),
  'malformed handoff': request => ({ ...ack(request), handoff: 'sec:AAAAAAAAAAAAAAAAAAAAAA' }),
  'extra handle': request => ({ ...ack(request), handle: 'sec:AAAAAAAAAAAAAAAAAAAAAA' }),
  'oversized response': () => 'x'.repeat(5000),
};
for (const [name, reply] of Object.entries(badReplies)) {
  test(`fails closed on ${name} without a second issuance or leaked value`, async t => {
    const directory = folder();
    const store = humanStore(directory);
    const pi = await owner(t, (connection, request) => connection.end(`${JSON.stringify(reply(request))}\n`));
    const dialog = await open(store, pi.socket);
    await assert.rejects(enter(store, dialog.id), { message: 'human: the waiting tool did not confirm the browser handoff. Open a new call.' });
    assert.equal(store.get(dialog.id).writing, true);
    assert.equal(store.get(dialog.id).result, undefined);
    await assert.rejects(enter(store, dialog.id), /interrupted/);
    assert.equal(pi.received.length, 1);
    assertNoLeaks(directory);
  });
}

test('a missing ACK or owner fails closed and never retries', async t => {
  const store = humanStore(folder());
  const pi = await owner(t, connection => connection.end());
  const dialog = await open(store, pi.socket);
  await assert.rejects(enter(store, dialog.id), /did not confirm/);
  await assert.rejects(enter(store, dialog.id), /interrupted/);
  const missing = await open(store, '/tmp/missing-pi-proof/call.sock');
  await assert.rejects(enter(store, missing.id), /no private browser socket/);
});

test('canceled and expired dialogs do not contact the owner', async t => {
  const store = humanStore(folder());
  const pi = await owner(t, parked);
  const canceled = await open(store, pi.socket);
  await cancelDialog(canceled.id, 'cancelled', store);
  assert.equal((await enter(store, canceled.id)).result.status, 'cancelled');
  const expired = await open(store, pi.socket);
  await store.locked(({ get, save }) => save({ ...get(expired.id), expiresAt: 1 }), expired.id);
  await assert.rejects(enter(store, expired.id), /expired/);
  assert.equal(pi.received.length, 0);
});

test('nonprivate socket or parent directory is refused', async t => {
  const store = humanStore(folder());
  const pi = await owner(t, parked);
  chmodSync(pi.socket, 0o666);
  await assert.rejects(enter(store, (await open(store, pi.socket)).id), /no private browser socket/);
  chmodSync(pi.socket, 0o600);
  chmodSync(pi.directory, 0o755);
  await assert.rejects(enter(store, (await open(store, pi.socket)).id), /no private browser socket/);
  assert.equal(pi.received.length, 0);
});

test('a silent owner has a bounded handoff deadline', async t => {
  const store = humanStore(folder());
  const pi = await owner(t, () => {});
  await assert.rejects(enter(store, (await open(store, pi.socket)).id), /did not confirm/);
});

test('a page submission is removed and revoked after success or an uncertain handoff', async t => {
  const bin = folder();
  const log = join(bin, 'calls');
  writeFileSync(join(bin, 'pots'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  mkdirSync(join(home, '.pots/secrets'), { recursive: true, mode: 0o700 });
  for (const respond of [parked, connection => connection.end()]) {
    const directory = folder();
    const store = humanStore(directory);
    const pi = await owner(t, respond);
    const dialog = await open(store, pi.socket);
    await store.locked(({ get, save }) => save({ ...get(dialog.id), pageLink: { id: 'S9' } }), dialog.id);
    const staged = join(home, '.pots/secrets', `human-${dialog.id}.env`);
    writeFileSync(staged, `SECRET=${VALUE}\n`, { mode: 0o600 });
    if (respond === parked) await syncSecretPage(dialog.id, store);
    else await assert.rejects(syncSecretPage(dialog.id, store), /did not confirm/);
    assert.equal(existsSync(staged), false);
    const completed = await syncSecretPage(dialog.id, store);
    assert.equal(completed.pageRevoked, true);
    assert.equal(pi.received.length, 1);
    assertNoLeaks(directory);
  }
  assert.match(readFileSync(log, 'utf8'), /page unlink/);
});
