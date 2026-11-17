import { answersOf, checkDiscordPolicy, DIALOG_ID, DIGEST, discordEvidence, discordMessageUrl, isSnowflake, packet, questionsOf, RELAYED_POLICIES, VERSION } from './human-contract.mjs';

const MESSAGE_LIMIT = 2000;

export async function registerDiscordQuestion(registration, store, identity) {
  const { question, request, pot, channelAccount, guildId, messages } = registration;
  if (question?.type !== 'human.question' || question.version !== VERSION || !DIALOG_ID.test(question.dialog) || !DIGEST.test(question.digest)) throw new Error('discord-human: invalid question packet.');
  if (!/^[a-z][a-z0-9-]*\.[a-z0-9]{8,32}$/.test(request) || !/^[a-z][a-z0-9-]*$/.test(pot) || !channelAccount || !isSnowflake(guildId)) throw new Error('discord-human: register the originating door and channel account.');
  questionsOf(question.questions);
  if (!RELAYED_POLICIES.includes(question.policy)) throw new Error('discord-human: this question is local only.');
  checkDiscordPolicy(question.policy, identity);
  if (!Array.isArray(messages) || messages.length !== question.questions.length || !messages.every(message => isSnowflake(message.channelId) && isSnowflake(message.messageId))) throw new Error('discord-human: register one Discord message per question.');
  if (new Set(messages.map(message => `${message.channelId}/${message.messageId}`)).size !== messages.length) throw new Error('discord-human: question messages must be distinct.');
  return store.locked(({ get, save }) => {
    const existing = get(question.dialog);
    if (existing) {
      if (existing.closed) throw new Error('discord-human: this question was already answered in the owning pot.');
      if (JSON.stringify(existing.registration) !== JSON.stringify(registration)) throw new Error('discord-human: a registration cannot change.');
      return existing;
    }
    return save({ id: question.dialog, registration, picks: {} });
  }, question.dialog);
}

function customIdParts(interaction) {
  const custom = interaction.data?.custom_id ?? '';
  const match = /^(?:human|form:human-answer):([a-f0-9]{32}):(\d+)(?::(\d+|select))?$/.exec(custom);
  return match && { dialog: match[1], index: Number(match[2]), option: match[3], isForm: custom.startsWith('form:') };
}

function formText(components = []) {
  return components.flatMap(component => component.custom_id === 'answer' && typeof component.value === 'string' ? [component.value]
    : formText(component.components ?? (component.component ? [component.component] : []))).join('\n');
}

function chosenAnswer(question, interaction, parts) {
  if (parts.isForm && interaction.type === 5) return { id: question.id, labels: [], text: formText(interaction.data.components) };
  if (parts.isForm || interaction.type !== 3) throw new Error('discord-human: unsupported answer interaction.');
  const indexes = parts.option === 'select' ? interaction.data.values : [parts.option];
  if (!Array.isArray(indexes) || !indexes.every(index => /^\d+$/.test(index) && question.options[Number(index)])) throw new Error('discord-human: unknown selection.');
  if (parts.option === 'select' && !question.multiple) throw new Error('discord-human: this question is not multiple choice.');
  return { id: question.id, labels: indexes.map(index => question.options[Number(index)].label), text: '' };
}

function disabled(components = []) {
  return components.map(component => ({ ...component,
    ...(component.custom_id && { disabled: true }),
    ...(component.components && { components: disabled(component.components) }),
  }));
}

export async function acceptDiscordClick(interaction, { store, identity, channelAccount, at = new Date().toISOString() }) {
  const parts = customIdParts(interaction);
  if (!parts) return { status: 'unhandled' };
  return store.locked(({ get, save }) => {
    const record = get(parts.dialog);
    if (!record) return { status: 'unhandled' };
    const { question, messages } = record.registration;
    const message = messages[parts.index];
    const asked = question.questions[parts.index];
    if (!message || !asked || channelAccount !== record.registration.channelAccount || interaction.guild_id !== record.registration.guildId || interaction.channel_id !== message.channelId || interaction.message?.id !== message.messageId) throw new Error('discord-human: click does not belong to the registered message.');
    const evidence = discordEvidence({ userId: interaction.member?.user?.id ?? interaction.user?.id, guildId: interaction.guild_id,
      messageUrl: discordMessageUrl({ guildId: interaction.guild_id, ...message }), at }, identity, question.policy);
    if (record.closed || Object.hasOwn(record.picks, asked.id)) return { status: 'duplicate' };
    const [answer] = answersOf([asked], [chosenAnswer(asked, interaction, parts)]);
    const picks = { ...record.picks, [asked.id]: { answer, evidence } };
    const isComplete = question.questions.every(item => Object.hasOwn(picks, item.id));
    const outbox = isComplete ? packet('human.answer', { dialog: question.dialog, request: record.registration.request, digest: question.digest,
      answers: question.questions.map(item => picks[item.id].answer),
      clicks: question.questions.map(item => ({ question: item.id, ...picks[item.id].evidence })) }) : undefined;
    const content = `Answered: ${[...answer.labels, answer.text].filter(Boolean).join(', ')}\nDelivery to the owning pot is pending.`.slice(0, MESSAGE_LIMIT);
    const update = { content, components: disabled(message.components ?? interaction.message.components), allowed_mentions: { parse: [] } };
    save({ ...record, picks, outbox, updates: { ...record.updates, [asked.id]: { channelId: message.channelId, messageId: message.messageId, body: update } } });
    return { status: 'accepted', dialog: parts.dialog, update, channelId: message.channelId, messageId: message.messageId };
  }, parts.dialog);
}

export async function closeDiscordQuestion(completion, store, originPot) {
  if (!originPot || !completion?.request?.startsWith(`${originPot}.`)) throw new Error('discord-human: completion has no matching pot origin.');
  if (completion?.type !== 'human.answered' || completion.version !== VERSION) throw new Error('discord-human: invalid completion.');
  return store.locked(({ get, save }) => {
    const record = get(completion.dialog);
    if (!record) return save({ id: completion.dialog, expectedPot: originPot, closed: completion });
    const expectedRequest = record.registration?.request ?? record.closed.request;
    const expectedPot = record.registration?.pot ?? record.expectedPot;
    if (expectedRequest !== completion.request || expectedPot !== originPot) throw new Error('discord-human: completion does not match the originating request.');
    if (JSON.stringify(record.closed) === JSON.stringify(completion)) return record;
    if (record.closed) throw new Error('discord-human: this question already has its final answer.');
    if (!record.registration) return save({ ...record, closed: completion });
    if (record.registration.question.digest !== completion.digest) throw new Error('discord-human: completion does not match the question scope.');
    const updates = Object.fromEntries(record.registration.messages.map((message, index) => [record.registration.question.questions[index].id,
      { channelId: message.channelId, messageId: message.messageId, body: { content: (completion.status === 'answered' ? `Answered: ${[...completion.answers[index].labels, completion.answers[index].text].filter(Boolean).join(', ')}` : `Question ${completion.status}.`).slice(0, MESSAGE_LIMIT), components: disabled(message.components), allowed_mentions: { parse: [] } } }]));
    return save({ ...record, closed: completion, updates, outbox: undefined });
  }, completion.dialog);
}
