import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileDiscord } from './pr-board-delivery.mjs';
import { runBoardPass } from './pr-board-pass.mjs';
import { BOARD_ACK, sectionPackets } from './pr-board-contract.mjs';

function memory() {
  let state = { sources: {}, events: {}, discord: {}, publisher: {} };
  return { read: () => structuredClone(state), save: next => { state = structuredClone(next); } };
}
const configuration = { enabled: true, sources: { alpha: [] } };
function discordFixture() {
  const calls = [];
  let count = 0;
  return { calls, client: {
    create: async (content, nonce) => { calls.push({ operation: 'create', content, nonce }); return `10000000000000${++count}`; },
    edit: async (id, content) => calls.push({ operation: 'edit', id, content }),
    pin: async id => calls.push({ operation: 'pin', id }),
    link: id => `https://discord.com/channels/10000000000000001/10000000000000002/${id}`,
  } };
}

test('disabled board pass touches no store, source, transport or Discord dependency', async () => {
  const forbidden = new Proxy({}, { get: () => assert.fail('Disabled board touched a dependency') });
  await runBoardPass({ configuration: { enabled: false }, store: forbidden, source: forbidden, doors: forbidden, discord: forbidden });
});

test('Discord delivery pins one index, coalesces unchanged content and throttles calls', async () => {
  const store = memory();
  const { client, calls } = discordFixture();
  for (const now of [1000, 1001, 3000, 5000, 7000, 9000]) await reconcileDiscord({ store, configuration, client, now });
  assert.equal(calls.filter(call => call.operation === 'create').length, 1);
  assert.equal(calls.filter(call => call.operation === 'pin').length, 1);
  const before = calls.length;
  await reconcileDiscord({ store, configuration, client, now: 11000 });
  assert.equal(calls.length, before);
});

test('receiver service saves the authenticated section and acknowledges it without any model dependency', async () => {
  const store = memory();
  const request = { id: 'alpha.12345678', pot: 'alpha', kind: 'board', direction: 'received', state: 'open', need: JSON.stringify(sectionPackets([], 1000)[0]) };
  const replies = [];
  const { client } = discordFixture();
  await runBoardPass({ store, configuration, isMastermind: true, pot: 'mastermind', now: 1000, discord: client,
    source: { collect: () => assert.fail('Unconfigured local source was read') },
    doors: { all: () => [request], reply: async (id, body) => replies.push({ id, body }) }, onError: assert.fail });
  assert.equal(store.read().sources.alpha.current.publishedAt, 1000);
  assert.deepEqual(replies, [{ id: 'alpha.12345678', body: BOARD_ACK }]);
});

test('publisher restart retains its packet and request ID until an exact acknowledgement', async () => {
  const store = memory();
  let collections = 0;
  let preparations = 0;
  const delivered = [];
  let request;
  const options = { store, configuration: { enabled: true }, isMastermind: false, pot: 'alpha',
    source: { collect: () => { collections += 1; return []; }, events: () => [] },
    doors: { find: () => request, prepare: () => { preparations += 1; return request = { id: 'alpha.12345678', state: 'unknown' }; },
      transmitAsync: async current => { delivered.push(current.id); return delivered.length === 1 ? current : { ...current, state: 'answered', reply: BOARD_ACK }; } }, onError: assert.fail };
  await runBoardPass({ ...options, now: 1000 });
  assert.equal(store.read().publisher.outbox[0].request, 'alpha.12345678');
  await runBoardPass({ ...options, now: 31000 });
  assert.deepEqual(store.read().publisher.outbox, []);
  assert.equal(collections, 1);
  assert.equal(preparations, 1);
  assert.deepEqual(delivered, ['alpha.12345678', 'alpha.12345678']);
});

test('uncertain Discord create retries its saved nonce after restart', async () => {
  const store = memory();
  const nonces = [];
  const client = { create: async (_content, nonce) => { nonces.push(nonce); throw new Error('uncertain'); } };
  await assert.rejects(reconcileDiscord({ store, configuration, client, now: 1000 }), /uncertain/);
  await assert.rejects(reconcileDiscord({ store, configuration, client, now: 3000 }), /uncertain/);
  assert.equal(nonces.length, 2);
  assert.equal(nonces[0], nonces[1]);
  assert.ok(nonces[0].length <= 25);
});
