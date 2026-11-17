import { DIALOG_ID, discordEvidence, discordMessageUrl, isSnowflake, LAUNCH_POLICY } from '../session/human-contract.mjs';
import { fetchedRequest, CLOCK_SKEW_MS, OPEN, sameRequest } from '../session/launch-contract.mjs';

export const PRESS_MAX_AGE_MS = 30_000;
const DISCORD_EPOCH = 1420070400000n;
const TIMESTAMP_SHIFT = 22n;
const pressedAt = id => Number((BigInt(id) >> TIMESTAMP_SHIFT) + DISCORD_EPOCH);
export const BUTTON = { launch: 'ml', refuse: 'mx' };
export const buttonId = (request, action) => `${action}:${request.launch}:${request.digest}`;

export function pressedButton(customId) {
  const [action, launch] = `${customId ?? ''}`.split(':');
  return Object.values(BUTTON).includes(action) && DIALOG_ID.test(launch) ? { action, launch } : undefined;
}

export function verifyOffer(shown, notice, settings, now) {
  const { request, prompt, state } = fetchedRequest(shown);
  const isBound = ['launch', 'pot', 'target'].every(key => request[key] === notice[key])
    && (notice.digest === undefined || sameRequest(request, notice));
  if (!isBound || request.target !== settings.name || !settings.pots.includes(request.pot)) throw new Error('mac-launch: the fetched launch names another pot or Mac.');
  if (state !== OPEN || now >= request.expiresAt || now < request.createdAt - CLOCK_SKEW_MS) throw new Error('mac-launch: this launch is closed, expired or from the future.');
  const refused = request.acts.filter(act => settings.refusedActs.includes(act));
  if (refused.length) throw new Error(`mac-launch: this Mac refuses ${refused.join(', ')}. Start that work manually.`);
  return { request, prompt };
}

export function verifyPress(event, offer, settings, now, action) {
  const { request } = offer;
  const message = event.message;
  const isContext = event.type === 3 && event.data?.component_type === 2 && event.application_id === offer.applicationId
    && event.guild_id === settings.guildId && event.channel_id === settings.channelId && message?.id === offer.messageId;
  const isMessage = message?.author?.id === offer.applicationId && !message.edited_timestamp && message.content === offer.content
    && message.attachments?.length === 1 && ['id', 'filename', 'size'].every(key => message.attachments[0][key] === offer.attachment[key]);
  if (!isContext || !isMessage || event.data.custom_id !== buttonId(request, action)) throw new Error('mac-launch: the press does not name this unedited offer.');
  if (!isSnowflake(event.id)) throw new Error('mac-launch: the press has no Discord timestamp.');
  const at = pressedAt(event.id);
  if (now < at - CLOCK_SKEW_MS || now - at > PRESS_MAX_AGE_MS || now >= request.expiresAt) throw new Error('mac-launch: this press is too old, from the future or expired.');
  const evidence = discordEvidence({ userId: event.member?.user?.id, guildId: event.guild_id,
    messageUrl: discordMessageUrl({ guildId: event.guild_id, channelId: event.channel_id, messageId: message.id }), at: new Date(at).toISOString() }, settings.humanDiscord, LAUNCH_POLICY);
  return { launch: request.launch, digest: request.digest, target: request.target, pot: request.pot, interaction: event.id, ...evidence };
}
