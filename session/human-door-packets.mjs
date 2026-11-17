import { DIALOG_ID, DIGEST, discordMessage, MASTERMIND_POT, packet as newPacket, questionsOf, RELAYED_POLICIES, VERSION } from './human-contract.mjs';
import { isRequestId, Refusal } from './door-messages.mjs';

const FIELDS = {
  'human.question': ['digest', 'policy', 'scope', 'context', 'questions', 'for'],
  'human.secret-link': ['purpose', 'url', 'expiresAt', 'for'],
  'human.posted': ['request', 'digest', 'guildId', 'at', 'messages'],
  'human.answered': ['request', 'digest', 'status', 'origin', 'answers'],
};
const INITIAL = ['human.question', 'human.secret-link'];
const ACKNOWLEDGEMENTS = { 'human.posted': 'human.posted-ack', 'human.answered': 'human.answered-ack' };
const STATUSES = ['answered', 'cancelled', 'paused', 'expired', 'stored'];
const ORIGINS = ['terminal', 'discord', 'page'];
const text = value => typeof value === 'string' && value.trim().length > 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function fieldsOf(packet, fields) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet) || Object.keys(packet).some(key => !fields.includes(key))) throw new Error('unexpected packet fields');
}

export function humanNeed(packet) {
  if (packet.type !== 'human.question') return JSON.stringify(packet);
  return `${packet.context || 'A worker waits for your answer.'}\n\n\`\`\`question\n${JSON.stringify(packet)}\n\`\`\``;
}

function question(packet) {
  if (!DIGEST.test(packet.digest) || !RELAYED_POLICIES.includes(packet.policy) || typeof packet.context !== 'string') throw new Error('invalid question');
  if (packet.policy === 'push' && !text(packet.scope)) throw new Error('missing approval scope');
  const normalized = questionsOf(packet.questions);
  if (!same(normalized, packet.questions)) throw new Error('question fields are not canonical');
}

function secret(packet) {
  const url = new URL(packet.url);
  if (!text(packet.purpose) || url.protocol !== 'https:' || url.username || url.password || !Number.isSafeInteger(packet.expiresAt) || packet.expiresAt < 0) throw new Error('invalid secret link');
}

function posted(packet) {
  if (!DIGEST.test(packet.digest) || !Number.isFinite(Date.parse(packet.at)) || !Array.isArray(packet.messages) || !packet.messages.length) throw new Error('invalid posted context');
  for (const message of packet.messages) {
    fieldsOf(message, ['question', 'messageUrl']);
    if (!text(message.question) || discordMessage(message.messageUrl).guildId !== packet.guildId) throw new Error('invalid posted message');
  }
}

function answered(packet) {
  if (!STATUSES.includes(packet.status) || !ORIGINS.includes(packet.origin)) throw new Error('invalid completion');
  if (packet.digest !== undefined && !DIGEST.test(packet.digest)) throw new Error('invalid completion digest');
  if (packet.status !== 'answered') {
    if (packet.answers !== undefined) throw new Error('unexpected answers');
    return;
  }
  if (!DIGEST.test(packet.digest) || !Array.isArray(packet.answers) || !packet.answers.length) throw new Error('missing answers');
  for (const answer of packet.answers) {
    fieldsOf(answer, ['id', 'labels', 'text']);
    if (!text(answer.id) || !Array.isArray(answer.labels) || !answer.labels.every(text) || typeof answer.text !== 'string') throw new Error('invalid answer');
  }
}

const CHECKS = { 'human.question': question, 'human.secret-link': secret, 'human.posted': posted, 'human.answered': answered };

export function humanPacket(need) {
  try {
    const block = /\n\n```question\n([^]*?)\n```$/.exec(need);
    const packet = JSON.parse(block ? block[1] : need);
    const fields = FIELDS[packet?.type];
    if (!fields || packet.version !== VERSION || !DIALOG_ID.test(packet.dialog)) throw new Error('unknown dialog packet');
    fieldsOf(packet, ['type', 'version', 'dialog', ...fields]);
    if (packet.for !== undefined && !isRequestId(packet.for)) throw new Error('invalid original request');
    if (!INITIAL.includes(packet.type) && !isRequestId(packet.request)) throw new Error('invalid dialog request');
    CHECKS[packet.type](packet);
    if (block && humanNeed(packet) !== need) throw new Error('text outside the question');
    return packet;
  } catch (cause) {
    throw new Refusal(`pots: invalid human dialog packet: ${cause.message}`);
  }
}

// Mastermind sends only posted context, to an owning pot; every other dialog packet goes from an owning pot to Mastermind.
export function checkDialogDirection(packet, { fromMastermind, toMastermind }) {
  const isPosted = packet.type === 'human.posted';
  if (fromMastermind !== isPosted || toMastermind === isPosted) throw new Refusal('pots: human dialog packet has the wrong direction.');
}

export function checkHumanRoute(need, { caller, isMastermindReceiver, find }) {
  const packet = humanPacket(need);
  const isPosted = packet.type === 'human.posted';
  checkDialogDirection(packet, { fromMastermind: caller === MASTERMIND_POT, toMastermind: isMastermindReceiver });
  if (packet.type === 'human.answered' && !packet.request.startsWith(`${caller}.`)) throw new Refusal('pots: completion has another owner.');
  if (isPosted) {
    const original = find(packet.request);
    if (original?.kind !== 'dialog' || original.direction !== 'asked' || original.pot !== caller) throw new Refusal('pots: posted context has no matching dialog request.');
    const question = humanPacket(original.need);
    if (question.type !== 'human.question' || question.dialog !== packet.dialog || question.digest !== packet.digest) throw new Refusal('pots: posted context differs from its question.');
  }
  return packet;
}

// The door admitted every stored dialog through humanPacket, so a record that no longer parses is damaged and is skipped, not allowed to stop the other dialogs.
export function storedPacket(request, type) {
  try {
    const packet = humanPacket(request.need);
    return packet.type === type ? packet : undefined;
  } catch {
    return undefined;
  }
}

export const isInitialHumanPacket = need => INITIAL.includes(humanPacket(need).type);

export function checkHumanReply(request, reply) {
  try {
    const original = humanPacket(request.need);
    const answer = JSON.parse(reply);
    const expected = ACKNOWLEDGEMENTS[original.type];
    if (expected) {
      if (answer.type !== expected || answer.version !== VERSION || Object.keys(answer).length !== 2) throw new Error('invalid acknowledgement');
      return;
    }
    fieldsOf(answer, ['type', 'version', 'dialog', 'request', 'digest', 'answers', 'clicks']);
    if (original.type !== 'human.question' || answer.type !== 'human.answer' || answer.version !== VERSION || answer.dialog !== original.dialog || answer.request !== request.id || answer.digest !== original.digest || !Array.isArray(answer.answers) || !Array.isArray(answer.clicks)) throw new Error('answer differs from its question');
  } catch (cause) {
    throw new Refusal(`pots: invalid human dialog reply: ${cause.message}`);
  }
}

export function acknowledgementOf(need) {
  const type = ACKNOWLEDGEMENTS[humanPacket(need).type];
  if (!type) throw new Error('pots: this human dialog request takes an answer, not an acknowledgement.');
  return JSON.stringify(newPacket(type, {}));
}
