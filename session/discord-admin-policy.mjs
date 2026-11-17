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
const validId = id => typeof id === 'string' && isSnowflake(id);
const validIds = ids => Array.isArray(ids) && ids.every(validId);

export function requireProtection(protection, guildId) {
  if (protection?.guildId !== guildId) throw new Error('discord-admin: protection metadata is missing or invalid. Restore owning runtime metadata before administering this guild.');
  if (!validProtectionLists(protection)) throw new Error('discord-admin: protection metadata is missing or invalid. Restore owning runtime metadata before administering this guild.');
}

function validProtectionLists(protection) {
  return [['channelIds', 'threadIds', 'botRoleIds'].every(key => validIds(protection[key])), protection.channelIds?.length, protection.botRoleIds?.length].every(Boolean);
}

function isProtectedChannel(request, { channels, protection, channel }) {
  const ids = [...protection.channelIds, ...protection.threadIds];
  const hasProtectedChild = channels.some(item => item.parent_id === request.channelId && includesId(ids, item.id));
  return [includesId(ids, request.channelId), hasProtectedChild, includesId(ids, channel?.parent_id)].some(Boolean);
}

function guardProtectedEdit(request, snapshot) {
  if (!isProtectedChannel(request, snapshot)) return;
  if (request.action.endsWith('.edit') && isRename(request.payload)) return;
  rejectProtected();
}

function guardDestination(request, snapshot) {
  const parentId = request.payload.parent_id;
  if (!parentId) return;
  if ([...snapshot.protection.channelIds, ...snapshot.protection.threadIds].includes(parentId)) rejectProtected();
  if (snapshot.parent.type !== 4) throw new Error('discord-admin: parent_id must name a category in this guild.');
}

function isBotOverwrite(item, snapshot) {
  return snapshot.protection.botRoleIds.includes(item.id) || (item.type === 1 && item.id === snapshot.bot.id);
}

function guardOverwrites(request, snapshot) {
  if (request.payload.permission_overwrites?.some(item => isBotOverwrite(item, snapshot))) rejectProtected();
}

function guardChannelType(request, channel) {
  if (!channel) return;
  if (request.action.startsWith('channel.') && isThread(channel)) throw new Error('discord-admin: use a thread operation for a thread.');
}

function guardThreadType(request, channel) {
  if (!request.action.startsWith('thread.')) return;
  if (request.action === 'thread.create') return guardThreadCreation(request, channel);
  if (!isThread(channel)) throw new Error('discord-admin: thread operation requires a thread.');
}

export function guardChannels(request, snapshot) {
  guardProtectedEdit(request, snapshot);
  guardDestination(request, snapshot);
  guardOverwrites(request, snapshot);
  guardChannelType(request, snapshot.channel);
  guardThreadType(request, snapshot.channel);
}

function guardThreadCreation(request, channel) {
  if (![0, 5].includes(channel?.type)) throw new Error('discord-admin: thread creation needs a text or announcement parent channel.');
  if (request.messageId) return requireMessageThread(request);
  requireStandaloneThread(request, channel);
}

function requireMessageThread(request) {
  if (request.payload.type !== undefined) throw new Error('discord-admin: a message thread inherits its type. Omit type.');
}

function requireStandaloneThread(request, channel) {
  if (![11, 12].includes(request.payload.type)) throw new Error('discord-admin: thread creation without a message requires explicit public or private type.');
  if (channel.type !== 0) throw new Error('discord-admin: announcement threads require a parent message.');
}

function guardProtectedRoles(request, { protection, botMember, bot }) {
  const protectedRoles = new Set([...protection.botRoleIds, ...botMember.roles]);
  if (protectedRoles.has(request.roleId)) rejectProtected();
  if (request.userId === bot.id) rejectProtected();
  return protectedRoles;
}

function requireRoleHierarchy(role, guild, botPosition) {
  if (role?.managed) throw new Error('discord-admin: managed role prevents this operation.');
  requireRolePosition(role, guild, botPosition);
}

function requireRolePosition(role, guild, botPosition) {
  if (!role) return;
  if (role.id === guild.id) return;
  if (role.position >= botPosition) throw new Error('discord-admin: role hierarchy prevents this operation.');
}

function guardMemberHierarchy(request, snapshot, botPosition) {
  if (!snapshot.targetMember) return;
  if (request.action === 'member.unban') return;
  const targetPosition = Math.max(0, ...snapshot.roles.filter(item => snapshot.targetMember.roles.includes(item.id)).map(item => item.position));
  if ([request.userId === snapshot.guild.owner_id, targetPosition >= botPosition].some(Boolean)) throw new Error('discord-admin: guild owner or member hierarchy prevents this operation.');
  guardTimeout(request, snapshot);
}

function guardTimeout(request, snapshot) {
  if (request.action !== 'member.timeout') return;
  const isAdministrator = snapshot.roles.some(item => snapshot.targetMember.roles.includes(item.id) && (BigInt(item.permissions) & DISCORD_PERMISSIONS.Administrator));
  if (isAdministrator) throw new Error('discord-admin: administrators cannot be timed out.');
}

export function guardRoles(request, snapshot) {
  const protectedRoles = guardProtectedRoles(request, snapshot);
  const role = snapshot.roles.find(item => item.id === request.roleId);
  if (request.roleId && !role) throw new Error('discord-admin: role does not belong to this guild.');
  const botPosition = Math.max(...snapshot.roles.filter(item => snapshot.botMember.roles.includes(item.id)).map(item => item.position));
  requireRoleHierarchy(role, snapshot.guild, botPosition);
  if (request.action === 'role.position') guardRolePosition(request, snapshot.roles, protectedRoles, role, botPosition);
  guardMemberHierarchy(request, snapshot, botPosition);
}

function guardRolePosition(request, roles, protectedRoles, role, botPosition) {
  const position = request.payload.position;
  if (!role || position >= botPosition) throw new Error('discord-admin: role position must remain below the bot.');
  const lower = Math.min(role.position, position);
  const upper = Math.max(role.position, position);
  if (roles.some(item => [protectedRoles.has(item.id), item.position >= lower, item.position <= upper].every(Boolean))) rejectProtected();
}

const changesEveryoneRole = request => request.roleId === request.guildId && Object.hasOwn(request.payload, 'permissions');
const existingOverwrites = snapshot => snapshot.channel?.permission_overwrites ?? [];

function changesEveryone(request, snapshot) {
  if (changesEveryoneRole(request)) return true;
  if (!Object.hasOwn(request.payload, 'permission_overwrites')) return false;
  const overwrites = [...request.payload.permission_overwrites, ...existingOverwrites(snapshot)];
  return overwrites.some(item => item.type === 0 && item.id === request.guildId);
}

export function requiresApproval(request, snapshot) {
  if (['channel.delete', 'thread.delete', 'role.delete', 'member.kick', 'member.ban'].includes(request.action)) return true;
  if (request.action === 'role.revoke' && request.userId === snapshot.guild.owner_id) return true;
  return changesEveryone(request, snapshot);
}

function guildPermissions({ guild, botMember, roles }) {
  return roles.filter(role => role.id === guild.id || botMember.roles.includes(role.id)).reduce((bits, role) => bits | BigInt(role.permissions), 0n);
}

function requiredThreadPermission(request, operation) {
  if (request.action === 'thread.create' && request.payload.type === 12) return 'CreatePrivateThreads';
  return operation.permission;
}

function resourcePermissions(granted, snapshot) {
  if (!snapshot.channel) return granted;
  const channel = isThread(snapshot.channel) ? snapshot.threadParent : snapshot.channel;
  return channelPermissions(granted, channel, snapshot.botMember, snapshot.guild.id, snapshot.bot.id);
}

export function requirePermission(request, operation, snapshot) {
  if (snapshot.guild.owner_id === snapshot.bot.id) return;
  let granted = guildPermissions(snapshot);
  if (granted & DISCORD_PERMISSIONS.Administrator) return;
  granted = resourcePermissions(granted, snapshot);
  const permission = requiredThreadPermission(request, operation);
  if (!(granted & DISCORD_PERMISSIONS[permission])) throw new Error(`discord-admin: missing ${permission} permission. The configured bot role or this channel denies it. No wider credential is used.`);
}

function applyOverwrites(bits, entries) {
  const deny = entries.reduce((combined, entry) => combined | BigInt(entry.deny), 0n);
  const allow = entries.reduce((combined, entry) => combined | BigInt(entry.allow), 0n);
  return (bits & ~deny) | allow;
}

function channelPermissions(granted, channel, member, guildId, botId) {
  if (!channel) throw new Error('discord-admin: thread parent metadata is missing.');
  const overwrites = channel.permission_overwrites ?? [];
  granted = applyOverwrites(granted, overwrites.filter(entry => entry.type === 0 && entry.id === guildId));
  granted = applyOverwrites(granted, overwrites.filter(entry => entry.type === 0 && member.roles.includes(entry.id)));
  return applyOverwrites(granted, overwrites.filter(entry => entry.type === 1 && entry.id === botId));
}
