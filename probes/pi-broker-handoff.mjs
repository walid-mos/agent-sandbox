import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDialog, cancelDialog } from '../session/human-dialogs.mjs';
import { storeDialogSecret } from '../session/human-secrets.mjs';
import { humanStore } from '../session/human-store.mjs';

const piRoot = process.argv[2];
if (!piRoot) throw new Error('usage: node --experimental-transform-types probes/pi-broker-handoff.mjs ABSOLUTE_PI_CHECKOUT');
const fromPi = name => import(pathToFileURL(join(piRoot, name)));
const [{ BrokerDialog }, { brokerSecret }, { secretHandoff }, { bindCompletion }] = await Promise.all([
  fromPi('extensions/lib/human-dialog/broker.ts'),
  fromPi('extensions/ui/ask-user-secret/broker-secret.ts'),
  fromPi('extensions/ui/ask-user-secret/secret-store.ts'),
  fromPi('extensions/lib/human-dialog/completion.ts'),
]);
const directory = await mkdtemp(join(tmpdir(), 'pi-real-broker-proof-'));
const origin = 'https://example.test';
const synthetic = 'isolated-cross-repository-fixture';

async function proveWinner(first) {
  const store = humanStore(join(directory, first));
  const source = { type: 'worker', worker: 'fixture', session: '/sessions/fixture.jsonl', call: `real-${first}` };
  let dialog;
  const factory = Object.assign(input => new BrokerDialog({ ...input, source }, async (operation, id, value) => {
    if (operation === 'open') dialog = await openDialog({ ...input, source }, store);
    else if (operation === 'secret') dialog = await storeDialogSecret(id, value, { store });
    else if (operation === 'cancel') dialog = await cancelDialog(id, 'cancelled', store);
    else dialog = store.get(id);
    return { id: dialog.id, kind: dialog.kind, policy: dialog.policy, result: dialog.result };
  }), { source });
  let submit;
  const started = Promise.withResolvers();
  const pending = brokerSecret(factory, { request: { destination: 'browser', origin }, purpose: 'Cross-repository fixture' }, completion => {
    const done = Promise.withResolvers();
    submit = bindCompletion(completion, done.resolve);
    started.resolve();
    return done.promise.then(outcome => {
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    });
  });
  await started.promise;
  if (first === 'terminal') submit(synthetic);
  const page = storeDialogSecret(dialog.id, { SECRET: synthetic }, { store, origin: 'page' });
  if (first === 'page') submit(synthetic);
  const [result, saved] = await Promise.all([pending, page]);
  assert.equal(result.status, 'issued');
  assert.equal(saved.result.origin, first);
  assert.equal(result.broker.result.origin, first);
  assert.deepEqual(secretHandoff().claim(result.handle, origin), { ok: true, value: synthetic });
  assert.deepEqual(secretHandoff().claim(result.handle, origin), { ok: false, reason: 'unknown' });
  const records = JSON.stringify(store.all());
  assert.equal(records.includes(synthetic), false);
  assert.equal(records.includes(result.handle), false);
}

try {
  await proveWinner('page');
  await proveWinner('terminal');
  console.log('PASS: actual PR25 store/writer + Pi controller/owner, page and terminal winners, real one-use handles, no value/handle in broker records.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
