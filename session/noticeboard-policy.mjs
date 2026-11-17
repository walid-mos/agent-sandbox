import { createHash } from 'node:crypto';
import { SNOWFLAKE } from './human-contract.mjs';

export const NOTICEBOARD_LIMITS = Object.freeze({ channels: 2, records: 1024, bytes: 64 * 1024 * 1024,
  attachmentBytes: 8 * 1024 * 1024, attachments: 9, snapshotBytes: 64 * 1024, content: 6000,
  attempts: 5, retryMs: 2000, retentionMs: 30 * 24 * 60 * 60_000, batch: 16 });
export const fingerprint = value => createHash('sha256').update(value).digest('hex');
export const snapshotKey = value => fingerprint(JSON.stringify(value, (key, entry) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  return Object.fromEntries(Object.keys(entry).sort().map(field => [field, entry[field]]));
}));
const isId = value => typeof value === 'string' && SNOWFLAKE.test(value);
const isText = (value, maximum) => typeof value === 'string' && value.length <= maximum;
const requireValue = valid => { if (!valid) throw new Error('noticeboards: invalid bounded configuration or message.'); };
const onlyFields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const ATTACHMENT_FIELDS = ['id', 'filename', 'size', 'contentType', 'url', 'proxyUrl', 'height', 'width', 'description', 'ephemeral', 'durationSeconds', 'waveform', 'flags', 'title'];

export function noticeboardConfiguration(configuration = {}) {
  if (configuration.enabled !== true) return { enabled: false, channels: [] };
  const { channels } = configuration;
  requireValue(Array.isArray(channels) && channels.length > 0 && channels.length <= NOTICEBOARD_LIMITS.channels);
  for (const route of channels) {
    requireValue([route.channelId, route.guildId, route.threadId, route.parentMessageId].every(isId));
    requireValue(route.threadId === route.parentMessageId && route.channelId !== route.threadId);
    requireValue(['pull-requests', 'server-log'].includes(route.kind));

  }
  requireValue(new Set(channels.map(route => route.channelId)).size === channels.length);
  return { enabled: true, channels };
}

export function routeFor(event, configuration) {
  if (!event) return undefined;
  requireValue(Number.isSafeInteger(event.id) && event.id > 0 && isId(event.channelId) && isId(event.messageId));
  requireValue(['create', 'update', 'delete'].includes(event.kind));
  return configuration.channels.find(route => route.channelId === event.channelId);
}

export function snapshotOf(message, event, route) {
  requireValue(message?.id === event.messageId && message.channelId === route.channelId && message.guildId === route.guildId);
  requireValue(message.type === 0 && isText(message.content, NOTICEBOARD_LIMITS.content));
  requireValue(onlyFields(message.author, ['id', 'username', 'displayName', 'isBot']));
  requireValue(isId(message.author.id) && isText(message.author.username, 128) && isText(message.author.displayName, 128));
  requireValue(typeof message.author.isBot === 'boolean' && typeof message.isPinned === 'boolean' && isText(message.webhookId, 20));
  requireValue(Number.isFinite(Date.parse(message.createdAt)) && (message.editedAt === '' || Number.isFinite(Date.parse(message.editedAt))));
  requireValue(Array.isArray(message.attachments) && message.attachments.length <= NOTICEBOARD_LIMITS.attachments);
  requireValue(message.attachments.every(attachment => onlyFields(attachment, ATTACHMENT_FIELDS)));
  requireValue(Array.isArray(message.components) && Array.isArray(message.embeds));
  requireValue(onlyFields(message.reply, ['guildId', 'channelId', 'messageId']) && Object.values(message.reply).every(isId));
  requireValue(onlyFields(message.thread, ['id', 'parentId']) && Object.values(message.thread).every(isId));
  const fields = ['id', 'channelId', 'guildId', 'type', 'content', 'author', 'createdAt', 'editedAt', 'attachments', 'components', 'embeds', 'isPinned', 'webhookId', 'reply', 'thread'];
  const snapshot = Object.fromEntries(fields.map(field => [field, message[field]]));
  requireValue(Buffer.byteLength(JSON.stringify(snapshot)) <= NOTICEBOARD_LIMITS.snapshotBytes);
  return snapshot;
}

export function isHumanComment(snapshot) {
  if (snapshot.isPinned || snapshot.components.length || snapshot.embeds.length) return false;
  return !snapshot.author.isBot && !snapshot.webhookId;
}

export function attachmentOf(attachment) {
  requireValue(isId(attachment.id) && isText(attachment.filename, 128) && attachment.filename.length > 0);
  requireValue(Number.isSafeInteger(attachment.size) && attachment.size >= 0 && attachment.size <= NOTICEBOARD_LIMITS.attachmentBytes);
  const url = new URL(attachment.url);
  requireValue(url.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname));
  requireValue(!url.username && !url.password && !url.port && url.pathname.startsWith('/attachments/'));
  return attachment;
}
