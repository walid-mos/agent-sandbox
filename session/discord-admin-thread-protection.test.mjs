import assert from 'node:assert/strict';
import { test } from 'node:test';
import { administerDiscord } from './discord-admin-service.mjs';
import { fixture, channelId, parentId, guildId, request } from '../probes/fixtures/discord-admin.mjs';

const trackedId = '100000000000000050';
const discordError = (status, discordCode) => Object.assign(new Error(`discord-admin: Discord HTTP ${status}, code ${discordCode}.`), { discordCode });

function trackedLookupFails(dependencies, error) {
  dependencies.protection.threadIds = [trackedId];
  const api = dependencies.api;
  dependencies.api = async (method, path, ...arguments_) => {
    if (method === 'GET' && path === `/channels/${trackedId}`) throw error;
    return api(method, path, ...arguments_);
  };
}

test('moving the parent of a tracked archived thread is refused even when guild channel listing omits threads', async () => {
  const dependencies = fixture();
  dependencies.protection.threadIds = [trackedId];
  const api = dependencies.api;
  dependencies.api = (method, path, ...arguments_) => method === 'GET' && path === `/channels/${trackedId}`
    ? { id: trackedId, guild_id: guildId, type: 11, parent_id: channelId } : api(method, path, ...arguments_);
  await assert.rejects(administerDiscord(request('channel.edit', { channelId, payload: { parent_id: parentId } }), dependencies), /protected/);
  assert.equal(dependencies.mutations.length, 0);
});

test('a tracked thread Discord reports as deleted does not block other administration', async () => {
  const dependencies = fixture();
  trackedLookupFails(dependencies, discordError(404, 10003));
  assert.equal((await administerDiscord(request('channel.edit', { channelId, payload: { name: 'renamed' } }), dependencies)).status, 'completed');
  assert.equal(dependencies.mutations.length, 1);
});

test('a tracked thread Discord refuses to show still blocks administration', async () => {
  const dependencies = fixture();
  trackedLookupFails(dependencies, discordError(403, 50001));
  await assert.rejects(administerDiscord(request('channel.edit', { channelId, payload: { name: 'renamed' } }), dependencies), /HTTP 403/);
  assert.equal(dependencies.mutations.length, 0);
});
