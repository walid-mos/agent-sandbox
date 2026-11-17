import { registerDiscordQuestion } from './discord-clicks.mjs';
import { DIALOG } from './door-messages.mjs';
import { ANSWERED, OPEN, RECEIVED, REFUSED, RESENDABLE, UNKNOWN } from './door-requests.mjs';
import { discordMessageUrl, packet } from './human-contract.mjs';
import { checkHumanReply, humanPacket } from './human-door-packets.mjs';
import { dialogDoors, DOOR_RETRY_MS } from './human-doors.mjs';

export const REGISTRATION_EXIT = { saved: 1, pending: 2, acknowledged: 0 };

function registrationRequest(registration, doors) {
  const request = doors.find(registration.request);
  if (request?.kind !== DIALOG || request.direction !== RECEIVED || request.pot !== registration.pot) throw new Error('discord-human: no matching incoming dialog request.');
  if (JSON.stringify(humanPacket(request.need)) !== JSON.stringify(registration.question)) throw new Error('discord-human: question differs from the incoming request.');
}

function postedNeed(record) {
  const { question, request, guildId, messages } = record.savedRegistration;
  return JSON.stringify(packet('human.posted', { dialog: record.id, request, digest: question.digest, guildId, at: new Date().toISOString(),
    messages: messages.map((message, index) => ({ question: question.questions[index].id, messageUrl: discordMessageUrl({ guildId, ...message }) })) }));
}

async function settleRegistration(record, store, doors) {
  if (record.registered === true || record.closed) return record;
  if (!record.savedRegistration) throw new Error('discord-human: this dialog has no saved registration left to post. Register it again from its question.');
  let door = record.postedRequest && doors.find(record.postedRequest);
  if (!door) {
    door = doors.prepare({ pot: record.savedRegistration.pot, need: postedNeed(record), key: `human-posted:${record.id}` });
    await store.patch(record.id, { postedRequest: door.id });
  }
  if (door.state !== ANSWERED && Date.now() - (record.postedAttemptedAt ?? 0) < DOOR_RETRY_MS) return record;
  await store.patch(record.id, { postedAttemptedAt: Date.now() });
  const delivered = await doors.transmitAsync(door);
  if (delivered.state === REFUSED) throw new Error(`discord-human: the owning pot refused the posted context: ${delivered.failure}`);
  return store.locked(({ get, save }) => {
    const current = get(record.id);
    if (current.closed || current.registered === true) return current;
    if (delivered.state !== ANSWERED) {
      const registrationState = [OPEN, UNKNOWN].includes(delivered.state) ? 'pending' : 'saved';
      return save({ ...current, registrationState, registered: false, failure: delivered.failure });
    }
    checkHumanReply(delivered, delivered.reply);
    return save({ ...current, registration: current.savedRegistration, savedRegistration: undefined,
      registrationState: 'acknowledged', registered: true, failure: undefined });
  }, record.id);
}

export async function registerQuestion(registration, { store, identity, doors = dialogDoors }) {
  registrationRequest(registration, doors);
  const record = await registerDiscordQuestion(registration, store, identity);
  try {
    const settled = await settleRegistration(record, store, doors);
    return { dialog: settled.id, registered: settled.registered === true, state: settled.registrationState, postedRequest: settled.postedRequest, failure: settled.failure };
  } catch (error) {
    const failed = await store.locked(({ get, save }) => {
      const current = get(record.id);
      return current.registered === true ? current : save({ ...current, registered: false, failure: error.message });
    }, record.id);
    return { dialog: failed.id, registered: failed.registered === true, state: failed.registrationState, postedRequest: failed.postedRequest, failure: failed.failure };
  }
}

export async function reconcileRegistrations(store, onError, doors = dialogDoors) {
  for (const record of store.all().filter(record => record.savedRegistration && !record.closed)) {
    try { await settleRegistration(record, store, doors); } catch { onError('Posted context is not acknowledged. Keep question controls disabled.'); }
  }
}
