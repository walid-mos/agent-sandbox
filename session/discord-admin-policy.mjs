import { CHANNEL, CHANNEL_TOPIC_LIMIT, DISCORD_PERMISSIONS, FORUM_TOPIC_LIMIT, isThread, OVERWRITE, STANDALONE_THREAD_TYPES } from './discord-admin-operations.mjs';
import { protectedIds } from './discord-admin-protection.mjs';

const isRename = payload => Object.keys(payload).length === 1 && typeof payload.name === 'string';
const rejectProtected = () => { throw new Error('discord-admin: protected pot resource cannot be changed by this operation.'); };

function isProtectedChannel(request, { channels, protection, channel }) {
  const ids = new Set(protectedIds(protection));
  const hasProtectedChild = channels.some(item => item.parent_id === request.channelId && ids.has(item.id));
  return [ids.has(request.channelId), hasProtectedChild, ids.has(channel?.parent_id)].some(Boolean);
}

function guardProtectedEdit(request, snapshot) {
  if (!isProtectedChannel(request, snapshot)) return;
  if (request.action.endsWith('.edit') && isRename(request.payload)) return;
  rejectProtected();
}

function guardDestination(request, snapshot) {
  const parentId = request.payload.parent_id;
  if (!parentId) return;
  if (protectedIds(snapshot.protection).includes(parentId)) rejectProtected();
  if (snapshot.parent.type !== CHANNEL.category) throw new Error('discord-admin: parent_id must name a category in this guild.');
}

const protectedRoleIds = snapshot => new Set([...snapshot.protection.botRoleIds, ...snapshot.botMember.roles]);

function isBotOverwrite(item, snapshot) {
  return protectedRoleIds(snapshot).has(item.id) || (item.type === OVERWRITE.member && item.id === snapshot.bot.id);
}

function guardOverwrites(request, snapshot) {
  if (request.payload.permission_overwrites?.some(item => isBotOverwrite(item, snapshot))) rejectProtected();
}

function guardChannelType(request, channel) {
  if (!channel) return;
  if (request.action.startsWith('channel.') && isThread(channel)) throw new Error('discord-admin: use a thread operation for a thread.');
}

function guardTopic(request, channel) {
  const type = request.action === 'channel.create' ? request.payload.type : channel?.type;
  const limit = [CHANNEL.forum, CHANNEL.media].includes(type) ? FORUM_TOPIC_LIMIT : CHANNEL_TOPIC_LIMIT;
  if (request.payload.topic?.length > limit) throw new Error(`discord-admin: topic exceeds ${limit} characters for this channel type.`);
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
  guardTopic(request, snapshot.channel);
  guardThreadType(request, snapshot.channel);
}

function guardThreadCreation(request, channel) {
  if (![CHANNEL.text, CHANNEL.announcement].includes(channel?.type)) throw new Error('discord-admin: thread creation needs a text or announcement parent channel.');
  if (request.messageId) return requireMessageThread(request);
  requireStandaloneThread(request, channel);
}

function requireMessageThread(request) {
  if (request.payload.type !== undefined) throw new Error('discord-admin: a message thread inherits its type. Omit type.');
}

function requireStandaloneThread(request, channel) {
  if (!STANDALONE_THREAD_TYPES.includes(request.payload.type)) throw new Error('discord-admin: thread creation without a message requires explicit public or private type.');
  if (channel.type !== CHANNEL.text) throw new Error('discord-admin: announcement threads require a parent message.');
}

function guardProtectedRoles(request, snapshot) {
  const protectedRoles = protectedRoleIds(snapshot);
  if (protectedRoles.has(request.roleId)) rejectProtected();
  if (request.userId === snapshot.bot.id) rejectProtected();
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
  const targetsOwner = request.userId === snapshot.guild.owner_id;
  if (targetsOwner && (snapshot.targetMember || request.action === 'role.revoke')) throw new Error('discord-admin: guild owner or member hierarchy prevents this operation.');
  if (!snapshot.targetMember) return;
  const targetPosition = Math.max(0, ...snapshot.roles.filter(item => snapshot.targetMember.roles.includes(item.id)).map(item => item.position));
  if (targetPosition >= botPosition) throw new Error('discord-admin: guild owner or member hierarchy prevents this operation.');
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
  return overwrites.some(item => item.type === OVERWRITE.role && item.id === request.guildId);
}

export const ADMIN_APPROVAL_RULES = [
  { description: 'A supplied approval ID must always be validated and consumed once.', applies: request => Object.hasOwn(request, 'approval') },
  { description: 'Operations marked irreversible always require approval.', applies: (_request, operation) => operation.approval },
  { description: 'Changing everyone permissions or existing/proposed everyone overwrites requires approval.', applies: (request, _operation, snapshot) => changesEveryone(request, snapshot) },
];

export function requiresApproval(request, operation, snapshot) {
  return ADMIN_APPROVAL_RULES.some(rule => rule.applies(request, operation, snapshot));
}

export function guildPermissions(roles, memberRoles, guildId) {
  return roles.filter(role => role.id === guildId || memberRoles.includes(role.id)).reduce((bits, role) => bits | BigInt(role.permissions), 0n);
}

function requiredThreadPermission(request, operation) {
  if (request.action === 'thread.create' && request.payload.type === CHANNEL.privateThread) return 'CreatePrivateThreads';
  return operation.permission;
}

function resourcePermissions(granted, snapshot) {
  if (!snapshot.channel) return granted;
  const channel = isThread(snapshot.channel) ? snapshot.threadParent : snapshot.channel;
  return channelPermissions(granted, channel, snapshot.botMember, snapshot.guild.id, snapshot.bot.id);
}

export function requirePermission(request, operation, snapshot) {
  if (snapshot.guild.owner_id === snapshot.bot.id) return;
  let granted = guildPermissions(snapshot.roles, snapshot.botMember.roles, snapshot.guild.id);
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
  granted = applyOverwrites(granted, overwrites.filter(entry => entry.type === OVERWRITE.role && entry.id === guildId));
  granted = applyOverwrites(granted, overwrites.filter(entry => entry.type === OVERWRITE.role && member.roles.includes(entry.id)));
  return applyOverwrites(granted, overwrites.filter(entry => entry.type === OVERWRITE.member && entry.id === botId));
}
