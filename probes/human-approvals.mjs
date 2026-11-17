import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'approval-proof-'));
process.env.HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));
const { humanStore } = await import('../session/human-store.mjs');
const { syncBotDialogs, botDialogId } = await import('../session/human-bot.mjs');
const { answerQuestion, cancelDialog, completionNeed, acceptDoorAnswer } = await import('../session/human-dialogs.mjs');
const { questionPacket, questionDigest } = await import('../session/human-discord.mjs');
const { registerPosted } = await import('../session/human-posted.mjs');
const consume = async (f, input) => (await import('../session/human-consume.mjs')).consumePush(f.dialog.id, input, f.store);
const { reconcileHuman } = await import('../session/human-relay.mjs');
const { acceptDiscordClick, closeDiscordQuestion, registerDiscordQuestion } = await import('../session/discord-clicks.mjs');
const OPERATOR = '10000000000000001';
const OTHER = '10000000000000002';
const GUILD = '10000000000000003';
const CHANNEL = '10000000000000004';
const MESSAGE = '10000000000000005';
const URL = `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`;
const IDENTITY = { pushApprovalsEnabled: true, userId: OPERATOR };
const SCOPE = `One startup push for accor-hotels/product-data-apps: ${'a'.repeat(40)} to origin refs/heads/feat/DA-250-freeze-campaign-establishments`;
const choices = ['Approve this startup push', 'Keep local'];
const folder = () => mkdtempSync(join(home, 'store-'));

function doorsWith(state = 'open') {
  const requests = new Map();
  const keys = new Map();
  let next = 0;
  return {
    find: id => requests.get(id), all: () => [...requests.values()], acknowledge: async () => {},
    prepare: ({ pot, need, key }) => {
      if (keys.has(key)) return keys.get(key);
      const request = { id: `accor.${`${next += 1}`.padStart(8, '0')}`, pot, need, direction: 'asked', state };
      keys.set(key, request);
      requests.set(request.id, request);
      return request;
    },
    transmit: request => request,
  };
}

async function fixture(policy = 'push', state = 'open') {
  const directory = folder();
  const store = humanStore(directory);
  const discord = humanStore(folder());
  const record = { type: 'message', person: 'bot', id: 'm-startup', text: `Approve the first startup push?\n\`\`\`question\n${JSON.stringify({ purpose: policy, scope: SCOPE, for: 'mastermind.12345678', options: choices })}\n\`\`\`` };
  await syncBotDialogs(store, [record]);
  const doors = doorsWith(state);
  const issues = [];
  await reconcileHuman({ store, doors, identity: IDENTITY, onError: (_, error) => issues.push(error.message) });
  const dialog = store.get(botDialogId(record.id));
  const question = questionPacket(dialog);
  const components = [{ type: 1, components: choices.map((label, index) => ({ type: 2, style: 1, label, custom_id: `human:${dialog.id}:0:${index}` })) }];
  const registration = { question, request: dialog.delivery.id, pot: 'accor', channelAccount: 'discord', guildId: GUILD, messages: [{ channelId: CHANNEL, messageId: MESSAGE, components }] };
  await registerDiscordQuestion(registration, discord, IDENTITY);
  await registerPosted({ type: 'human.posted', version: 1, dialog: dialog.id, request: dialog.delivery.id, digest: questionDigest(dialog), guildId: GUILD,
    messages: [{ question: 'answer', messageUrl: URL }] }, store);
  return { store, directory, discord, dialog: store.get(dialog.id), doors, registration, issues };
}

const click = (dialog, userId = OPERATOR, option = 0) => ({ type: 3, guild_id: GUILD, channel_id: CHANNEL, member: { user: { id: userId } },
  message: { id: MESSAGE }, data: { custom_id: `human:${dialog.id}:0:${option}` } });
const pick = (f, userId, option) => acceptDiscordClick(click(f.dialog, userId, option), { store: f.discord, identity: IDENTITY, channelAccount: 'discord', at: '2026-01-01T00:00:00Z' });
const returnedDoor = f => ({ ...f.doors.find(f.dialog.delivery.id), state: 'answered', reply: JSON.stringify(f.discord.get(f.dialog.id).outbox) });

test('bot-origin startup push goes from immutable question to scoped receipt without a Pi worker', async () => {
  const f = await fixture();
  assert.deepEqual(f.dialog.source, { type: 'bot', message: 'm-startup' });
  assert.equal(f.registration.question.policy, 'push');
  assert.equal(f.registration.question.for, 'mastermind.12345678');
  assert.equal(f.registration.question.scope, SCOPE);
  const update = await pick(f);
  assert.equal(update.status, 'accepted');
  assert.ok(update.update.components[0].components.every(component => component.disabled));
  assert.match(update.update.content, /Delivery.*pending/);
  Object.assign(f.doors.find(f.dialog.delivery.id), returnedDoor(f));
  await reconcileHuman({ store: f.store, doors: f.doors, identity: IDENTITY });
  const final = f.store.get(f.dialog.id);
  assert.deepEqual(final.result.answers, [{ id: 'answer', labels: [choices[0]], text: '' }]);
  assert.equal(final.result.scope, SCOPE);
  assert.equal(final.result.request, f.dialog.delivery.id);
  assert.equal(final.result.digest, f.registration.question.digest);
  assert.deepEqual(final.result.evidence.clicks, [{ question: 'answer', userId: OPERATOR, guildId: GUILD, messageUrl: URL, at: '2026-01-01T00:00:00Z' }]);
  const closed = await closeDiscordQuestion(JSON.parse(completionNeed(final)), f.discord, 'accor');
  assert.equal(closed.outbox, undefined);
  assert.equal(closed.closed.status, 'answered');
});

test('push requires enabled rollout and equality with the privately configured operator', async () => {
  const f = await fixture();
  await assert.rejects(pick(f, OTHER), /configured operator/);
  await assert.rejects(acceptDiscordClick(click(f.dialog), { store: f.discord, identity: { userId: OPERATOR }, channelAccount: 'discord' }), /stay off/);
  assert.deepEqual(f.discord.get(f.dialog.id).picks, {});
});

test('ordinary clicks need no user allowlist or enabled push switch', async () => {
  const f = await fixture('ordinary');
  const picked = await acceptDiscordClick(click(f.dialog, OTHER), { store: f.discord, channelAccount: 'discord' });
  assert.equal(picked.status, 'accepted');
});

test('simultaneous duplicate clicks commit one answer and retain disabled controls', async () => {
  const f = await fixture();
  const outcomes = await Promise.all([pick(f, OPERATOR, 0), pick(f, OPERATOR, 1)]);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['accepted', 'duplicate']);
  assert.equal(f.discord.get(f.dialog.id).outbox.answers[0].labels[0], choices[0]);
});

for (const [name, change] of Object.entries({ 'guild': { guild_id: OTHER }, 'channel': { channel_id: OTHER }, 'message': { message: { id: OTHER } } })) {
  test(`a push click on the wrong ${name} is rejected`, async () => {
    const f = await fixture();
    await assert.rejects(acceptDiscordClick({ ...click(f.dialog), ...change }, { store: f.discord, identity: IDENTITY, channelAccount: 'discord' }), /registered message/);
    assert.deepEqual(f.discord.get(f.dialog.id).picks, {});
  });
}

test('changed request, digest or origin cannot settle a push', async () => {
  const f = await fixture();
  await pick(f);
  const door = returnedDoor(f);
  const packet = JSON.parse(door.reply);
  for (const field of ['request', 'digest', 'dialog']) {
    await assert.rejects(acceptDoorAnswer(f.dialog, { ...door, reply: JSON.stringify({ ...packet, [field]: 'changed' }) }, { store: f.store, identity: IDENTITY }), /does not match/);
  }
  await assert.rejects(acceptDoorAnswer(f.dialog, { ...door, pot: 'other' }, { store: f.store, identity: IDENTITY }), /not a reply/);
  assert.equal(f.store.get(f.dialog.id).result, undefined);
});

test('terminal-first negative answer defeats a later affirmative click', async () => {
  const f = await fixture();
  await answerQuestion(f.dialog.id, { answers: [{ id: 'answer', labels: [choices[1]], text: '' }] }, { store: f.store });
  await pick(f);
  await acceptDoorAnswer(f.dialog, returnedDoor(f), { store: f.store, identity: IDENTITY });
  assert.equal(f.store.get(f.dialog.id).result.answers[0].labels[0], choices[1]);
});

test('cancellation remains cancellation after a later affirmative click and closes Discord', async () => {
  const f = await fixture();
  await cancelDialog(f.dialog.id, 'cancelled', f.store);
  await pick(f);
  await acceptDoorAnswer(f.dialog, returnedDoor(f), { store: f.store, identity: IDENTITY });
  const result = f.store.get(f.dialog.id);
  assert.equal(result.result.status, 'cancelled');
  assert.equal(result.result.answers, undefined);
  const closed = await closeDiscordQuestion(JSON.parse(completionNeed(result)), f.discord, 'accor');
  assert.match(closed.updates.answer.body.content, /cancelled/);
  assert.ok(closed.updates.answer.body.components[0].components.every(component => component.disabled));
});

test('a scoped push receipt is consumed once across simultaneous callers', async () => {
  const f = await fixture();
  await pick(f);
  await acceptDoorAnswer(f.dialog, returnedDoor(f), { store: f.store, identity: IDENTITY });
  const input = { scope: SCOPE, label: choices[0] };
  await assert.rejects(consume(f, { ...input, scope: 'other push' }), /scope/);
  const results = await Promise.allSettled([consume(f, input), consume(f, input)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /already consumed/);
  assert.equal(f.store.get(f.dialog.id).consumption.scope, SCOPE);
  assert.equal(f.store.get(f.dialog.id).consumption.label, choices[0]);
});

test('ordinary, negative and canceled results cannot be consumed as affirmative push approval', async () => {
  const ordinary = await fixture('ordinary');
  await pick(ordinary);
  await acceptDoorAnswer(ordinary.dialog, returnedDoor(ordinary), { store: ordinary.store, identity: IDENTITY });
  await assert.rejects(consume(ordinary, { scope: SCOPE, label: choices[0] }), /push/);
  const negative = await fixture();
  await pick(negative, OPERATOR, 1);
  await acceptDoorAnswer(negative.dialog, returnedDoor(negative), { store: negative.store, identity: IDENTITY });
  await assert.rejects(consume(negative, { scope: SCOPE, label: choices[0] }), /affirmative/);
  const canceled = await fixture();
  await cancelDialog(canceled.dialog.id, 'cancelled', canceled.store);
  await assert.rejects(consume(canceled, { scope: SCOPE, label: choices[0] }), /answered/);
});

for (const state of ['unknown', 'undelivered', 'refused']) {
  test(`${state} delivery remains durable under its original request after a relay restart`, async () => {
    const f = await fixture('push', state);
    const request = f.dialog.delivery.id;
    const reopened = humanStore(f.directory);
    await reconcileHuman({ store: reopened, doors: f.doors, identity: IDENTITY, now: Date.now() + 60_000 });
    assert.equal(reopened.get(f.dialog.id).delivery.id, request);
    assert.equal(f.store.get(f.dialog.id).result, undefined);
  });
}
