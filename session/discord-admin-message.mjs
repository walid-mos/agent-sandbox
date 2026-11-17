const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
export const DISCORD_MESSAGE_LIMIT = 2000;
export const canonicalJson = value => JSON.stringify(canonical(value));
const displayError = () => new Error('discord-admin: approval display does not match the complete canonical scope, bot author and controls.');

export function approvalMessage(question, state) {
  const scope = question.scope.replace(/`/g, '\\u0060').replace(/[\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16)}`);
  return { content: `Server administration approval\n\`\`\`json\n${scope}\n\`\`\`\n${question.questions[0].prompt}`, allowed_mentions: { parse: [] },
    components: [{ type: 1, components: question.questions[0].options.map((option, index) => ({ type: 2, style: index === 0 ? 1 : 2,
      label: option.label, custom_id: `human:${question.dialog}:0:${index}`, disabled: state === 'disabled' })) }] };
}

function normalizeButton(button) {
  const { id: _id, disabled, ...fields } = button;
  return { ...fields, disabled: disabled === true };
}

function normalizeControls(components) {
  if (!Array.isArray(components)) throw displayError();
  return components.map(row => {
    const { id: _id, ...fields } = row;
    if (!Array.isArray(row.components)) throw displayError();
    return { ...fields, components: row.components.map(normalizeButton) };
  });
}

function requireMessageIdentity(message, expected) {
  if (!message) throw displayError();
  const author = message.author ?? {};
  if (![message.id === expected.messageId, message.channel_id === expected.channelId, author.id === expected.authorId].every(Boolean)) throw displayError();
}

function requireNoExtraDisplays(message) {
  const displays = [message.embeds ?? [], message.attachments ?? []];
  if (displays.some(entries => !Array.isArray(entries) || entries.length > 0)) throw displayError();
}

export function requireApprovalDisplay(message, expected) {
  requireMessageIdentity(message, expected);
  if (message.content !== expected.content) throw displayError();
  if (canonicalJson(normalizeControls(message.components)) !== canonicalJson(normalizeControls(expected.components))) throw displayError();
  requireNoExtraDisplays(message);
}
