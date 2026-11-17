import { isSnowflake } from './human-contract.mjs';

const integer = (minimum, maximum) => value => Number.isInteger(value) && value >= minimum && value <= maximum;
const string = maximum => value => typeof value === 'string' && value.length > 0 && value.length <= maximum;
const boolean = value => typeof value === 'boolean';
const snowflake = value => typeof value === 'string' && isSnowflake(value);
const permissions = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
const parent = value => value === null || snowflake(value);
const duration = value => [60, 1440, 4320, 10080].includes(value);
const channelType = value => [0, 2, 4, 5, 13, 15, 16].includes(value);
const threadType = value => [10, 11, 12].includes(value);
const timestamp = value => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));

function overwrites(value) {
  return Array.isArray(value) && value.every(item => item && Object.keys(item).every(key => ['id', 'type', 'allow', 'deny'].includes(key))
    && snowflake(item.id) && [0, 1].includes(item.type) && permissions(item.allow) && permissions(item.deny));
}

const channelFields = { name: string(100), topic: string(4096), parent_id: parent, position: integer(0, 10000),
  permission_overwrites: overwrites, nsfw: boolean, rate_limit_per_user: integer(0, 21600) };
const roleFields = { name: string(100), permissions, color: integer(0, 16777215), hoist: boolean, mentionable: boolean };
const guildPath = request => `/guilds/${request.guildId}`;
const channelPath = request => `/channels/${request.channelId}`;
const memberPath = request => `${guildPath(request)}/members/${request.userId}`;
const rolePath = request => `${guildPath(request)}/roles/${request.roleId}`;
const route = (method, path, permission, fields = {}, required = [], targets = []) => ({ method, path, permission, fields, required, targets });

export const ADMIN_OPERATIONS = {
  'channel.create': route('POST', request => `${guildPath(request)}/channels`, 'ManageChannels', { ...channelFields, type: channelType }, ['name', 'type']),
  'channel.edit': route('PATCH', channelPath, 'ManageChannels', channelFields, [], ['channelId']),
  'channel.delete': route('DELETE', channelPath, 'ManageChannels', {}, [], ['channelId']),
  'thread.create': route('POST', request => `${channelPath(request)}${request.messageId ? `/messages/${request.messageId}` : ''}/threads`, 'CreatePublicThreads',
    { name: string(100), type: threadType, auto_archive_duration: duration, invitable: boolean, rate_limit_per_user: integer(0, 21600) }, ['name'], ['channelId']),
  'thread.edit': route('PATCH', channelPath, 'ManageThreads', { name: string(100), archived: boolean, locked: boolean, auto_archive_duration: duration, rate_limit_per_user: integer(0, 21600) }, [], ['channelId']),
  'thread.delete': route('DELETE', channelPath, 'ManageThreads', {}, [], ['channelId']),
  'role.create': route('POST', request => `${guildPath(request)}/roles`, 'ManageRoles', roleFields, ['name']),
  'role.edit': route('PATCH', rolePath, 'ManageRoles', roleFields, [], ['roleId']),
  'role.position': route('PATCH', request => `${guildPath(request)}/roles`, 'ManageRoles', { position: integer(1, 10000) }, ['position'], ['roleId']),
  'role.delete': route('DELETE', rolePath, 'ManageRoles', {}, [], ['roleId']),
  'role.grant': route('PUT', request => `${memberPath(request)}/roles/${request.roleId}`, 'ManageRoles', {}, [], ['userId', 'roleId']),
  'role.revoke': route('DELETE', request => `${memberPath(request)}/roles/${request.roleId}`, 'ManageRoles', {}, [], ['userId', 'roleId']),
  'member.nickname': route('PATCH', memberPath, 'ManageNicknames', { nick: value => value === null || string(32)(value) }, ['nick'], ['userId']),
  'member.timeout': route('PATCH', memberPath, 'ModerateMembers', { communication_disabled_until: timestamp }, ['communication_disabled_until'], ['userId']),
  'member.kick': route('DELETE', memberPath, 'KickMembers', {}, [], ['userId']),
  'member.ban': route('PUT', request => `${guildPath(request)}/bans/${request.userId}`, 'BanMembers', { delete_message_seconds: integer(0, 604800) }, [], ['userId']),
  'member.unban': route('DELETE', request => `${guildPath(request)}/bans/${request.userId}`, 'BanMembers', {}, [], ['userId']),
  'invite.create': route('POST', request => `${channelPath(request)}/invites`, 'CreateInstantInvite', { max_age: integer(0, 604800), max_uses: integer(0, 100), temporary: boolean, unique: boolean }, [], ['channelId']),
  'invite.delete': route('DELETE', request => `/invites/${request.code}`, 'ManageChannels'),
};

const envelope = ['guildId', 'action', 'reason', 'payload', 'channelId', 'userId', 'roleId', 'messageId', 'code', 'approval'];

export function operationOf(input) {
  const operation = ADMIN_OPERATIONS[input?.action];
  if (!operation || !Object.hasOwn(ADMIN_OPERATIONS, input.action)) throw new Error('discord-admin: unsupported operation. Use the advertised actions.');
  if (!Object.keys(input).every(key => envelope.includes(key))) throw new Error('discord-admin: unknown request field.');
  if (!snowflake(input.guildId) || !string(400)(input.reason)) throw new Error('discord-admin: provide guildId and a non-empty audit reason of at most 400 characters.');
  for (const field of ['channelId', 'userId', 'roleId', 'messageId']) {
    if (input[field] !== undefined && !snowflake(input[field])) throw new Error(`discord-admin: invalid ${field}.`);
  }
  if (!operation.targets.every(field => snowflake(input[field]))) throw new Error('discord-admin: missing operation target.');
  if (input.action === 'invite.delete' && !/^[\w-]{2,100}$/.test(input.code ?? '')) throw new Error('discord-admin: invalid invite code.');
  const payload = input.payload ?? {};
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('discord-admin: payload must be an object.');
  if (!Object.entries(payload).every(([key, value]) => Object.hasOwn(operation.fields, key) && operation.fields[key](value))) throw new Error('discord-admin: unsupported payload field or invalid value.');
  if (!operation.required.every(key => Object.hasOwn(payload, key))) throw new Error('discord-admin: missing required payload field.');
  if (operation.method === 'PATCH' && !Object.keys(payload).length) throw new Error('discord-admin: edit payload must not be empty.');
  return { ...operation, request: { ...input, payload }, path: operation.path(input) };
}
