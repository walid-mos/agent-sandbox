import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'human-decisions-'));
process.env.HOME = home;
after(() => { mock.restoreAll(); rmSync(home, { recursive: true, force: true }); });
const session = join(home, 'worker.jsonl');
mock.module('../session/sandbox.mjs', { exports: { botHome: join(home, 'bot'), botId: 'proof', potsHome: join(home, '.pots') } });
mock.module('../session/run.mjs', { exports: {
  command: () => JSON.stringify({ labels: { 'pi.session': session } }),
  commandWithInput: async () => { throw new Error('Unexpected external write'); },
} });
const { humanStore } = await import('../session/human-store.mjs');
const { openDialog } = await import('../session/human-dialogs.mjs');
const { storeDialogSecret } = await import('../session/human-secrets.mjs');
const { storeSecrets } = await import('../session/pots-secrets.mjs');
let sequence = 0;
const botSource = () => ({ type: 'bot', message: `m-proof-${++sequence}` });
const secretInput = source => ({ kind: 'secret', source, purpose: 'Supply both keys', target: { destination: 'pots', file: 'proof.env', keys: ['FIRST', 'SECOND'] } });

test('a partial secret submission names missing keys, writes nothing and remains open', async () => {
  const store = humanStore();
  const dialog = await openDialog(secretInput(botSource()), store);
  let writes = 0;
  const write = async () => { writes += 1; return {}; };
  await assert.rejects(storeDialogSecret(dialog.id, { FIRST: 'dummy' }, { store, write }), { message: 'human: missing secret keys: SECOND.' });
  assert.equal(writes, 0);
  assert.equal(store.get(dialog.id).result, undefined);
  assert.equal(Boolean(store.get(dialog.id).writing), false);
  await storeDialogSecret(dialog.id, { FIRST: 'dummy', SECOND: 'dummy' }, { store, write });
  assert.equal(writes, 1);
});

test('the native pot secret writer refuses partial input before any destination access', async () => {
  await assert.rejects(storeSecrets({ file: 'proof.env', keys: ['FIRST', 'SECOND'] }, '{"FIRST":"dummy"}'), { message: 'human: missing secret keys: SECOND.' });
});
