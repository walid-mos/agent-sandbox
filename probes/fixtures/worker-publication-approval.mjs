import { mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acceptDiscordClick } from '../../session/discord-clicks.mjs';
import { registerQuestion } from '../../session/discord-registration.mjs';
import { botDialogId, syncBotDialogs } from '../../session/human-bot.mjs';
import { humanPacket } from '../../session/human-door-packets.mjs';
import { reconcileHuman } from '../../session/human-relay.mjs';
import { humanStore } from '../../session/human-store.mjs';

export const OPTIONS = ['Push once', 'Keep local'];
export const IDENTITY = { pushApprovalsEnabled: true, userId: '10000000000000001' };
const guildId = '10000000000000003';
const channelId = '10000000000000004';
const messageId = '10000000000000005';
const channelAccount = 'discord';
export const CLICK = { question: 'answer', userId: IDENTITY.userId, guildId,
  messageUrl: `https://discord.com/channels/${guildId}/${channelId}/${messageId}`, at: '2026-11-18T09:00:00Z' };
let sequence = 0;
const nextId = pot => `${pot}.${String(++sequence).padStart(8, '0')}`;

function doorLink(store) {
  const requests = new Map();
  const save = request => { requests.set(request.id, request); return request; };
  const doors = {
    find: id => requests.get(id), all: () => [...requests.values()],
    prepare: ({ pot, need }) => ({ id: nextId('proof'), pot, need, kind: 'dialog', direction: 'asked', state: 'unknown' }),
    transmit: request => save({ ...request, state: 'open' }),
    acknowledge: request => save({ ...request, state: 'answered', reply: JSON.stringify({ type: 'human.posted-ack', version: 1 }) }),
  };
  const reconcile = () => reconcileHuman({ store, doors, identity: IDENTITY, onError: (_id, error) => { throw error; } });
  const registrationDoors = {
    find: id => ({ ...doors.find(id), direction: 'received', pot: 'proof' }),
    prepare: ({ need }) => ({ id: nextId('mastermind'), pot: 'mastermind', need, kind: 'dialog', direction: 'received', state: 'open' }),
    async transmitAsync(request) {
      save(request);
      await reconcile();
      return doors.find(request.id);
    },
  };
  const reply = (id, packet) => save({ ...doors.find(id), state: 'answered', reply: JSON.stringify(packet) });
  return { doors, registrationDoors, reconcile, reply };
}

async function clickAnswer(dialogId, label, store) {
  const index = OPTIONS.indexOf(label);
  const raw = JSON.stringify({ type: 3, id: '10000000000000006', guild_id: guildId, channel_id: channelId,
    member: { user: { id: IDENTITY.userId } }, message: { id: messageId }, data: { custom_id: `human:${dialogId}:0:${index}` } });
  const result = await acceptDiscordClick({ channel: 'discord', text: `clicked button "${label}"`, person: `discord:@${IDENTITY.userId}`, place: channelId, raw },
    { store, identity: IDENTITY, channelAccount, at: CLICK.at });
  if (result.status !== 'accepted') throw new Error(`Fixture click was ${result.status}.`);
  return store.get(dialogId).outbox;
}

export async function approval(scope, { label = OPTIONS[0], policy = 'push', isPending = false } = {}) {
  const store = humanStore();
  const id = nextId('message');
  const record = { type: 'message', person: 'bot', id, text: `Publish?\n\`\`\`question\n${JSON.stringify({ purpose: policy, scope, options: OPTIONS })}\n\`\`\`` };
  await syncBotDialogs(store, [record]);
  const dialogId = botDialogId(id);
  if (isPending) return dialogId;
  const link = doorLink(store);
  await link.reconcile();
  const request = store.get(dialogId).delivery.id;
  const question = humanPacket(link.doors.find(request).need);
  const discord = humanStore(mkdtempSync(join(homedir(), 'discord-')));
  const components = [{ type: 1, components: OPTIONS.map((option, index) => ({ type: 2, style: 1, label: option, custom_id: `human:${dialogId}:0:${index}` })) }];
  const registration = await registerQuestion({ question, request, pot: 'proof', channelAccount, guildId, messages: [{ channelId, messageId, components }] },
    { store: discord, identity: IDENTITY, doors: link.registrationDoors });
  if (!registration.registered) throw new Error(`Fixture registration failed: ${JSON.stringify(discord.get(dialogId))}`);
  link.reply(request, await clickAnswer(dialogId, label, discord));
  await link.reconcile();
  if (store.get(dialogId).result?.origin !== 'discord') throw new Error('Fixture relay did not record the Discord answer.');
  return dialogId;
}
