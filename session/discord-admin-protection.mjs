import { isThread, snowflake } from './discord-admin-operations.mjs';

const unique = values => [...new Set(values)];
const validIds = ids => Array.isArray(ids) && ids.every(snowflake);

export const protectedIds = protection => [...protection.channelIds, ...protection.threadIds];
export const isApplicationRole = (role, botId) => Boolean(role.managed) && role.tags?.bot_id === botId;

export function protectionOf({ guildId, channelIds, threadIds, roles, botId }) {
  const botRoleIds = roles.filter(role => isApplicationRole(role, botId)).map(role => role.id);
  if (!botRoleIds.length) throw new Error('discord-admin: application managed role is missing.');
  return { guildId, channelIds: unique(channelIds), threadIds: unique(threadIds), botRoleIds };
}

export function requireProtection(protection, guildId) {
  const lists = [protection?.channelIds, protection?.threadIds, protection?.botRoleIds];
  if (protection?.guildId !== guildId || !lists.every(validIds) || !protection.channelIds.length || !protection.botRoleIds.length) {
    throw new Error('discord-admin: protection metadata is missing or invalid. Restore owning runtime metadata before administering this guild.');
  }
}

export function withThreadParents(protection, channels) {
  const ids = protectedIds(protection);
  const parents = channels.filter(channel => ids.includes(channel.id) && isThread(channel)).map(channel => channel.parent_id);
  return { ...protection, channelIds: unique([...protection.channelIds, ...parents]) };
}
