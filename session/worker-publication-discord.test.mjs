import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approval, CLICK, fixture, git, humanStore, IDENTITY, OPTIONS, publishWorker, remoteHeads, sandbox, workerScope } from '../probes/fixtures/worker-publication.mjs';

const { openDialog, answerQuestion } = await import('./human-dialogs.mjs');
const { consumeDiscordPush, consumePush } = await import('./human-consume.mjs');
const [LABEL] = OPTIONS;
let sequence = 0;

async function answeredTerminal(scope, policy = 'push') {
  const dialog = await openDialog({ kind: 'question', source: { type: 'bot', message: `terminal-${++sequence}` }, policy, scope,
    questions: [{ id: 'push', prompt: 'Publish?', options: OPTIONS }] });
  await answerQuestion(dialog.id, { answers: [{ id: 'push', labels: [LABEL], text: '' }] });
  return dialog.id;
}

test('publication refuses a terminal push answer even when the scope and selection match', async () => {
  const f = fixture();
  const { scope } = workerScope([f.worker.name]);
  const id = await answeredTerminal(scope);
  await assert.rejects(publishWorker([f.worker.name, id, LABEL]), /checked receipt for its registered Discord request/);
  assert.equal(humanStore().get(id).consumption, undefined);
  assert.equal(remoteHeads(f), '');
});

test('publication refuses a missing dialog or an ordinary Discord answer with the exact scope', async () => {
  const f = fixture();
  const { scope } = workerScope([f.worker.name]);
  await assert.rejects(publishWorker([f.worker.name, '0'.repeat(32), LABEL]), /scoped push question/);
  const id = await approval(scope, { policy: 'ordinary' });
  await assert.rejects(publishWorker([f.worker.name, id, LABEL]), /scoped push question/);
  assert.equal(humanStore().get(id).consumption, undefined);
  assert.equal(remoteHeads(f), '');
});

test('generic terminal push and ordinary terminal answers keep their public contracts', async () => {
  const scope = 'A different user permits a terminal approval';
  const id = await answeredTerminal(scope);
  await consumePush(id, { scope, label: LABEL });
  assert.equal(humanStore().get(id).consumption.label, LABEL);
  const ordinary = await answeredTerminal('ordinary', 'ordinary');
  assert.equal(humanStore().get(ordinary).result.origin, 'terminal');
});

for (const [name, identity, failure] of [
  ['disabled push approvals', { ...IDENTITY, pushApprovalsEnabled: false }, /push approvals stay off/],
  ['a changed operator', { ...IDENTITY, userId: '10000000000000002' }, /configured operator/],
  ['missing push configuration', undefined, /push approvals stay off/],
]) {
  test(`publication refuses ${name} at consumption without using the receipt`, async () => {
    const f = fixture();
    const { scope } = workerScope([f.worker.name]);
    const id = await approval(scope);
    const store = humanStore();
    const changingStore = { ...store, locked: (operation, key) => store.locked(access => {
      sandbox.humanDiscord = identity;
      try { return operation(access); } finally { sandbox.humanDiscord = IDENTITY; }
    }, key) };
    await assert.rejects(publishWorker([f.worker.name, id, LABEL], changingStore), failure);
    assert.equal(store.get(id).consumption, undefined);
    assert.equal(remoteHeads(f), '');
  });
}

test('relay approval releases one exact-head push and the broker refuses a second consumption', async () => {
  const f = fixture();
  const { scope } = workerScope([f.worker.name]);
  const id = await approval(scope);
  const store = humanStore();
  const answered = store.get(id);
  assert.deepEqual(answered.result.evidence.clicks, [CLICK]);
  assert.equal(answered.result.evidence.door.id, answered.posted.request);
  const head = git(f.checkout, 'rev-parse', 'HEAD');
  await publishWorker([f.worker.name, id, LABEL], store);
  assert.equal(remoteHeads(f), head);
  const consumption = store.get(id).consumption;
  assert.equal(consumption.scope, scope);
  assert.equal(consumption.label, LABEL);
  await assert.rejects(consumeDiscordPush(id, { scope, label: LABEL }, store), /already consumed/);
  assert.deepEqual(store.get(id).consumption, consumption);
});
