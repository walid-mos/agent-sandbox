import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { acknowledgedRegistration } from '../probes/fixtures/discord-registration.mjs';
import { fixture, git, home, humanStore, publishWorker, remoteHeads, workerScope } from '../probes/fixtures/worker-publication.mjs';

const { openDialog, answerQuestion, questionDigest, questionPacket } = await import('./human-dialogs.mjs');
const { consumePush } = await import('./human-consume.mjs');
const { syncBotDialogs, botDialogId } = await import('./human-bot.mjs');
const { reconcileHuman } = await import('./human-relay.mjs');
const { registerPosted } = await import('./human-posted.mjs');
const { acceptDiscordClick } = await import('./discord-clicks.mjs');

const OPERATOR = '10000000000000001';
const GUILD = '10000000000000003';
const CHANNEL = '10000000000000004';
const MESSAGE = '10000000000000005';
const URL = `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`;
const IDENTITY = { pushApprovalsEnabled: true, userId: OPERATOR };
const OPTIONS = ['Push once', 'Keep local'];
let sequence = 0;
const mkfolder = suffix => mkdtempSync(join(home, `${suffix}-`));
function fakeDoors() {
  const requests = new Map();
  let next = 0;
  return { find: id => requests.get(id), all: () => [...requests.values()], acknowledge: async () => {},
    prepare: ({ pot, need, key }) => { const request = { id: `mastermind.${`${next += 1}`.padStart(8, '0')}`, pot, need, direction: 'asked' }; requests.set(request.id, request); return request; },
    transmit: request => request };
}

async function answeredTerminal(origin = 'terminal') {
  const dialog = await openDialog({ kind: 'question', source: { type: 'bot', message: `terminal-${++sequence}` }, policy: 'push',
    scope: 'A different user permits a terminal approval',
    questions: [{ id: 'push', prompt: 'Publish?', options: OPTIONS }] });
  await answerQuestion(dialog.id, { answers: [{ id: 'push', labels: ['Push once'], text: '' }] }, { origin });
  return dialog.id;
}

for (const origin of ['terminal', undefined, 'discord']) {
  test(`publication refuses a ${origin ?? 'missing'}-origin answer with no checked registered Discord receipt`, async () => {
    const f = fixture();
    const id = await answeredTerminal();
    if (origin !== 'terminal') await humanStore().patch(id, { result: { ...humanStore().get(id).result, origin } });
    await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /Discord|already/);
    assert.equal(humanStore().get(id).consumption, undefined);
    assert.equal(remoteHeads(f), '');
  });
}

test('publication refuses an empty staged record without touching its scope or remote', async () => {
  const f = fixture();
  const request = workerScope([f.worker.name]);
  const id = await answeredTerminal('terminal');
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /waits for its checked/);
  assert.equal(remoteHeads(f), '');
  assert.equal(request.scope, workerScope([f.worker.name]).scope);
});

test('generic terminal push and ordinary terminal answers keep their public contracts', async () => {
  const id = await answeredTerminal();
  await consumePush(id, { scope: 'A different user permits a terminal approval', label: 'Push once' });
  assert.equal(humanStore().get(id).consumption.label, 'Push once');
  const dialog = await openDialog({ kind: 'question', source: { type: 'bot', message: `ordinary-${++sequence}` }, policy: 'ordinary', scope: 'ordinary',
    questions: [{ id: 'push', prompt: 'Publish?', options: OPTIONS }] });
  await answerQuestion(dialog.id, { answers: [{ id: 'push', labels: ['Push once'], text: '' }] });
  assert.equal(humanStore().get(dialog.id).result.origin, 'terminal');
});

test('checked registered Discord approval releases one exact-head push through the owning relay', async () => {
  const f = fixture();
  const scope = workerScope([f.worker.name]).scope;
  const store = humanStore();
  const discord = humanStore(mkfolder('discord'));
  const record = { type: 'message', person: 'bot', id: `m-${++sequence}`, text: `Publish?\n\`\`\`question\n${JSON.stringify({ purpose: 'push', scope, options: OPTIONS })}\n\`\`\`` };
  await syncBotDialogs(store, [record]);
  const doors = fakeDoors();
  await reconcileHuman({ store, doors, identity: IDENTITY });
  const dialog = store.get(botDialogId(record.id));
  const components = [{ type: 1, components: OPTIONS.map((label, index) => ({ type: 2, style: 1, label, custom_id: `human:${dialog.id}:0:${index}` })) }];
  await acknowledgedRegistration({ question: questionPacket(dialog), request: dialog.delivery.id, pot: 'accor', channelAccount: 'discord',
    guildId: GUILD, messages: [{ channelId: CHANNEL, messageId: MESSAGE, components }] }, discord, IDENTITY);
  const raw = JSON.stringify({ id: 'i-1', type: 3, guild_id: GUILD, channel_id: CHANNEL, member: { user: { id: OPERATOR } }, message: { id: MESSAGE }, data: { custom_id: `human:${dialog.id}:0:0` } });
  await acceptDiscordClick({ channel: 'discord', text: `clicked button "${OPTIONS[0]}"`, person: `discord:@${OPERATOR}`, place: CHANNEL, raw },
    { store: discord, identity: IDENTITY, channelAccount: 'discord' });
  await registerPosted({ type: 'human.posted', version: 1, dialog: dialog.id, request: dialog.delivery.id, digest: questionDigest(dialog),
    guildId: GUILD, messages: [{ question: 'answer', messageUrl: URL }] }, store);
  const reply = discord.get(dialog.id).outbox;
  await reconcileHuman({ store, doors: { ...doors,
    find: id => ({ pot: 'mastermind', direction: 'asked', state: 'answered', id, reply: JSON.stringify(reply) }) }, identity: IDENTITY });
  const answered = store.get(dialog.id);
  assert.equal(answered.result.origin, 'discord');
  assert.deepEqual(answered.result.evidence.clicks.map(({ question, userId, guildId, messageUrl }) => ({ question, userId, guildId, messageUrl })),
    [{ question: 'answer', userId: OPERATOR, guildId: GUILD, messageUrl: URL }]);
  assert.ok(Number.isFinite(Date.parse(answered.result.evidence.clicks[0].at)), 'click time is preserved');
  await store.patch(dialog.id, { staged: { door: { pot: 'mastermind', direction: 'asked', id: dialog.delivery.id, state: 'answered' },
    reply, identity: IDENTITY } });
  const head = git(f.checkout, 'rev-parse', 'HEAD');
  await publishWorker([f.worker.name, dialog.id, 'Push once'], store);
  assert.equal(remoteHeads(f), head);
  assert.equal(store.get(dialog.id).consumption.label, 'Push once');
  await assert.rejects(publishWorker([f.worker.name, dialog.id, 'Push once'], store), /not waiting for its first approved push/);
  assert.equal(remoteHeads(f), head);
  assert.equal(store.get(dialog.id).consumption.label, 'Push once');
});
