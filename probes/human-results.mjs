import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const { deliverBotResult } = await import('../session/human-bot.mjs');
const { waitingDialog } = await import('../session/worker-dialogs.mjs');
const { conversation } = await import('../session/terminal-conversation.mjs');
let sequence = 0;
const botSource = () => ({ type: 'bot', message: `m-proof-${++sequence}` });
const secretInput = source => ({ kind: 'secret', source, purpose: 'Supply both keys', target: { destination: 'pots', file: 'proof.env', keys: ['FIRST', 'SECOND'] } });
const questionInput = source => ({ kind: 'question', source, questions: [{ id: 'choice', prompt: 'Choose', options: ['Yes', 'No'] }] });

for (const kind of ['question', 'secret']) {
  test(`expired ${kind} uses the same result text in the bot conversation and worker pane`, async () => {
    const input = kind === 'secret' ? secretInput : questionInput;
    const expected = kind === 'secret' ? 'Secret request expired.' : 'Question expired.';
    const store = humanStore();
    const bot = await openDialog(input(botSource()), store);
    await cancelDialog(bot.id, 'expired', store);
    await deliverBotResult(bot.id, store);
    assert.equal(conversation().find(record => record.humanDialog === bot.id).text, expected);
    const call = `call-${++sequence}`;
    const worker = await openDialog(input({ type: 'worker', worker: 'proof-worker', session, call }), store);
    await cancelDialog(worker.id, 'expired', store);
    const name = kind === 'secret' ? 'ask_user_secret' : 'ask_user_question';
    writeFileSync(session, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: call, name, arguments: { questions: [] } }] } }));
    assert.equal(waitingDialog({ name: 'proof-worker', address: 't-proof' }).message, expected);
  });
}
