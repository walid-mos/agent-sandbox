import assert from 'node:assert/strict';
import { test } from 'node:test';
import { administerDiscord } from './discord-admin-service.mjs';
import { fixture, guildId, channelId, parentId, roleId, userId, ownerId, request } from '../probes/fixtures/discord-admin.mjs';

const ordinary = [
  ['channel.create', { payload: { name: 'category', type: 4 } }, 'POST', `/guilds/${guildId}/channels`],
  ['channel.create', { payload: { name: 'channel', type: 0, parent_id: parentId } }, 'POST', `/guilds/${guildId}/channels`],
  ['channel.edit', { channelId, payload: { name: 'renamed', parent_id: parentId } }, 'PATCH', `/channels/${channelId}`],
  ['thread.create', { channelId, payload: { name: 'topic', type: 11 } }, 'POST', `/channels/${channelId}/threads`],
  ['thread.create', { channelId, messageId: '100000000000000030', payload: { name: 'topic' } }, 'POST', `/channels/${channelId}/messages/100000000000000030/threads`],
  ['role.create', { payload: { name: 'member', permissions: '1024' } }, 'POST', `/guilds/${guildId}/roles`],
  ['role.edit', { roleId, payload: { name: 'renamed' } }, 'PATCH', `/guilds/${guildId}/roles/${roleId}`],
  ['role.position', { roleId, payload: { position: 2 } }, 'PATCH', `/guilds/${guildId}/roles`],
  ['role.grant', { roleId, userId }, 'PUT', `/guilds/${guildId}/members/${userId}/roles/${roleId}`],
  ['role.revoke', { roleId, userId }, 'DELETE', `/guilds/${guildId}/members/${userId}/roles/${roleId}`],
  ['member.nickname', { userId, payload: { nick: 'New name' } }, 'PATCH', `/guilds/${guildId}/members/${userId}`],
  ['member.timeout', { userId, payload: { communication_disabled_until: null } }, 'PATCH', `/guilds/${guildId}/members/${userId}`],
  ['member.unban', { userId }, 'DELETE', `/guilds/${guildId}/bans/${userId}`],
  ['invite.create', { channelId, payload: { max_age: 3600, max_uses: 1 } }, 'POST', `/channels/${channelId}/invites`],
];
for (const [action, fields, method, path] of ordinary) {
  test(`${action} uses its fixed Discord route and audit reason`, async () => {
    const dependencies = fixture();
    dependencies.approvals.authorize = () => { throw new Error('Ordinary operation must not ask approval'); };
    const result = await administerDiscord(request(action, fields), dependencies);
    assert.equal(result.status, 'completed');
    const body = action === 'role.position' ? [{ id: roleId, position: 2 }] : fields.payload;
    assert.deepEqual(dependencies.mutations, [{ method, path, body, reason: 'Requested server maintenance' }]);
  });
}

for (const action of ['thread.edit', 'thread.delete']) {
  test(`${action} operates on an ordinary thread with its real parent`, async () => {
    const dependencies = fixture();
    const thread = { id: '100000000000000031', guild_id: guildId, type: 11, parent_id: channelId };
    dependencies.channels.push(thread);
    const payload = action === 'thread.edit' ? { archived: true, locked: true } : undefined;
    dependencies.approvals.authorize = async () => ({ status: 'authorized' });
    await administerDiscord(request(action, { channelId: thread.id, ...(payload && { payload }) }), dependencies);
    assert.deepEqual(dependencies.mutations, [{ method: action === 'thread.edit' ? 'PATCH' : 'DELETE', path: `/channels/${thread.id}`, body: payload, reason: 'Requested server maintenance' }]);
  });
}

const irreversible = [
  ['channel.delete', { channelId }], ['role.delete', { roleId }], ['member.kick', { userId }], ['member.ban', { userId }],
  ['role.revoke', { roleId, userId: ownerId }], ['role.edit', { roleId: guildId, payload: { permissions: '1024' } }],
];
for (const [action, fields] of irreversible) {
  test(`${action} refuses mutation until approval and supplies the current guild owner`, async () => {
    const dependencies = fixture();
    dependencies.approvals.authorize = async (operation, identity) => {
      assert.equal(operation.action, action);
      assert.deepEqual(identity, { ownerId });
      return { status: 'approval_required' };
    };
    assert.equal((await administerDiscord(request(action, fields), dependencies)).status, 'approval_required');
    assert.equal(dependencies.mutations.length, 0);
  });
}

test('invite deletion resolves the invite channel before protection checks', async () => {
  const dependencies = fixture();
  const api = dependencies.api;
  dependencies.api = (method, path, ...arguments_) => method === 'GET' && path === '/invites/proof'
    ? { guild: { id: guildId }, channel: { id: channelId } } : api(method, path, ...arguments_);
  await administerDiscord(request('invite.delete', { code: 'proof' }), dependencies);
  assert.deepEqual(dependencies.mutations, [{ method: 'DELETE', path: '/invites/proof', body: undefined, reason: 'Requested server maintenance' }]);
});
