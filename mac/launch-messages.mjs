import { ACTS } from '../session/launch-contract.mjs';
import { BUTTON, buttonId } from './launch-approval.mjs';

const literal = value => `\`${value.replaceAll('`', 'ˋ')}\``;
const mentions = { parse: [] };

export function offerMessage({ request, prompt }, settings, noticeUrl) {
  const acts = request.acts.map(act => `${literal(act)}: ${ACTS[act].label}`).join(', ') || 'none';
  const content = [`Launch on ${settings.label}?`, `Pot: ${literal(request.pot)} · Title: ${literal(request.title)}`,
    `Prompt: attached file, ${Buffer.byteLength(prompt)} bytes, sha256 ${literal(request.digest)}`,
    `Runs as: a Pi in Herdr on ${settings.label}, as this Mac's user with no restriction: its files, credentials, network and this gate`,
    `Privileged acts declared: ${acts}`, `Cost declared: ${literal(request.cost || 'not stated')}`,
    `Notice: ${noticeUrl}`, `Expires <t:${Math.floor(request.expiresAt / 1000)}:R>`].join('\n');
  const components = [{ type: 1, components: [
    { type: 2, style: 3, label: `Launch on ${settings.label}`, custom_id: buttonId(request, BUTTON.launch) },
    { type: 2, style: 4, label: 'Refuse', custom_id: buttonId(request, BUTTON.refuse) },
  ] }];
  return { content, components, allowed_mentions: mentions, attachments: [{ id: 0, filename: `prompt-${request.digest.slice(0, 12)}.txt` }] };
}

export const closedMessage = offer => ({ content: `${offer.content.split('\n').slice(0, 2).join('\n')}\n${offer.state[0].toUpperCase()}${offer.state.slice(1)}.`,
  components: [], attachments: [], allowed_mentions: mentions });
