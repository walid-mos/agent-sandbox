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
const { openDialog, cancelDialog } = await import('../session/human-dialogs.mjs');
const { answerBotQuestion } = await import('../session/human-bot.mjs');
const { conversation } = await import('../session/terminal-conversation.mjs');
let sequence = 0;
const botSource = () => ({ type: 'bot', message: `m-proof-${++sequence}` });
const questionInput = source => ({ kind: 'question', source, questions: [{ id: 'choice', prompt: 'Choose', options: ['Yes', 'No'] }] });

test('a pane message after settlement reaches the conversation once without changing the result', async () => {
  const store = humanStore();
  const dialog = await openDialog(questionInput(botSource()), store);
  await cancelDialog(dialog.id, 'expired', store);
  const original = store.get(dialog.id).result;
  const id = `m-late-${++sequence}`;
  assert.equal(await answerBotQuestion(dialog.source.message, 'Please continue with my note', id, store), id);
  assert.equal(await answerBotQuestion(dialog.source.message, 'Please continue with my note', id, store), id);
  assert.deepEqual(conversation().filter(record => record.id === id).map(record => record.text), ['Please continue with my note']);
  assert.deepEqual(store.get(dialog.id).result, original);
  assert.equal(store.get(dialog.id).deliveredToBot, true);
});
