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
  return { ...asked, optionText: menu ? menu[2] : undefined, label: button?.[1] };
}

function fromRaw(row) {
  let interaction;
  try { interaction = JSON.parse(row.raw); } catch { return undefined; }
  const asked = partsOf(interaction?.data?.custom_id);
  if (!asked) return undefined;
  const values = interaction.data?.values;
  return { ...asked, optionText: Array.isArray(values) && values.length === 1 ? values[0] : undefined,
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
  const asked = text ?? raw;
  if (!asked) return undefined;
  const named = reference(row);
  const person = PERSON.exec(row.person ?? '');
  return { dialog: asked.dialog, questionIndex: asked.question, customId: asked.customId, option: asked.option,
    optionText: asked.optionText, label: asked.label, userId: person?.[1] ?? raw?.userId, guildId: raw?.guildId,
    channelId: raw?.channelId ?? named?.channel, messageId: raw?.messageId ?? named?.message };
}

/**
 * Whether an event names the registered control for one question: its registered message, the registered component, the
 * option's own label and a real platform user. A stored form is bound by its button alone, since its text is typed.
 */
export function bindsTo(registration, question, index, event) {
  const message = registration.messages[index];
  if (!message || !isSnowflake(event.userId)) return false;
  if (event.channelId && event.channelId !== message.channelId) return false;
  if (event.messageId && event.messageId !== message.messageId) return false;
  const component = message.components?.flatMap(row => row.components ?? []).find(item => item.custom_id === event.customId);
  if (!component) return false;
  if (event.option === undefined) return true;
  const chosen = event.option === 'select' ? (event.optionText ?? '') : event.option;
  const option = /^\d+$/.test(chosen) ? question.options[Number(chosen)] : undefined;
  return Boolean(option) && component.label === option.label;
}
