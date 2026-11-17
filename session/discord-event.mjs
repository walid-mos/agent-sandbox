import { capture, DIALOG_ID, isSnowflake } from './human-contract.mjs';

const CUSTOM = new RegExp(`^(?:human|form:human-answer):${capture(DIALOG_ID)}:(\\d+)(?::(\\d+|select))?$`);
const BUTTON = /^clicked button "(.*)" \(custom_id (\S+)\)$/;
const MENU = /^chose in menu (\S+): ".*" \(value (\d+)\)$/;
const PERSON = /^discord:@(\d{17,20})$/;
const REFERENCE = /^discord:#([^/]+)\/(\S+)$/;
const MERGED = /\n/;

function partsOf(customId) {
  const match = CUSTOM.exec(customId ?? '');
  return match && { dialog: match[1], question: Number(match[2]), option: match[3], customId };
}

function fromText(row) {
  const menu = MENU.exec(row.text ?? '');
  const button = menu ? undefined : BUTTON.exec(row.text ?? '');
  const asked = menu ? partsOf(menu[1]) : button && partsOf(button[2]);
  if (!asked || (button && MERGED.test(button[1]))) return undefined;
  return { ...asked, values: menu ? [menu[2]] : undefined, label: button?.[1] };
}

function fromRaw(row) {
  let interaction;
  try { interaction = JSON.parse(row.raw); } catch { return undefined; }
  const asked = partsOf(interaction?.data?.custom_id);
  if (!asked) return undefined;
  const values = interaction.data?.values;
  return { ...asked, values: Array.isArray(values) && values.length ? values.map(String) : undefined,
    userId: interaction.member?.user?.id ?? interaction.user?.id, guildId: interaction.guild_id, channelId: interaction.channel_id,
    messageId: interaction.message?.id, interactionType: interaction.type };
}

function reference(row) {
  const match = REFERENCE.exec(row.message ?? '');
  return match && { channel: match[1], message: match[2] };
}

/** The exact control a gateway event names, or undefined when the event cannot be bound to one. */
export function eventOf(row) {
  const text = fromText(row);
  const raw = fromRaw(row);
  if (text && raw && (text.customId !== raw.customId || text.question !== raw.question)) return undefined;
  if (text?.values && raw?.values && !text.values.every(value => raw.values.includes(value))) return undefined;
  const asked = text && { ...text, values: raw?.values ?? text.values };
  const chosen = asked ?? raw;
  if (!chosen) return undefined;
  const named = reference(row);
  const person = PERSON.exec(row.person ?? '');
  return { dialog: chosen.dialog, questionIndex: chosen.question, customId: chosen.customId, option: chosen.option,
    values: chosen.values, label: chosen.label, userId: person?.[1] ?? raw?.userId,
    guildId: raw?.guildId, channelId: raw?.channelId ?? named?.channel, messageId: raw?.messageId ?? named?.message };
}

/**
 * Whether an event names the registered control for one question: its registered message, the registered component, the
 * option's own label and a real platform user. A stored form is bound by its button alone, since its text is typed.
 */
export function bindsTo(registration, question, index, event) {
  const message = registration.messages[index];
  if (!message || !isSnowflake(event.userId)) return false;
  if (event.channelId !== message.channelId) return false;
  if (event.customId.startsWith('form:') ? false : event.messageId !== message.messageId) return false;
  const component = message.components?.flatMap(row => row.components ?? []).find(item => item.custom_id === event.customId);
  if (!component) return false;
  if (event.option === undefined) return true;
  if (event.option === 'select') return chosenLabels(component, event).every(label => question.options.some(option => option.label === label));
  const option = question.options[Number(event.option)];
  return Boolean(option) && component.label === option.label;
}

function chosenLabels(component, event) {
  const rows = component.options ?? [];
  return (event.values ?? []).map(value => rows.find(row => String(row.value) === value)?.label);
}
