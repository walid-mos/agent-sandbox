import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sandboxFixture } from './fixtures/sandbox.mjs';
import { botDialogFixture, completionNotices, discordAnswer, PUSH_SCOPE } from './fixtures/bot-dialogs.mjs';

const { home } = sandboxFixture('bot-cross-talk-');
const { answerBotQuestion, botDialogId, deliverBotResult, syncBotDialogs } = await import('../session/human-bot.mjs');
const { answerQuestion, cancelDialog } = await import('../session/human-dialogs.mjs');
const { consumePush } = await import('../session/human-consume.mjs');
const { storeDialogSecret } = await import('../session/human-secrets.mjs');
const DEFAULTS = 'Approve with the defaults';
const FIRST_OPTIONS = [DEFAULTS, 'Factory waits for my signature', 'Keep re-signing by hand'];
const SECOND_OPTIONS = ['Done, verify it', 'Not now'];

async function twoQuestions(options = SECOND_OPTIONS, extra = {}) {
  const fixture = await botDialogFixture(home);
  const first = fixture.ask('m-bfb9903d-proof', FIRST_OPTIONS, {}, '2026-11-17T16:07:29Z');
  const second = fixture.ask('m-cb126b38-proof', options, extra);
  await fixture.pass();
  return { ...fixture, first, second };
}

function assertOpen(fixture, id) {
  assert.equal(fixture.store.get(id).result, undefined, 'another dialog must not settle this question');
  assert.equal(fixture.store.get(id).deliveredToBot, undefined);
  assert.deepEqual(completionNotices(fixture, id), []);
}

function assertBound(fixture, id) {
  const dialog = fixture.store.get(id);
  const records = fixture.conversation().filter(record => record.humanDialog === id);
  assert.equal(records.length, 1);
  assert.equal(records[0].answers, dialog.source.message);
  assert.equal(records[0].person, 'abc');
}

test('the live two-question Discord sequence leaves the newer question open across relay passes', async () => {
  const f = await twoQuestions();
  await discordAnswer(f, f.first, DEFAULTS);
  const receipt = f.store.get(f.first).result;
  assert.equal(receipt.origin, 'discord');
  assert.deepEqual(receipt.answers, [{ id: 'answer', labels: [DEFAULTS], text: '' }]);
  assert.deepEqual(f.conversation().filter(record => record.humanDialog === f.first).map(record => record.text), [DEFAULTS]);
  await f.pass();
  await f.pass();
  assertOpen(f, f.second);
  assertBound(f, f.first);
  assert.equal(completionNotices(f, f.first).length, 1);
  assert.deepEqual(f.store.get(f.first).result, receipt);
});

test('an ordinary Discord label collision cannot authorize or consume a newer push question', async () => {
  const f = await twoQuestions([DEFAULTS, 'Keep local'], { purpose: 'push', scope: PUSH_SCOPE });
  await discordAnswer(f, f.first, DEFAULTS);
  await f.pass();
  await assert.rejects(consumePush(f.second, { scope: PUSH_SCOPE, label: DEFAULTS }, f.store), /has not been answered/);
  assertOpen(f, f.second);
  assert.equal(f.store.get(f.second).consumption, undefined);
});

test('a genuine typed reply still answers only the newest preceding open question', async () => {
  const f = await twoQuestions();
  f.say({ id: 'm-real-reply', text: 'Done, verify it' });
  await f.pass();
  await f.pass();
  assertOpen(f, f.first);
  assert.equal(f.store.get(f.second).result.origin, 'terminal');
  assert.equal(f.store.get(f.second).result.messageId, 'm-real-reply');
  assert.deepEqual(f.store.get(f.second).result.answers, [{ id: 'answer', labels: ['Done, verify it'], text: '' }]);
});

test('a genuine typed reply after a delivered Discord answer reaches the newer question', async () => {
  const f = await twoQuestions();
  await discordAnswer(f, f.first, DEFAULTS);
  f.say({ id: 'm-after-discord', text: 'Not now' });
  await f.pass();
  assert.equal(f.store.get(f.second).result.messageId, 'm-after-discord');
  assert.deepEqual(f.store.get(f.second).result.answers, [{ id: 'answer', labels: ['Not now'], text: '' }]);
});

test('a delivered result with only its dialog marker is never a typed reply', async () => {
  const f = await twoQuestions();
  f.say({ id: 'm-marked-result', humanDialog: f.first, text: DEFAULTS });
  await f.pass();
  assertOpen(f, f.first);
  assertOpen(f, f.second);
});

for (const status of ['cancelled', 'paused', 'expired']) {
  test(`${status} results cannot answer the next question`, async () => {
    const f = await twoQuestions();
    await cancelDialog(f.first, status, f.store);
    await deliverBotResult(f.first, f.store);
    await f.pass();
    assertOpen(f, f.second);
    assertBound(f, f.first);
  });
}

test('a late pane message forwarded after settlement cannot answer a newer question', async () => {
  const f = await botDialogFixture(home);
  const first = f.ask('m-settled', FIRST_OPTIONS);
  await syncBotDialogs(f.store);
  await cancelDialog(first, 'expired', f.store);
  await deliverBotResult(first, f.store);
  const second = f.ask('m-newer', SECOND_OPTIONS);
  await f.pass();
  const original = f.store.get(first).result;
  await answerBotQuestion('m-settled', 'Done, verify it', 'm-forwarded', f.store);
  await answerBotQuestion('m-settled', 'Done, verify it', 'm-forwarded', f.store);
  await f.pass();
  assertOpen(f, second);
  assert.deepEqual(f.conversation().filter(record => record.id === 'm-forwarded').map(record => record.text), ['Done, verify it']);
  const forwarded = f.conversation().find(record => record.id === 'm-forwarded');
  assert.equal(forwarded.humanDialog, first);
  assert.equal(forwarded.answers, 'm-settled');
  assert.deepEqual(f.store.get(first).result, original);
});

test('an expired secret notice cannot answer a newer question', async () => {
  const f = await botDialogFixture(home);
  f.say({ id: 'm-expired-secret', person: 'bot', text: 'Supply a key', secret: { file: 'proof.env', keys: ['KEY'] } });
  await syncBotDialogs(f.store);
  const first = botDialogId('m-expired-secret');
  await cancelDialog(first, 'expired', f.store);
  const second = f.ask('m-newer', SECOND_OPTIONS);
  await f.pass();
  await f.pass();
  assertOpen(f, second);
  assertBound(f, first);
});

test('a secret-stored notice cannot answer the next question', async () => {
  const f = await botDialogFixture(home);
  f.say({ id: 'm-secret', person: 'bot', text: 'Supply a key', secret: { file: 'proof.env', keys: ['KEY'] } });
  await syncBotDialogs(f.store);
  const first = botDialogId('m-secret');
  const second = f.ask('m-after-secret', SECOND_OPTIONS);
  await storeDialogSecret(first, { KEY: 'fixture-only' }, { store: f.store, write: async () => ({}) });
  await deliverBotResult(first, f.store);
  await f.pass();
  assertOpen(f, second);
  assertBound(f, first);
  assert.equal(f.conversation().find(record => record.humanDialog === first).text, 'Requested secrets were stored in this pot.');
});

test('a result marked with a dialog cannot settle a secret request either', async () => {
  const f = await botDialogFixture(home);
  f.say({ id: 'm-open-secret', person: 'bot', text: 'Supply a key', secret: { file: 'proof.env', keys: ['KEY'] } });
  await syncBotDialogs(f.store);
  f.say({ humanDialog: 'another-dialog', answers: 'm-open-secret', text: 'Requested secrets were stored in this pot.' });
  await syncBotDialogs(f.store);
  assert.equal(f.store.get(botDialogId('m-open-secret')).result, undefined);
});

test('a genuine targeted secret reply still settles its own secret request', async () => {
  const f = await botDialogFixture(home);
  f.say({ id: 'm-real-secret', person: 'bot', text: 'Supply a key', secret: { file: 'proof.env', keys: ['KEY'] } });
  await syncBotDialogs(f.store);
  f.say({ answers: 'm-real-secret', text: 'Requested secrets were stored in this pot.' });
  await syncBotDialogs(f.store);
  assert.equal(f.store.get(botDialogId('m-real-secret')).result.status, 'stored');
});
