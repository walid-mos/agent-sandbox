import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import { sandboxFixture } from './fixtures/sandbox.mjs';

sandboxFixture('human-decisions-');
const vault = { isAccessDenied: true, isWriteUncertain: false, writes: 0 };
beforeEach(() => { Object.assign(vault, { isAccessDenied: true, isWriteUncertain: false, writes: 0 }); });
mock.module('../session/run.mjs', { exports: {
  command: () => JSON.stringify({ labels: { 'pi.session': session } }),
  commandWithInput: async (_binary, args) => {
    if (args[0].endsWith('secret-names.mjs')) {
      if (vault.isAccessDenied) throw new Error('Access denied');
      return;
    }
    vault.writes += 1;
    if (vault.isWriteUncertain) throw new Error('Write response lost');
  },
} });
const { humanStore } = await import('../session/human-store.mjs');
const { openDialog } = await import('../session/human-dialogs.mjs');
const { storeDialogSecret } = await import('../session/human-secrets.mjs');
const { storeSecrets } = await import('../session/pots-secrets.mjs');
let sequence = 0;
const botSource = () => ({ type: 'bot', message: `m-proof-${++sequence}` });
const secretInput = source => ({ kind: 'secret', source, purpose: 'Supply both keys', target: { destination: 'pots', file: 'proof.env', keys: ['FIRST', 'SECOND'] } });

async function openWithCountedWrite() {
  const store = humanStore();
  const dialog = await openDialog(secretInput(botSource()), store);
  const counter = { writes: 0 };
  const write = async () => { counter.writes += 1; return {}; };
  return { store, dialog, counter, write };
}

test('a partial secret submission names missing keys, writes nothing and remains open', async () => {
  const { store, dialog, counter, write } = await openWithCountedWrite();
  await assert.rejects(storeDialogSecret(dialog.id, { FIRST: 'dummy' }, { store, write }), { message: 'human: missing secret keys: SECOND.' });
  assert.equal(counter.writes, 0);
  assert.equal(store.get(dialog.id).result, undefined);
  assert.equal(Boolean(store.get(dialog.id).writing), false);
  await storeDialogSecret(dialog.id, { FIRST: 'dummy', SECOND: 'dummy' }, { store, write });
  assert.equal(counter.writes, 1);
});

test('the native pot secret writer refuses partial input before any destination access', async () => {
  await assert.rejects(storeSecrets({ file: 'proof.env', keys: ['FIRST', 'SECOND'] }, '{"FIRST":"dummy"}'), { message: 'human: missing secret keys: SECOND.' });
});

test('a failed write permits concurrent retries but applies only one successful write', async () => {
  const store = humanStore();
  const dialog = await openDialog(secretInput(botSource()), store);
  await store.patch(dialog.id, { delivery: { id: 'proof.retry' } });
  const values = { FIRST: 'dummy', SECOND: 'dummy' };
  const fail = async () => { throw new Error('Destination unavailable'); };
  await assert.rejects(storeDialogSecret(dialog.id, values, { store, write: fail }), /Destination unavailable/);
  assert.equal(store.get(dialog.id).result, undefined);
  assert.equal(Boolean(store.get(dialog.id).writing), false);
  let writes = 0;
  const write = async () => { writes += 1; return {}; };
  const replies = await Promise.all(Array.from({ length: 3 }, () => storeDialogSecret(dialog.id, values, { store, write })));
  assert.equal(writes, 1);
  assert.equal(replies[0].result.status, 'stored');
  assert.deepEqual(replies[1].result, replies[0].result);
  assert.deepEqual(replies[2].result, replies[0].result);
});

test('a failed vault access check stays retryable and concurrent retries write only once', async () => {
  const store = humanStore();
  const dialog = await openDialog({ ...secretInput(botSource()), target: { destination: 'infisical', projectId: 'proof', environment: 'dev', name: 'FIRST' } }, store);
  await assert.rejects(storeDialogSecret(dialog.id, { FIRST: 'dummy' }, { store }), /before writing/);
  assert.equal(Boolean(store.get(dialog.id).writing), false);
  assert.equal(vault.writes, 0);
  vault.isAccessDenied = false;
  await Promise.all([storeDialogSecret(dialog.id, { FIRST: 'dummy' }, { store }), storeDialogSecret(dialog.id, { FIRST: 'dummy' }, { store })]);
  assert.equal(vault.writes, 1);
  assert.equal(store.get(dialog.id).result.status, 'stored');
});

test('an unconfirmed vault write cannot apply again after the boundary recovers', async () => {
  const store = humanStore();
  const dialog = await openDialog({ ...secretInput(botSource()), target: { destination: 'infisical', projectId: 'proof', environment: 'dev', name: 'FIRST', replace: true } }, store);
  vault.isAccessDenied = false;
  vault.isWriteUncertain = true;
  const before = vault.writes;
  await assert.rejects(storeDialogSecret(dialog.id, { FIRST: 'dummy' }, { store }), /outcome is unknown/);
  assert.equal(store.get(dialog.id).writing, true);
  vault.isWriteUncertain = false;
  await assert.rejects(storeDialogSecret(dialog.id, { FIRST: 'dummy' }, { store }), /interrupted/);
  assert.equal(vault.writes, before + 1);
});

test('failure saving a successful receipt never permits a second destination write', async () => {
  const { store, dialog, counter, write } = await openWithCountedWrite();
  const broken = { ...store, locked: (operation, id) => store.locked(({ get, save }) => operation({ get, save: record => {
    if (record.result) throw new Error('Receipt disk unavailable');
    return save(record);
  } }), id) };
  const values = { FIRST: 'dummy', SECOND: 'dummy' };
  await assert.rejects(storeDialogSecret(dialog.id, values, { store: broken, write }), /Receipt disk unavailable/);
  await assert.rejects(storeDialogSecret(dialog.id, values, { store, write }), /interrupted/);
  assert.equal(counter.writes, 1);
});
