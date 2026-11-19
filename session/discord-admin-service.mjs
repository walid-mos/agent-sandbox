import { isThread, operationOf } from './discord-admin-operations.mjs';
import { guardChannels, guardRoles, requirePermission, requiresApproval } from './discord-admin-policy.mjs';
import { isApplicationRole, protectedIds, requireProtection, withThreadParents } from './discord-admin-protection.mjs';
import { serverLogEvent, SERVER_LOG_EVENT } from './server-log-events.mjs';

async function guildChannel(id, guildId, api) {
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

async function protectedChannels(channels, protection, api) {
  const ids = [...new Set(protectedIds(protection))];
  const missing = ids.filter(id => !channels.some(channel => channel.id === id));
  const resolved = await Promise.all(missing.map(id => trackedChannel(id, protection.guildId, api)));
  const tracked = [...channels, ...resolved.filter(Boolean)];
  return { channels: tracked, protection: withThreadParents(protection, tracked) };
}

async function snapshotOf(request, operation, { api, protection }) {
  requireProtection(protection, request.guildId);
  const [bot, guild, roles, channels, channel, parent, targetMember] = await Promise.all([api('GET', '/users/@me'), api('GET', `/guilds/${request.guildId}`),
    api('GET', `/guilds/${request.guildId}/roles`), api('GET', `/guilds/${request.guildId}/channels`), optionalChannel(request.channelId, request.guildId, api),
    optionalChannel(request.payload.parent_id, request.guildId, api), memberOf(request, operation, api)]);
  requireApplicationRole(request, { guild, roles, bot, protection });
  const [botMember, owned, threadParent] = await Promise.all([api('GET', `/guilds/${request.guildId}/members/${bot.id}`),
    protectedChannels(channels, protection, api), parentOfThread(channel, guild.id, api)]);
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

async function confirmedTopicChange(request, previous, result, { api, serverLogClock }) {
  if (!serverLogClock || request.action !== 'channel.edit' || !Object.hasOwn(request.payload, 'topic')) return;
  const topic = request.payload.topic;
  if (previous?.id !== request.channelId || !Object.hasOwn(previous, 'topic') || previous.topic === topic) return;
  if (result?.id !== request.channelId || result.topic !== topic) return;
  try {
    const current = await guildChannel(request.channelId, request.guildId, api);
    if (current.id === request.channelId && current.topic === topic) return serverLogEvent(SERVER_LOG_EVENT.adminTopicChanged, serverLogClock());
  } catch {
    // A readback failure cannot turn a completed mutation into a retryable error.
  }
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
  const notice = await confirmedTopicChange(request, snapshot.channel, result, dependencies);
  return { status: 'completed', action: request.action, result, ...(notice && { serverLogEvent: notice }) };
}
