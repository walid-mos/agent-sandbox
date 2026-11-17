import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { join } from 'node:path';
import { sandboxFixture } from './fixtures/sandbox.mjs';

const { home } = sandboxFixture('human-door-depth-');
const sent = [];
let currentPot = 'nextnode';
let nextOutcome;
const deliver = (pot, wire) => { sent.push({ pot, wire }); return nextOutcome; };
mock.module('../session/door-knock.mjs', { exports: { knock: deliver, knockAsync: async (pot, wire) => deliver(pot, wire) } });
mock.module('../session/run.mjs', { exports: {
  command: () => JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${currentPot}.example.ts.net` } }),
  commandOutput: async () => { throw new Error('Unexpected external call'); },
  commandWithInput: async () => { throw new Error('Unexpected external write'); },
  failureReason: () => '',
} });
const { all, find, remove, save } = await import('../session/door-requests.mjs');
const { prepareAsk } = await import('../session/doors.mjs');
const { receiveMessage } = await import('../session/door-deliveries.mjs');
const { sandbox } = await import('../session/sandbox.mjs');
const { registerQuestion, REGISTRATION_EXIT } = await import('../session/discord-registration.mjs');
const { humanStore } = await import('../session/human-store.mjs');
const { openDialog, answerQuestion, questionPacket } = await import('../session/human-dialogs.mjs');
const { reconcileHuman } = await import('../session/human-relay.mjs');
const { registerDiscordQuestion } = await import('../session/discord-clicks.mjs');
const { dialogDoors } = await import('../session/human-doors.mjs');
let sequence = 0;
const clear = () => { all().forEach(request => remove(request.id)); currentPot = 'nextnode'; sandbox.role = undefined; sent.length = 0; nextOutcome = undefined; };
function pots() {
  const records = new Map();
  return name => {
    records.set(currentPot, all());
    all().forEach(request => remove(request.id));
    currentPot = name;
    sandbox.role = name === 'mastermind' ? 'mastermind' : undefined;
    sandbox.doors = { mastermind: 'Coordinator', nextnode: 'Owner' };
    for (const request of records.get(name) ?? []) save(request);
  };
}
const hold = (id, hop, need = 'Unrelated domain work') => save({ id, direction: 'received', pot: id.split('.')[0], need, hop, state: 'open', at: 0 });
const questions = [{ id: 'setup', prompt: 'Choose setup', options: ['Start', 'Wait'] }];
const open = store => openDialog({ kind: 'question', policy: 'ordinary', source: { type: 'worker', worker: 'proof', session: '/tmp/proof.jsonl', call: `case-${++sequence}` }, questions }, store);
const localStore = () => humanStore(join(home, `store-${++sequence}`));

function registration(dialog) {
  return { question: questionPacket(dialog), request: dialog.delivery.id, pot: 'nextnode', channelAccount: 'discord', guildId: '10000000000000001',
    messages: [{ channelId: '10000000000000002', messageId: '10000000000000003', components: [] }] };
}

test('incident 1: a hop-1 unrelated request cannot block question registration and its owner ack', async () => {
  clear();
  hold('accor.aaaaaaaa', 1);
  const store = localStore();
  const dialog = await open(store);
  await reconcileHuman({ store });
  const delivery = find(store.get(dialog.id).delivery.id);
  assert.equal(delivery.kind, 'dialog');
  assert.equal(delivery.hop, undefined);
  assert.equal(find('accor.aaaaaaaa').state, 'open');
  const enter = pots();
  const questionWire = sent.at(-1).wire;
  enter('mastermind');
  hold('nextnode.dddddddd', 2);
  receiveMessage('nextnode', Buffer.from(questionWire));
  const discord = localStore();
  const input = registration(store.get(dialog.id));
  const pending = await registerQuestion(input, { store: discord });
  assert.equal(pending.state, 'pending');
  assert.equal(REGISTRATION_EXIT[pending.state], 2);
  assert.equal(discord.get(dialog.id).registration, undefined);
  const postedWire = sent.at(-1).wire;
  assert.ok(postedWire.startsWith('dialog mastermind.'));
  enter('nextnode');
  receiveMessage('mastermind', Buffer.from(postedWire));
  await reconcileHuman({ store });
  assert.equal(store.get(dialog.id).posted.request, delivery.id);
  const ackWire = sent.at(-1).wire;
  enter('mastermind');
  receiveMessage('nextnode', Buffer.from(ackWire));
  const acknowledged = await registerQuestion(input, { store: discord });
  assert.equal(acknowledged.state, 'acknowledged');
  assert.equal(acknowledged.registered, true);
  assert.equal(REGISTRATION_EXIT[acknowledged.state], 0);
  assert.deepEqual(discord.get(dialog.id).registration, JSON.parse(JSON.stringify(input)));
});

test('incident 2: an arriving hop-2 request cannot prevent human.answered delivery', async () => {
  clear();
  const store = localStore();
  hold('accor.aaaaaaaa', 0);
  const dialog = await open(store);
  await reconcileHuman({ store });
  const enter = pots();
  const questionWire = sent.at(-1).wire;
  enter('mastermind');
  receiveMessage('nextnode', Buffer.from(questionWire));
  assert.equal(prepareAsk({ pot: 'nextnode', need: 'Next unrelated request' }).hop, 0);
  enter('nextnode');
  hold('mastermind.bbbbbbbb', 2);
  await answerQuestion(dialog.id, { answers: [{ id: 'setup', labels: ['Wait'], text: '' }] }, { store });
  await reconcileHuman({ store });
  const completion = store.get(dialog.id).completion;
  assert.ok(completion.id, JSON.stringify(completion));
  assert.equal(find(completion.id).kind, 'dialog');
  assert.equal(find('mastermind.bbbbbbbb').state, 'open');
  assert.throws(() => prepareAsk({ pot: 'mastermind', need: 'Ordinary work' }), /already came through 3 doors/);
  const completionWire = sent.at(-1).wire;
  enter('mastermind');
  receiveMessage('nextnode', Buffer.from(completionWire));
  const notice = find(completion.id);
  assert.equal(JSON.parse(notice.need).type, 'human.answered');
  receiveMessage('nextnode', Buffer.from(completionWire));
  assert.equal(all().filter(request => request.id === completion.id).length, 1);
});

test('an open dialog cannot deepen an unrelated ordinary request', () => {
  clear();
  save({ id: 'mastermind.cccccccc', direction: 'received', pot: 'mastermind', need: '{}', kind: 'dialog', state: 'open', at: 0 });
  assert.equal(prepareAsk({ pot: 'mastermind', need: 'Ordinary work' }).hop, 0);
});

test('saving Discord context cannot publish a registration before owner acknowledgement', async () => {
  clear();
  const store = localStore();
  const owner = localStore();
  const dialog = await open(owner);
  await reconcileHuman({ store: owner });
  const saved = await registerDiscordQuestion(registration(owner.get(dialog.id)), store);
  assert.equal(saved.registration, undefined);
  assert.equal(saved.registrationState, 'saved');
  assert.equal(saved.registered, false);
});

test('a refused dialog answer is reported and never knocked again for the same request', async () => {
  clear();
  const store = localStore();
  const dialog = await open(store);
  await reconcileHuman({ store });
  const questionWire = sent.at(-1).wire;
  const enter = pots();
  enter('mastermind');
  receiveMessage('nextnode', Buffer.from(questionWire));
  const received = all().find(request => request.kind === 'dialog' && request.direction === 'received');
  assert.equal(received.state, 'open');
  nextOutcome = { state: 'refused', failure: "door of nextnode, exit 76: the neighbour's session refused the message" };
  const question = questionPacket(dialog);
  const reply = JSON.stringify({ type: 'human.answer', version: 1, dialog: question.dialog, request: received.id, digest: question.digest, answers: [], clicks: [] });
  const pending = dialogDoors.reply(received.id, reply);
  assert.equal(typeof pending.then, 'function');
  await assert.rejects(pending, /refused/);
  assert.equal(find(received.id).state, 'refused');
  const knocked = sent.length;
  await assert.rejects(dialogDoors.reply(received.id, reply), /refused/);
  assert.equal(sent.length, knocked);
});
