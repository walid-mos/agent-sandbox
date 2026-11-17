import { answerParts, answersOf, checkDiscordPolicy, DIALOG_ID, DIGEST, discordEvidence, discordMessageUrl, isSnowflake, packet, questionsOf, RELAYED_POLICIES, VERSION } from './human-contract.mjs';
import { bindsTo, eventOf } from './discord-event.mjs';
import { isPotName, isRequestId } from './door-messages.mjs';

const MESSAGE_LIMIT = 2000;

export async function registerDiscordQuestion(registration, store, identity) {
  const { question, request, pot, channelAccount, guildId, messages } = registration;
  if (question?.type !== 'human.question' || question.version !== VERSION || !DIALOG_ID.test(question.dialog) || !DIGEST.test(question.digest)) throw new Error('discord-human: invalid question packet.');
  if (!isRequestId(request) || !isPotName(pot) || !channelAccount || !isSnowflake(guildId)) throw new Error('discord-human: register the originating door and channel account.');
  questionsOf(question.questions);
  if (!RELAYED_POLICIES.includes(question.policy)) throw new Error('discord-human: this question is local only.');
  checkDiscordPolicy(question.policy, identity);
  if (!Array.isArray(messages) || messages.length !== question.questions.length || !messages.every(message => isSnowflake(message.channelId) && isSnowflake(message.messageId))) throw new Error('discord-human: register one Discord message per question.');
  if (new Set(messages.map(message => `${message.channelId}/${message.messageId}`)).size !== messages.length) throw new Error('discord-human: question messages must be distinct.');
  return store.locked(({ get, save }) => {
    const existing = get(question.dialog);
    if (existing) {
      if (existing.closed) throw new Error('discord-human: this question was already answered in the owning pot.');
      if (JSON.stringify(existing.registration ?? existing.savedRegistration) !== JSON.stringify(registration)) throw new Error('discord-human: a registration cannot change.');
      return existing;
    }
    return save({ id: question.dialog, savedRegistration: registration, registrationState: 'saved', registered: false, picks: {} });
  }, question.dialog);
}

const formChildren = component => component.components ?? (component.component ? [component.component] : []);

function formComponentText(component) {
  if (component.custom_id === 'answer' && typeof component.value === 'string') return [component.value];
  return formText(formChildren(component));
}

function formText(components = []) {
  return components.flatMap(formComponentText).join('\n');
}

function formAnswer(question, interaction) {
  if (interaction?.type !== 5) throw new Error('discord-human: a stored form answers only on its modal submission.');
  return { id: question.id, labels: [], text: formText(interaction.data?.components) };
}

function selectedLabels(question, event) {
  const values = event.option === 'select' ? (event.values ?? []) : [event.option];
  if (!values.length || !values.every(value => /^\d+$/.test(value ?? '') && question.options[Number(value)])) throw new Error('discord-human: unknown selection.');
  if (event.option === 'select' && !question.multiple && values.length !== 1) throw new Error('discord-human: this question is not multiple choice.');
  return values.map(value => question.options[Number(value)].label);
}

function chosenAnswer(question, event) {
  const { interaction } = event;
  if (event.customId.startsWith('form:')) return formAnswer(question, interaction);
  if (interaction && interaction.type !== 3) throw new Error('discord-human: unsupported answer interaction.');
  return { id: question.id, labels: selectedLabels(question, event), text: '' };
}

function disabled(components = []) {
  return components.map(component => ({ ...component,
    ...(component.custom_id && { disabled: true }),
    ...(component.components && { components: disabled(component.components) }),
  }));
}

const answered = answer => `Answered: ${answerParts(answer).join(', ')}`;

function messageUpdate(message, content, components = message.components) {
  const body = { content: content.slice(0, MESSAGE_LIMIT), allowed_mentions: { parse: [] } };
  if (components?.length) body.components = disabled(components);
  return { channelId: message.channelId, messageId: message.messageId, body };
}

export async function acceptDiscordClick(row, { store, identity, channelAccount, at = new Date().toISOString() }) {
  const event = eventOf(row);
  if (!event) return { status: 'unhandled' };
  return store.locked(({ get, save }) => {
    const record = get(event.dialog);
    if (!record?.registration || record.registrationState !== 'acknowledged' || record.registered !== true) return { status: 'unhandled' };
    const { question, messages } = record.registration;
    const asked = question.questions[event.questionIndex];
    const message = asked && messages[event.questionIndex];
    if (!message || channelAccount !== record.registration.channelAccount || (event.guildId && event.guildId !== record.registration.guildId)) throw new Error('discord-human: click does not belong to the registered message.');
    if (!bindsTo(record.registration, asked, event.questionIndex, event)) throw new Error('discord-human: click does not name a registered control of this question.');
    if (record.closed || Object.hasOwn(record.picks, asked.id)) return withdrawn(record, asked, message, save);
    const messageUrl = discordMessageUrl({ guildId: record.registration.guildId, ...message });
    const evidence = discordEvidence({ userId: event.userId, guildId: event.guildId ?? record.registration.guildId, messageUrl, at }, identity, question.policy);
    const [answer] = answersOf([asked], [chosenAnswer(asked, event)]);
    const picks = { ...record.picks, [asked.id]: { question: asked.id, request: record.registration.request, messageUrl,
      customId: event.customId, option: event.option, answer, evidence, at } };
    const isComplete = question.questions.every(item => Object.hasOwn(picks, item.id));
    const outbox = isComplete ? packet('human.answer', { dialog: question.dialog, request: record.registration.request, digest: question.digest,
      answers: question.questions.map(item => picks[item.id].answer),
      clicks: question.questions.map(item => ({ question: item.id, ...picks[item.id].evidence })) }) : undefined;
    const update = messageUpdate(message, `${answered(answer)}\nDelivery to the owning pot is pending.`);
    save({ ...record, picks, outbox, updates: { ...record.updates, [asked.id]: update } });
    return { status: 'accepted', dialog: event.dialog, update: update.body, channelId: message.channelId, messageId: message.messageId };
  }, event.dialog);
}

/** A click on a question the owning pot already settled changes no answer, and only takes the controls away. */
function withdrawn(record, question, message, save) {
  const settled = record.closed?.status ?? 'answered elsewhere';
  const update = messageUpdate(message, `This question was already ${settled}.`);
  save({ ...record, updates: { ...record.updates, [question.id]: update } });
  return { status: 'stale', dialog: record.id, update: update.body, channelId: message.channelId, messageId: message.messageId };
}

export const registeredPot = record => (record.registration ?? record.savedRegistration)?.pot ?? record.expectedPot;

export async function closeDiscordQuestion(completion, store, originPot) {
  if (!originPot || !completion?.request?.startsWith(`${originPot}.`)) throw new Error('discord-human: completion has no matching pot origin.');
  if (completion?.type !== 'human.answered' || completion.version !== VERSION) throw new Error('discord-human: invalid completion.');
  return store.locked(({ get, save }) => {
    const record = get(completion.dialog);
    if (!record) return save({ id: completion.dialog, expectedPot: originPot, closed: completion });
    const registration = record.registration ?? record.savedRegistration;
    const expectedRequest = registration?.request ?? record.closed.request;
    if (expectedRequest !== completion.request || registeredPot(record) !== originPot) throw new Error('discord-human: completion does not match the originating request.');
    if (JSON.stringify(record.closed) === JSON.stringify(completion)) return record;
    if (record.closed) throw new Error('discord-human: this question already has its final answer.');
    if (!registration) return save({ ...record, closed: completion });
    if (registration.question.digest !== completion.digest) throw new Error('discord-human: completion does not match the question scope.');
    const updates = Object.fromEntries(registration.messages.map((message, index) => [registration.question.questions[index].id,
      messageUpdate(message, completion.status === 'answered' ? answered(completion.answers[index]) : `Question ${completion.status}.`)]));
    return save({ ...record, closed: completion, updates, outbox: undefined });
  }, completion.dialog);
}
