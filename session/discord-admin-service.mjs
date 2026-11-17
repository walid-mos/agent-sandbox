import { isThread, operationOf } from './discord-admin-operations.mjs';
import { guardChannels, guardRoles, requirePermission, requireProtection, requiresApproval } from './discord-admin-policy.mjs';

async function guildChannel(id, guildId, api) {
  const channel = await api('GET', `/channels/${id}`);
  if (!channel || channel.guild_id !== guildId) throw new Error('discord-admin: channel does not belong to the configured guild.');
  return channel;
}

async function protectedChannels(channels, protection, api) {
  const ids = [...new Set([...protection.channelIds, ...protection.threadIds])];
  const missing = ids.filter(id => !channels.some(channel => channel.id === id));
  const tracked = [...channels, ...await Promise.all(missing.map(id => guildChannel(id, protection.guildId, api)))];
  const parents = tracked.filter(channel => ids.includes(channel.id) && isThread(channel)).map(channel => channel.parent_id);
  return { channels: tracked, protection: { ...protection, channelIds: [...new Set([...protection.channelIds, ...parents])] } };
}

async function snapshotOf(request, { api, protection }) {
  requireProtection(protection, request.guildId);
  const bot = await api('GET', '/users/@me');
  const guild = await api('GET', `/guilds/${request.guildId}`);
  const roles = await api('GET', `/guilds/${request.guildId}/roles`);
  const botMember = await api('GET', `/guilds/${request.guildId}/members/${bot.id}`);
  const owned = await protectedChannels(await api('GET', `/guilds/${request.guildId}/channels`), protection, api);
  requireApplicationRole(request, { guild, roles, bot, protection });
  const channel = await optionalChannel(request.channelId, guild.id, api);
  const parent = await optionalChannel(request.payload.parent_id, guild.id, api);
  const threadParent = await parentOfThread(channel, guild.id, api);
  const targetMember = await memberOf(request, api);
  return { bot, guild, roles, botMember, channel, parent, threadParent, targetMember, ...owned };
}

function isApplicationRole(role, bot, protection) {
  return [role.managed, role.tags?.bot_id === bot.id, protection.botRoleIds.includes(role.id)].every(Boolean);
}

function requireApplicationRole(request, { guild, roles, bot, protection }) {
  if (guild.id !== request.guildId || !roles.some(role => isApplicationRole(role, bot, protection))) throw new Error('discord-admin: protection metadata does not identify this application managed role.');
}

function optionalChannel(id, guildId, api) {
  if (id) return guildChannel(id, guildId, api);
}

function parentOfThread(channel, guildId, api) {
  if (channel && isThread(channel)) return guildChannel(channel.parent_id, guildId, api);
}

function memberOf(request, api) {
  if (!request.action.startsWith('member.')) return;
  if (['member.unban', 'member.ban'].includes(request.action)) return;
  return api('GET', `/guilds/${request.guildId}/members/${request.userId}`);
}

function mutationBody(request) {
  if (request.action === 'role.position') return [{ id: request.roleId, position: request.payload.position }];
  return Object.keys(request.payload).length ? request.payload : undefined;
}

async function guardInvite(request, api) {
  if (request.action !== 'invite.delete') return;
  const invite = await api('GET', `/invites/${request.code}`);
  requireGuildInvite(invite, request.guildId);
  return { ...request, channelId: invite.channel.id };
}

function requireGuildInvite(invite, guildId) {
  if (![invite.guild?.id === guildId, invite.channel?.id].every(Boolean)) throw new Error('discord-admin: invite is outside the configured guild.');
}

export async function administerDiscord(input, dependencies) {
  const operation = operationOf(input);
  const request = (await guardInvite(operation.request, dependencies.api)) ?? operation.request;
  const snapshot = await snapshotOf(request, dependencies);
  guardChannels(request, snapshot);
  guardRoles(request, snapshot);
  requirePermission(request, operation, snapshot);
  if (requiresApproval(request, snapshot)) {
    const approval = await dependencies.approvals.authorize(request, { ownerId: snapshot.guild.owner_id });
    if (approval.status !== 'authorized') return approval;
  }
  const result = await dependencies.api(operation.method, operation.path, mutationBody(request), request.reason);
  return { status: 'completed', action: request.action, result };
}
