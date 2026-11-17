import { isSnowflake } from './human-contract.mjs';

export const DISCORD_PERMISSIONS = {
  CreateInstantInvite: 1n, KickMembers: 2n, BanMembers: 4n, Administrator: 8n, ManageChannels: 16n,
  ViewChannel: 1024n, ManageRoles: 268435456n, ManageNicknames: 134217728n,
  ManageThreads: 17179869184n, CreatePublicThreads: 34359738368n, CreatePrivateThreads: 68719476736n, ModerateMembers: 1099511627776n,
};
export const CHANNEL = { text: 0, voice: 2, category: 4, announcement: 5, announcementThread: 10, publicThread: 11, privateThread: 12, stage: 13, forum: 15, media: 16 };
export const OVERWRITE = { role: 0, member: 1 };
export const CHANNEL_TOPIC_LIMIT = 1024;
export const FORUM_TOPIC_LIMIT = 4096;
export const STANDALONE_THREAD_TYPES = [CHANNEL.publicThread, CHANNEL.privateThread];
export const isThread = channel => [CHANNEL.announcementThread, ...STANDALONE_THREAD_TYPES].includes(channel.type);

const integer = (minimum, maximum) => value => Number.isInteger(value) && value >= minimum && value <= maximum;
const string = maximum => value => typeof value === 'string' && value.length > 0 && value.length <= maximum;
const boolean = value => typeof value === 'boolean';
export const snowflake = value => typeof value === 'string' && isSnowflake(value);
const permissions = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
const parent = value => value === null || snowflake(value);
const duration = value => [60, 1440, 4320, 10080].includes(value);
const channelType = value => [CHANNEL.text, CHANNEL.voice, CHANNEL.category, CHANNEL.announcement, CHANNEL.stage, CHANNEL.forum, CHANNEL.media].includes(value);
const threadType = value => STANDALONE_THREAD_TYPES.includes(value);
const timestamp = value => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));

function overwriteOf(item) {
  if (!item || typeof item !== 'object') return false;
  return [Object.keys(item).every(key => ['id', 'type', 'allow', 'deny'].includes(key)),
    snowflake(item.id), Object.values(OVERWRITE).includes(item.type), permissions(item.allow), permissions(item.deny)].every(Boolean);
}

const overwrites = value => Array.isArray(value) && value.every(overwriteOf);

const channelFields = { name: string(100), topic: value => value === null || (typeof value === 'string' && value.length <= FORUM_TOPIC_LIMIT), parent_id: parent, position: integer(0, 10000),
  permission_overwrites: overwrites, nsfw: boolean, rate_limit_per_user: integer(0, 21600) };
const roleFields = { name: string(100), permissions, color: integer(0, 16777215), hoist: boolean, mentionable: boolean };
const guildPath = request => `/guilds/${request.guildId}`;
const channelPath = request => `/channels/${request.channelId}`;
const memberPath = request => `${guildPath(request)}/members/${request.userId}`;
const rolePath = request => `${guildPath(request)}/roles/${request.roleId}`;
const payloadBody = request => Object.keys(request.payload).length ? request.payload : undefined;
const route = (method, path, permission, { fields = {}, required = [], targets = [], optionalTargets = [], body = payloadBody, approval = false, loadsMember = false } = {}) =>
  ({ method, path, permission, fields, required, targets, optionalTargets, body, approval, loadsMember });

export const ADMIN_OPERATIONS = {
  'channel.create': route('POST', request => `${guildPath(request)}/channels`, 'ManageChannels', { fields: { ...channelFields, type: channelType }, required: ['name', 'type'] }),
  'channel.edit': route('PATCH', channelPath, 'ManageChannels', { fields: channelFields, targets: ['channelId'] }),
  'channel.delete': route('DELETE', channelPath, 'ManageChannels', { targets: ['channelId'], approval: true }),
  'thread.create': route('POST', request => `${channelPath(request)}${request.messageId ? `/messages/${request.messageId}` : ''}/threads`, 'CreatePublicThreads', {
    fields: { name: string(100), type: threadType, auto_archive_duration: duration, invitable: boolean, rate_limit_per_user: integer(0, 21600) },
    required: ['name'], targets: ['channelId'], optionalTargets: ['messageId'] }),
  'thread.edit': route('PATCH', channelPath, 'ManageThreads', {
    fields: { name: string(100), archived: boolean, locked: boolean, auto_archive_duration: duration, rate_limit_per_user: integer(0, 21600) }, targets: ['channelId'] }),
  'thread.delete': route('DELETE', channelPath, 'ManageThreads', { targets: ['channelId'], approval: true }),
  'role.create': route('POST', request => `${guildPath(request)}/roles`, 'ManageRoles', { fields: roleFields, required: ['name'] }),
  'role.edit': route('PATCH', rolePath, 'ManageRoles', { fields: roleFields, targets: ['roleId'] }),
  'role.position': route('PATCH', request => `${guildPath(request)}/roles`, 'ManageRoles', { fields: { position: integer(1, 10000) }, required: ['position'], targets: ['roleId'],
    body: request => [{ id: request.roleId, position: request.payload.position }] }),
  'role.delete': route('DELETE', rolePath, 'ManageRoles', { targets: ['roleId'], approval: true }),
  'role.grant': route('PUT', request => `${memberPath(request)}/roles/${request.roleId}`, 'ManageRoles', { targets: ['userId', 'roleId'] }),
  'role.revoke': route('DELETE', request => `${memberPath(request)}/roles/${request.roleId}`, 'ManageRoles', { targets: ['userId', 'roleId'] }),
  'member.nickname': route('PATCH', memberPath, 'ManageNicknames', { fields: { nick: value => value === null || string(32)(value) }, required: ['nick'], targets: ['userId'], loadsMember: true }),
  'member.timeout': route('PATCH', memberPath, 'ModerateMembers', { fields: { communication_disabled_until: timestamp }, required: ['communication_disabled_until'], targets: ['userId'], loadsMember: true }),
  'member.kick': route('DELETE', memberPath, 'KickMembers', { targets: ['userId'], approval: true, loadsMember: true }),
  'member.ban': route('PUT', request => `${guildPath(request)}/bans/${request.userId}`, 'BanMembers', { fields: { delete_message_seconds: integer(0, 604800) }, targets: ['userId'], approval: true }),
  'member.unban': route('DELETE', request => `${guildPath(request)}/bans/${request.userId}`, 'BanMembers', { targets: ['userId'] }),
  'invite.create': route('POST', request => `${channelPath(request)}/invites`, 'CreateInstantInvite', {
    fields: { max_age: integer(0, 604800), max_uses: integer(0, 100), temporary: boolean, unique: boolean }, targets: ['channelId'] }),
  'invite.delete': route('DELETE', request => `/invites/${request.code}`, 'ManageChannels', { targets: ['code'] }),
};

export const ADMIN_REQUEST_FIELDS = ['guildId', 'action', 'reason', 'payload', 'channelId', 'userId', 'roleId', 'messageId', 'code', 'approval'];

function selectedOperation(action) {
  if (!Object.hasOwn(ADMIN_OPERATIONS, action)) throw new Error('discord-admin: unsupported operation. Use the advertised actions.');
  return ADMIN_OPERATIONS[action];
}

function requireEnvelope(input) {
  if (!Object.keys(input).every(key => ADMIN_REQUEST_FIELDS.includes(key))) throw new Error('discord-admin: unknown request field.');
  if (!snowflake(input.guildId) || !string(400)(input.reason)) throw new Error('discord-admin: provide guildId and a non-empty audit reason of at most 400 characters.');
}

function requireTargetIds(input, operation) {
  for (const field of ['channelId', 'userId', 'roleId', 'messageId']) requireSnowflakeField(input, field);
  if (!operation.targets.every(field => targetValidator(field)(input[field]))) throw new Error('discord-admin: missing or invalid operation target.');
}

function requireSnowflakeField(input, field) {
  if (input[field] !== undefined && !snowflake(input[field])) throw new Error(`discord-admin: invalid ${field}.`);
}

const TARGET_VALIDATORS = { code: code => typeof code === 'string' && /^[\w-]{2,100}$/.test(code) };
const targetValidator = field => TARGET_VALIDATORS[field] ?? snowflake;

function requirePayloadObject(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('discord-admin: payload must be an object.');
}

function requirePayloadFields(payload, operation) {
  if (!Object.entries(payload).every(([key, value]) => Object.hasOwn(operation.fields, key) && operation.fields[key](value))) throw new Error('discord-admin: unsupported payload field or invalid value.');
  if (!operation.required.every(key => Object.hasOwn(payload, key))) throw new Error('discord-admin: missing required payload field.');
  requireEditPayload(payload, operation);
}

function requireEditPayload(payload, operation) {
  if (operation.method === 'PATCH' && !Object.keys(payload).length) throw new Error('discord-admin: edit payload must not be empty.');
}

export function operationOf(input) {
  const operation = selectedOperation(input?.action);
  requireEnvelope(input);
  requireTargetIds(input, operation);
  const payload = input.payload ?? {};
  requirePayloadObject(payload);
  requirePayloadFields(payload, operation);
  return { ...operation, request: { ...input, payload }, path: operation.path(input) };
}
