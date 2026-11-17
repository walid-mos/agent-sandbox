import assert from 'node:assert/strict';
import { test } from 'node:test';
import { administerDiscord } from './discord-admin-service.mjs';
import { fixture, guildId, protectedId, channelId, parentId, managedRoleId, botId, roleId, threadId, request } from '../probes/fixtures/discord-admin.mjs';

const attacks = [
  ['category containing a pot channel', 'channel.edit', { channelId: parentId, payload: { position: 4 } }],
  ['protected thread parent', 'thread.delete', { channelId: threadId }],
  ['new thread under pot channel', 'thread.create', { channelId: protectedId, payload: { name: 'new', type: 11 } }],
  ['move into protected channel', 'channel.edit', { channelId, payload: { parent_id: protectedId } }],
  ['managed role edit', 'role.edit', { roleId: managedRoleId, payload: { name: 'other' } }],
  ['role move across managed role', 'role.position', { roleId, payload: { position: 10 } }],
  ['change bot nickname', 'member.nickname', { userId: botId, payload: { nick: 'other' } }],
  ['managed role overwrite', 'channel.edit', { channelId, payload: { permission_overwrites: [{ id: managedRoleId, type: 0, allow: '0', deny: '16' }] } }],
  ['bot user overwrite', 'channel.edit', { channelId, payload: { permission_overwrites: [{ id: botId, type: 1, allow: '0', deny: '16' }] } }],
];
for (const [name, action, fields] of attacks) {
  test(`refuses indirect protected resource change: ${name}`, async () => {
    const dependencies = fixture();
    await assert.rejects(administerDiscord(request(action, fields), dependencies));
    assert.equal(dependencies.mutations.length, 0);
  });
}

test('removing an existing everyone overwrite requires approval', async () => {
  const dependencies = fixture();
  dependencies.channels.find(channel => channel.id === channelId).permission_overwrites = [{ id: guildId, type: 0, allow: '1024', deny: '0' }];
  const result = await administerDiscord(request('channel.edit', { channelId, payload: { permission_overwrites: [] } }), dependencies);
  assert.equal(result.status, 'approval_required');
  assert.equal(dependencies.mutations.length, 0);
});

test('thread creation refuses unsupported forum parents before REST mutation', async () => {
  const dependencies = fixture();
  dependencies.channels.find(channel => channel.id === channelId).type = 15;
  await assert.rejects(administerDiscord(request('thread.create', { channelId, payload: { name: 'topic', type: 11 } }), dependencies), /parent/);
  assert.equal(dependencies.mutations.length, 0);
});

test('thread creation without a message requires explicit thread type', async () => {
  const dependencies = fixture();
  await assert.rejects(administerDiscord(request('thread.create', { channelId, payload: { name: 'topic' } }), dependencies), /type/);
  assert.equal(dependencies.mutations.length, 0);
});

test('missing protection metadata fails closed before any mutation', async () => {
  const dependencies = { ...fixture(), protection: undefined };
  await assert.rejects(administerDiscord(request('channel.edit', { channelId, payload: { name: 'new' } }), dependencies), /metadata/);
  assert.equal(dependencies.mutations.length, 0);
});

test('foreign guild channels cannot be mutated', async () => {
  const dependencies = fixture();
  dependencies.channels.find(channel => channel.id === channelId).guild_id = '200000000000000001';
  await assert.rejects(administerDiscord(request('channel.edit', { channelId, payload: { name: 'new' } }), dependencies), /guild/);
  assert.equal(dependencies.mutations.length, 0);
});

test('missing application permission reports its name without using broader credentials', async () => {
  const dependencies = fixture();
  dependencies.roles.find(role => role.id === managedRoleId).permissions = '0';
  await assert.rejects(administerDiscord(request('channel.edit', { channelId, payload: { name: 'new' } }), dependencies), /missing ManageChannels/);
  assert.equal(dependencies.mutations.length, 0);
});

test('arbitrary routes and hidden payload fields never reach Discord', async () => {
  const dependencies = fixture();
  for (const input of [request('webhook.delete'), request('channel.edit', { channelId, payload: { name: 'new', webhook_id: managedRoleId } }), request('channel.delete', { channelId, path: '/webhooks/anything' })]) {
    await assert.rejects(administerDiscord(input, dependencies), /unsupported|unknown/);
  }
  assert.equal(dependencies.mutations.length, 0);
});
