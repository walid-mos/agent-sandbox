import { isSnowflake } from './human-contract.mjs';

export const DISCORD_PERMISSIONS = {
  CreateInstantInvite: 1n, KickMembers: 2n, BanMembers: 4n, Administrator: 8n, ManageChannels: 16n,
  ManageGuild: 32n, ViewChannel: 1024n, ManageRoles: 268435456n, ManageNicknames: 134217728n,
  ManageThreads: 17179869184n, CreatePublicThreads: 34359738368n, CreatePrivateThreads: 68719476736n, ModerateMembers: 1099511627776n,
};
const THREAD_TYPES = [10, 11, 12];
export const isThread = channel => THREAD_TYPES.includes(channel.type);
const includesId = (ids, id) => ids.includes(id);
const isRename = payload => Object.keys(payload).length === 1 && typeof payload.name === 'string';
const rejectProtected = () => { throw new Error('discord-admin: protected pot resource cannot be changed by this operation.'); };

export function requireProtection(protection, guildId) {
  if (protection?.guildId !== guildId || !['channelIds', 'threadIds', 'botRoleIds'].every(key => Array.isArray(protection[key]) && protection[key].every(id => typeof id === 'string' && isSnowflake(id)))
    || !protection.channelIds.length || !protection.botRoleIds.length) throw new Error('discord-admin: protection metadata is missing or invalid. Restore owning runtime metadata before administering this guild.');
}

export function guardChannels(request, snapshot) {
  const { channels, protection, channel } = snapshot;
  const protectedIds = [...protection.channelIds, ...protection.threadIds];
  const hasProtectedChild = channels.some(item => item.parent_id === request.channelId && includesId(protectedIds, item.id));
  const isProtected = includesId(protectedIds, request.channelId) || hasProtectedChild || (channel && includesId(protectedIds, channel.parent_id));
  if (isProtected && !(request.action.endsWith('.edit') && isRename(request.payload))) rejectProtected();
  const parentId = request.payload.parent_id;
  if (parentId && includesId(protectedIds, parentId)) rejectProtected();
  if (request.payload.permission_overwrites?.some(item => protection.botRoleIds.includes(item.id) || (item.type === 1 && item.id === snapshot.bot.id))) rejectProtected();
  if (request.action.startsWith('thread.') && request.action !== 'thread.create' && !isThread(channel)) throw new Error('discord-admin: thread operation requires a thread.');
  if (request.action.startsWith('channel.') && channel && isThread(channel)) throw new Error('discord-admin: use a thread operation for a thread.');
  if (request.action === 'thread.create') guardThreadCreation(request, channel);
  if (parentId && snapshot.parent?.type !== 4) throw new Error('discord-admin: parent_id must name a category in this guild.');
}

function guardThreadCreation(request, channel) {
  if (![0, 5].includes(channel?.type)) throw new Error('discord-admin: thread creation needs a text or announcement parent channel.');
  if (!request.messageId && ![11, 12].includes(request.payload.type)) throw new Error('discord-admin: thread creation without a message requires explicit public or private type.');
  if (request.messageId && request.payload.type !== undefined) throw new Error('discord-admin: a message thread inherits its type. Omit type.');
  if (!request.messageId && (channel.type !== 0 || request.payload.type === 10)) throw new Error('discord-admin: announcement threads require a parent message.');
}

export function guardRoles(request, snapshot) {
  const { roles, protection, botMember, guild, bot, targetMember } = snapshot;
  const protectedRoles = new Set([...protection.botRoleIds, ...botMember.roles]);
  if (protectedRoles.has(request.roleId)) rejectProtected();
  if (request.userId === bot.id) rejectProtected();
  const role = request.roleId && roles.find(item => item.id === request.roleId);
  if (request.roleId && !role) throw new Error('discord-admin: role does not belong to this guild.');
  const botPosition = Math.max(...roles.filter(item => botMember.roles.includes(item.id)).map(item => item.position));
  if (role?.managed || (role && role.id !== guild.id && role.position >= botPosition)) throw new Error('discord-admin: managed role or role hierarchy prevents this operation.');
  if (request.action === 'role.position') guardRolePosition(request, roles, protectedRoles, role, botPosition);
  if (!targetMember || request.action === 'member.unban') return;
  const targetPosition = Math.max(0, ...roles.filter(item => targetMember.roles.includes(item.id)).map(item => item.position));
  if (request.userId === guild.owner_id || targetPosition >= botPosition) throw new Error('discord-admin: guild owner or member hierarchy prevents this operation.');
  if (request.action === 'member.timeout' && roles.some(item => targetMember.roles.includes(item.id) && (BigInt(item.permissions) & DISCORD_PERMISSIONS.Administrator))) throw new Error('discord-admin: administrators cannot be timed out.');
}

function guardRolePosition(request, roles, protectedRoles, role, botPosition) {
  const position = request.payload.position;
  if (!role || position >= botPosition) throw new Error('discord-admin: role position must remain below the bot.');
  const lower = Math.min(role.position, position);
  const upper = Math.max(role.position, position);
  if (roles.some(item => protectedRoles.has(item.id) && item.position >= lower && item.position <= upper)) rejectProtected();
}

export function requiresApproval(request, snapshot) {
  if (['channel.delete', 'thread.delete', 'role.delete', 'member.kick', 'member.ban'].includes(request.action)) return true;
  if (request.action === 'role.revoke' && request.userId === snapshot.guild.owner_id) return true;
  if (request.roleId === request.guildId && Object.hasOwn(request.payload, 'permissions')) return true;
  if (!Object.hasOwn(request.payload, 'permission_overwrites')) return false;
  return [...request.payload.permission_overwrites, ...(snapshot.channel?.permission_overwrites ?? [])].some(item => item.type === 0 && item.id === request.guildId);
}

export function requirePermission(request, operation, snapshot) {
  const { guild, botMember, roles, channel } = snapshot;
  if (guild.owner_id === snapshot.bot.id) return;
  let granted = roles.filter(role => role.id === guild.id || botMember.roles.includes(role.id)).reduce((bits, role) => bits | BigInt(role.permissions), 0n);
  if (granted & DISCORD_PERMISSIONS.Administrator) return;
  if (channel) granted = channelPermissions(granted, isThread(channel) ? snapshot.threadParent : channel, botMember, guild.id, snapshot.bot.id);
  const permission = request.action === 'thread.create' && request.payload.type === 12 ? 'CreatePrivateThreads' : operation.permission;
  if (!(granted & DISCORD_PERMISSIONS[permission])) throw new Error(`discord-admin: missing ${permission} permission. The configured bot role or this channel denies it. No wider credential is used.`);
}

function channelPermissions(granted, channel, member, guildId, botId) {
  if (!channel) throw new Error('discord-admin: thread parent metadata is missing.');
  const overwrites = channel.permission_overwrites ?? [];
  const apply = (bits, entries) => {
    const deny = entries.reduce((combined, entry) => combined | BigInt(entry.deny), 0n);
    const allow = entries.reduce((combined, entry) => combined | BigInt(entry.allow), 0n);
    return (bits & ~deny) | allow;
  };
  granted = apply(granted, overwrites.filter(entry => entry.type === 0 && entry.id === guildId));
  granted = apply(granted, overwrites.filter(entry => entry.type === 0 && member.roles.includes(entry.id)));
  return apply(granted, overwrites.filter(entry => entry.type === 1 && entry.id === botId));
}
