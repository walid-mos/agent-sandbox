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

function withThreadParents(protection, channels) {
  const ids = protectedIds(protection);
  const parents = channels.filter(channel => ids.includes(channel.id) && isThread(channel)).map(channel => channel.parent_id);
  return { ...protection, channelIds: unique([...protection.channelIds, ...parents]) };
}

export async function guildChannel(id, guildId, api) {
  const channel = await api('GET', `/channels/${id}`);
  if (!channel || channel.guild_id !== guildId) throw new Error('discord-admin: channel does not belong to the configured guild.');
  return channel;
}

async function trackedChannel(id, guildId, api) {
  try { return await guildChannel(id, guildId, api); }
  catch (error) {
    if (error.discordCode !== 10003) throw error;
  }
}

export async function protectedChannels(channels, protection, api) {
  const missing = unique(protectedIds(protection)).filter(id => !channels.some(channel => channel.id === id));
  const resolved = await Promise.all(missing.map(id => trackedChannel(id, protection.guildId, api)));
  const tracked = [...channels, ...resolved.filter(Boolean)];
  return { channels: tracked, protection: withThreadParents(protection, tracked) };
}
