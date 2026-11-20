import { SNOWFLAKE } from './human-contract.mjs';
import { DISCORD_CONTENT } from './noticeboard-archive.mjs';
import { noticeboardConfiguration } from './noticeboard-policy.mjs';

const isId = value => typeof value === 'string' && SNOWFLAKE.test(value);
const ACCOUNT = /^[\w-]{1,64}$/;
const ATTACHMENT_FIELDS = { content_type: 'contentType', proxy_url: 'proxyUrl', duration_secs: 'durationSeconds' };
const UNSUPPORTED_FIELDS = ['poll', 'activity', 'application', 'application_id', 'interaction', 'interaction_metadata', 'message_snapshots'];

export function noticeboardDiscordScope({ account, channels }) {
  if (typeof account !== 'string' || !ACCOUNT.test(account)) throw new Error('noticeboards: invalid gateway account.');
  return { account, channels: noticeboardConfiguration({ enabled: true, channels }).channels };
}

function requireRoute(channels, candidate) {
  const route = channels.find(known => ['channelId', 'guildId', 'threadId', 'parentMessageId', 'kind'].every(field => known[field] === candidate?.[field]));
  if (!route) throw new Error('noticeboards: Discord request is outside the configured route.');
  return route;
}

function messagePath(channelId, messageId) {
  if (!isId(messageId)) throw new Error('noticeboards: invalid Discord message identity.');
  return `/channels/${channelId}/messages/${messageId}`;
}

function replyOf(reference) {
  if (!reference) return {};
  return Object.fromEntries([['guildId', reference.guild_id], ['channelId', reference.channel_id], ['messageId', reference.message_id]]
    .filter(([, value]) => value !== undefined));
}

function isRoutedMessage(message, route, id) {
  return message?.id === id && message.channel_id === route.channelId && (message.guild_id === undefined || message.guild_id === route.guildId);
}

function isPersonMessage(message) {
  return Boolean(message.author) && !message.author.system && message.webhook_id === undefined && !message.thread && !message.flags;
}

function hasPlainContent(message) {
  if (![0, 19].includes(message.type) || UNSUPPORTED_FIELDS.some(field => message[field] !== undefined)) return false;
  return !message.stickers?.length && !message.sticker_items?.length && (message.message_reference?.type ?? 0) === 0;
}

function authorOf(message) {
  const { author } = message;
  return { id: author.id, username: author.username, displayName: message.member?.nick ?? author.global_name ?? author.username, isBot: author.bot ?? false };
}

function attachmentsOf(message) {
  return message.attachments?.map(attachment => Object.fromEntries(Object.entries(attachment)
    .map(([key, value]) => [ATTACHMENT_FIELDS[key] ?? key, value])));
}

function sourceOf(message, route, id) {
  if (!isRoutedMessage(message, route, id) || !isPersonMessage(message) || !hasPlainContent(message)) return;
  return { id, channelId: route.channelId, guildId: route.guildId, type: message.type, content: message.content,
    author: authorOf(message), createdAt: message.timestamp, editedAt: message.edited_timestamp ?? '', isPinned: message.pinned,
    webhookId: '', attachments: attachmentsOf(message), components: message.components ?? [], embeds: message.embeds,
    reply: replyOf(message.message_reference), thread: {} };
}

export function noticeboardDiscord({ account, appUserId, channels, call }) {
  const scope = noticeboardDiscordScope({ account, channels });
  if (!isId(appUserId) || typeof call !== 'function') throw new Error('noticeboards: provide the shared app identity and Pots call transport.');
  const callDiscord = (method, body) => call(scope.account, method, body);
  return {
    async read(candidate, id) {
      const route = requireRoute(scope.channels, candidate);
      return sourceOf(await callDiscord(`GET ${messagePath(route.channelId, id)}`), route, id);
    },
    async createCopy(request, candidate) {
      const route = requireRoute(scope.channels, candidate);
      if (request.channelId !== route.threadId || typeof request.content !== 'string' || request.content.length > DISCORD_CONTENT || request.files !== undefined) {
        throw new Error('noticeboards: only bounded text archives can be posted to a configured discussion thread.');
      }
      const reply = await callDiscord(`POST /channels/${route.threadId}/messages`, {
        content: request.content, flags: 4, allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
      });
      return { id: reply?.id, channelId: reply?.channel_id };
    },
    async readCopy(identity, candidate) {
      const route = requireRoute(scope.channels, candidate);
      if (identity.channelId !== route.threadId) throw new Error('noticeboards: copy is outside its configured discussion thread.');
      const reply = await callDiscord(`GET ${messagePath(route.threadId, identity.id)}`);
      const isOwnedByApp = reply?.author?.id === appUserId && reply.author.bot === true && reply.webhook_id === undefined;
      if (reply?.id !== identity.id || reply.channel_id !== route.threadId || !isOwnedByApp || reply.attachments?.length !== 0) return;
      return { id: reply.id, channelId: reply.channel_id, content: reply.content, isOwnedByApp };
    },
    findCopy: () => ({ status: 'unknown' }),
  };
}
