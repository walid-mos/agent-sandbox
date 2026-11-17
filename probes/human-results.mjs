import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mock, test } from 'node:test';

import { sandboxFixture } from './fixtures/sandbox.mjs';

const { home, session } = sandboxFixture('human-decisions-');
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
