import assert from 'node:assert/strict';
import { test } from 'node:test';
import { administerDiscord } from './discord-admin-service.mjs';

import { fixture, protectedId, channelId, request } from '../probes/fixtures/discord-admin.mjs';

test('protected channel cannot be deleted, even with a claimed approval', async () => {
  const dependencies = fixture();
  await assert.rejects(administerDiscord(request('channel.delete', { channelId: protectedId, approval: 'yes' }), dependencies), /protected/);
  assert.equal(dependencies.mutations.length, 0);
});

test('ordinary rename sends the audit reason without an approval', async () => {
  const dependencies = fixture();
  await administerDiscord(request('channel.edit', { channelId, payload: { name: 'renamed' } }), dependencies);
  assert.deepEqual(dependencies.mutations, [{ method: 'PATCH', path: `/channels/${channelId}`, body: { name: 'renamed' }, reason: 'Requested server maintenance' }]);
});
