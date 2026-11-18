import { DIALOG_ID, discordEvidence, discordMessageUrl, isSnowflake, LAUNCH_POLICY } from '../session/human-contract.mjs';
import { fetchedRequest, CLOCK_SKEW_MS, OPEN, sameRequest } from '../session/launch-contract.mjs';
import { executionFingerprint, executionScope } from './launch-execution-contract.mjs';

const PRESS_MAX_AGE_MS = 30_000;
// The press has its own limit up to the claim, so a slow start is judged from the claim and a Mac that slept in between still starts nothing.
export const CLAIM_MAX_AGE_MS = 30_000;
export const CLAIMED = 'claimed';
const DISCORD_EPOCH = 1420070400000n;
const TIMESTAMP_SHIFT = 22n;
const pressedAt = id => Number((BigInt(id) >> TIMESTAMP_SHIFT) + DISCORD_EPOCH);
export const BUTTON = { launch: 'ml', refuse: 'mx' };
export const buttonId = (request, action) => `${action}:${request.launch}:${request.digest}`;

export function pressedButton(customId) {
  const [action, launch] = `${customId ?? ''}`.split(':');
  return Object.values(BUTTON).includes(action) && DIALOG_ID.test(launch) ? { action, launch } : undefined;
}

export function boundRequest(shown, notice, settings) {
  const fetched = fetchedRequest(shown);
  const { request } = fetched;
  const isBound = ['launch', 'pot', 'target'].every(key => request[key] === notice[key])
    && (notice.digest === undefined || sameRequest(request, notice));
  if (!isBound || request.target !== settings.name || !settings.pots.includes(request.pot)) throw new Error('mac-launch: the fetched launch names another pot or Mac.');
  return fetched;
}

export function verifyOffer(shown, notice, settings, now) {
  const { request, prompt, state } = boundRequest(shown, notice, settings);
  if (state !== OPEN || now >= request.expiresAt || now < request.createdAt - CLOCK_SKEW_MS) throw new Error('mac-launch: this launch is closed, expired or from the future.');
  const refused = request.acts.filter(act => settings.refusedActs.includes(act));
  if (refused.length) throw new Error(`mac-launch: this Mac refuses ${refused.join(', ')}. Start that work manually.`);
  executionScope(settings, request.acts);
  return { request, prompt, executionDigest: executionFingerprint(settings) };
}

function requirePressContext(event, offer, settings) {
  const isButton = event.type === 3 && event.data?.component_type === 2;
  const isOffer = event.application_id === offer.applicationId && event.guild_id === settings.guildId
    && event.channel_id === settings.channelId && event.message?.id === offer.messageId;
  if (!isButton || !isOffer) throw new Error('mac-launch: the press does not name this unedited offer.');
}

function requireOfferMessage(event, offer, action) {
  const message = event.message;
  const isExactMessage = message?.author?.id === offer.applicationId && !message.edited_timestamp && message.content === offer.content;
  const [attachment] = message?.attachments ?? [];
  const isExactAttachment = message?.attachments?.length === 1 && ['id', 'filename', 'size'].every(key => attachment[key] === offer.attachment[key]);
  if (!isExactMessage || !isExactAttachment || event.data.custom_id !== buttonId(offer.request, action)) {
    throw new Error('mac-launch: the press does not name this unedited offer.');
  }
}

function requireFreshPress(event, request, now) {
  if (!isSnowflake(event.id)) throw new Error('mac-launch: the press has no Discord timestamp.');
  const at = pressedAt(event.id);
  if (now < at - CLOCK_SKEW_MS || now - at > PRESS_MAX_AGE_MS || now >= request.expiresAt) throw new Error('mac-launch: this press is too old, from the future or expired.');
  return at;
}

export function verifyPress(event, offer, settings, now, action) {
  const { request } = offer;
  if (offer.executionDigest !== executionFingerprint(settings)) throw new Error('mac-launch: the execution scope changed. Ask for a new offer.');
  requirePressContext(event, offer, settings);
  requireOfferMessage(event, offer, action);
  const at = requireFreshPress(event, request, now);
  const message = event.message;
  const evidence = discordEvidence({ userId: event.member?.user?.id, guildId: event.guild_id,
    messageUrl: discordMessageUrl({ guildId: event.guild_id, channelId: event.channel_id, messageId: message.id }), at: new Date(at).toISOString() }, settings.humanDiscord, LAUNCH_POLICY);
  return { launch: request.launch, digest: request.digest, target: request.target, pot: request.pot, interaction: event.id, executionDigest: offer.executionDigest, ...evidence };
}
