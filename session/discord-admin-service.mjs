import { isThread, operationOf } from './discord-admin-operations.mjs';
import { guardChannels, guardRoles, requirePermission, requiresApproval } from './discord-admin-policy.mjs';
import { isApplicationRole, protectedIds, requireProtection, withThreadParents } from './discord-admin-protection.mjs';

async function guildChannel(id, guildId, api) {
  const channel = await api('GET', `/channels/${id}`);
  if (!channel || channel.guild_id !== guildId) throw new Error('discord-admin: channel does not belong to the configured guild.');
  return channel;
}

async function protectedChannels(channels, protection, api) {
  const ids = [...new Set(protectedIds(protection))];
  const missing = ids.filter(id => !channels.some(channel => channel.id === id));
  const tracked = [...channels, ...await Promise.all(missing.map(id => guildChannel(id, protection.guildId, api)))];
  return { channels: tracked, protection: withThreadParents(protection, tracked) };
}

async function snapshotOf(request, operation, { api, protection }) {
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
  const targetMember = await memberOf(request, operation, api);
  return { bot, guild, roles, botMember, channel, parent, threadParent, targetMember, ...owned };
}

function requireApplicationRole(request, { guild, roles, bot, protection }) {
  if (guild.id !== request.guildId || !roles.some(role => isApplicationRole(role, bot.id) && protection.botRoleIds.includes(role.id))) throw new Error('discord-admin: protection metadata does not identify this application managed role.');
}

function optionalChannel(id, guildId, api) {
  if (id) return guildChannel(id, guildId, api);
}

function parentOfThread(channel, guildId, api) {
  if (channel && isThread(channel)) return guildChannel(channel.parent_id, guildId, api);
}

function memberOf(request, operation, api) {
  if (operation.loadsMember) return api('GET', `/guilds/${request.guildId}/members/${request.userId}`);
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
  const snapshot = await snapshotOf(request, operation, dependencies);
  guardChannels(request, snapshot);
  guardRoles(request, snapshot);
  requirePermission(request, operation, snapshot);
  if (requiresApproval(request, operation, snapshot)) {
    const approval = await dependencies.approvals.authorize(request, { ownerId: snapshot.guild.owner_id });
    if (approval.status !== 'authorized') return approval;
  }
  const result = await dependencies.api(operation.method, operation.path, operation.body(request), request.reason);
  return { status: 'completed', action: request.action, result };
}
