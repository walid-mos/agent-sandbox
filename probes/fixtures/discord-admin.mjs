export const guildId = '100000000000000001';
export const protectedId = '100000000000000002';
export const channelId = '100000000000000003';
export const parentId = '100000000000000004';
export const botId = '100000000000000005';
export const managedRoleId = '100000000000000006';
export const userId = '100000000000000007';
export const ownerId = '100000000000000008';
export const roleId = '100000000000000009';
export const threadId = '100000000000000010';

export function fixture() {
  const mutations = [];
  const channels = [
    { id: protectedId, guild_id: guildId, type: 0, parent_id: parentId },
    { id: channelId, guild_id: guildId, type: 0 },
    { id: parentId, guild_id: guildId, type: 4 },
    { id: threadId, guild_id: guildId, type: 11, parent_id: protectedId },
  ];
  const roles = [
    { id: guildId, permissions: '0', position: 0 },
    { id: managedRoleId, permissions: '1099511627775', position: 10, managed: true, tags: { bot_id: botId } },
    { id: roleId, permissions: '0', position: 1 },
  ];
  const reads = {
    '/users/@me': { id: botId },
    [`/guilds/${guildId}`]: { id: guildId, owner_id: ownerId },
    [`/guilds/${guildId}/channels`]: channels,
    [`/guilds/${guildId}/roles`]: roles,
    [`/guilds/${guildId}/members/${botId}`]: { user: { id: botId }, roles: [managedRoleId] },
  };
  const read = path => {
    if (Object.hasOwn(reads, path)) return reads[path];
    if (path.startsWith(`/guilds/${guildId}/members/`)) return { user: { id: userId }, roles: [roleId] };
    if (path.startsWith('/channels/')) return channels.find(channel => path === `/channels/${channel.id}`);
    throw new Error(`Unexpected fixture read ${path}`);
  };
  const api = async (method, path, body, reason) => {
    if (method === 'GET') return read(path);
    mutations.push({ method, path, body, reason });
    return { id: channelId };
  };
  return { api, mutations, channels, roles, protection: { guildId, channelIds: [protectedId], threadIds: [], botRoleIds: [managedRoleId] },
    approvals: { authorize: async () => ({ status: 'approval_required' }) } };
}

export const request = (action, fields = {}) => ({ guildId, action, reason: 'Requested server maintenance', ...fields });
