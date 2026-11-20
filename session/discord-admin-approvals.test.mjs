import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discordAdminApprovals, APPROVE, DECLINE } from './discord-admin-approvals.mjs';
import { acceptDiscordClick } from './discord-clicks.mjs';
import { humanStore } from './human-store.mjs';
import { administerDiscord } from './discord-admin-service.mjs';
import { fixture, guildId, channelId, botId, ownerId, userId, request } from '../probes/fixtures/discord-admin.mjs';

const messageId = '100000000000000020';

async function setup(t, input = request('channel.delete', { channelId }), before = () => {}) {
  const folder = mkdtempSync(join(tmpdir(), 'discord-admin-approval-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const clicks = humanStore(join(folder, 'clicks'));
  const pending = humanStore(join(folder, 'pending'));
  const approvals = discordAdminApprovals({ clicks, pending, channelAccount: 'discord', guildId, api: (...arguments_) => dependencies.api(...arguments_) });
  const dependencies = { ...fixture(), approvals };
  dependencies.channels.find(channel => channel.id === channelId).permission_overwrites = [{ id: guildId, type: 0, allow: '1024', deny: '0' }];
  before(dependencies);
  const prepared = await administerDiscord(input, dependencies);
  const id = prepared.approval;
  const buttons = [APPROVE, DECLINE].map((label, index) => ({ type: 2, style: index === 0 ? 1 : 2, label, custom_id: `human:${id}:0:${index}` }));
  const registration = { dialog: id, messages: [{ channelId, messageId, components: [{ type: 1, components: buttons }] }] };
  const display = { id: messageId, channel_id: channelId, author: { id: botId }, content: `Server administration approval\n\`\`\`json\n${prepared.question.scope}\n\`\`\`\n${prepared.question.questions[0].prompt}`,
    components: [{ type: 1, components: buttons.map(button => ({ ...button, disabled: true })) }], embeds: [], attachments: [] };
  const api = dependencies.api;
  dependencies.api = (method, path, ...arguments_) => method === 'GET' && path === `/channels/${channelId}/messages/${messageId}` ? display : api(method, path, ...arguments_);
  const click = (index = 0, overrides = {}, at) => acceptDiscordClick({ raw: JSON.stringify({ type: 3, guild_id: guildId, channel_id: channelId,
    message: { ...display, components: registration.messages[0].components }, member: { user: { id: ownerId } }, data: { custom_id: `human:${id}:0:${index}` }, ...overrides }) }, { store: clicks, channelAccount: 'discord', at });
  return { approvals, pending, clicks, dependencies, input: { ...input, approval: id }, prepared, registration, display, click };
}

for (const content of [undefined, 'Discord Admin asks', 'Rename a harmless channel?', 'Approve a routine health check']) {
  test(`registration refuses absent, truncated or misleading operation text: ${content}`, async t => {
    const proof = await setup(t);
    proof.display.content = content;
    await assert.rejects(proof.approvals.register(proof.registration), /display|scope|content/);
    assert.equal(proof.dependencies.mutations.length, 0);
  });
}

test('a message edited after registration cannot authorize the saved operation', async t => {
  const proof = await setup(t);
  await proof.approvals.register(proof.registration);
  await assert.rejects(proof.click(0, { message: { ...proof.display, content: 'Approve a health check', components: proof.registration.messages[0].components } }), /display|scope|content/);
  assert.equal((await administerDiscord(proof.input, proof.dependencies)).status, 'approval_pending');
  assert.equal(proof.dependencies.mutations.length, 0);
});

test('registration refuses a non-bot author and changed controls', async t => {
  const proof = await setup(t);
  proof.display.author.id = userId;
  await assert.rejects(proof.approvals.register(proof.registration), /display/);
  proof.display.author.id = botId;
  proof.display.components[0].components[0].label = 'Do something else';
  await assert.rejects(proof.approvals.register(proof.registration), /display/);
  assert.equal(proof.dependencies.mutations.length, 0);
});

test('a webhook voice copy of the canonical message cannot serve as the approval display', async t => {
  const proof = await setup(t);
  const webhookId = '100000000000000030';
  Object.assign(proof.display, { author: { id: webhookId, bot: true }, webhook_id: webhookId });
  await assert.rejects(proof.approvals.register(proof.registration), /display/);
  assert.equal((await proof.click()).status, 'unhandled');
  assert.equal(proof.dependencies.mutations.length, 0);
});

test('an operation whose full scope cannot fit one message gets no approval', async t => {
  const proof = await setup(t);
  const oversized = request('channel.delete', { channelId, reason: '`'.repeat(400) });
  await assert.rejects(administerDiscord(oversized, proof.dependencies), /too long/);
  assert.deepEqual(proof.pending.all().map(record => record.id), [proof.input.approval]);
  assert.equal(proof.dependencies.mutations.length, 0);
});

test('a scope larger than the old cap still gets approval while its message fits', async t => {
  const topic = 'x'.repeat(1500);
  const everyone = { id: guildId, type: 0, allow: '1024', deny: '0' };
  const proof = await setup(t, request('channel.edit', { channelId, payload: { topic, permission_overwrites: [everyone] } }), dependencies => {
    dependencies.channels.find(channel => channel.id === channelId).type = 15;
  });
  assert.equal(proof.prepared.status, 'approval_required');
  assert.equal(proof.prepared.question.scope.length > 1400, true);
  assert.equal(proof.prepared.message.content.length <= 2000, true);
});

test('a click inside the approval window decides it even after the window closes', async t => {
  const proof = await setup(t);
  await proof.approvals.register(proof.registration);
  assert.equal((await proof.click(0, {}, new Date(Date.now() - 60_000).toISOString())).status, 'accepted');
  await proof.pending.patch(proof.input.approval, { expiresAt: Date.now() - 30_000 });
  assert.equal((await administerDiscord(proof.input, proof.dependencies)).status, 'completed');
  assert.equal(proof.dependencies.mutations.length, 1);
});

test('a click made after the approval window expired authorizes nothing', async t => {
  const proof = await setup(t);
  await proof.approvals.register(proof.registration);
  assert.equal((await proof.click()).status, 'accepted');
  await proof.pending.patch(proof.input.approval, { expiresAt: Date.now() - 30_000 });
  await assert.rejects(administerDiscord(proof.input, proof.dependencies), /expired/);
  assert.equal(proof.dependencies.mutations.length, 0);
});

test('a text-only click without its canonical message snapshot claims nothing', async t => {
  const proof = await setup(t);
  await proof.approvals.register(proof.registration);
  await assert.rejects(proof.click(0, { message: { id: messageId } }), /display|registered/);
  assert.equal((await administerDiscord(proof.input, proof.dependencies)).status, 'approval_pending');
  assert.equal(proof.dependencies.mutations.length, 0);
});

test('only a registered owner click authorizes the exact operation once', async t => {
  const proof = await setup(t);
  assert.equal(proof.prepared.status, 'approval_required');
  assert.equal(proof.dependencies.mutations.length, 0);
  assert.equal((await proof.click()).status, 'unhandled');
  await proof.approvals.register(proof.registration);
  assert.equal((await administerDiscord(proof.input, proof.dependencies)).status, 'approval_pending');
  await assert.rejects(proof.click(0, { member: { user: { id: userId } } }), /owner/);
  await assert.rejects(proof.click(0, { message: { id: '100000000000000021' } }), /registered/);
  assert.equal((await proof.click()).status, 'accepted');
  assert.equal((await proof.click()).status, 'stale');
  assert.equal((await administerDiscord(proof.input, proof.dependencies)).status, 'completed');
  await assert.rejects(administerDiscord(proof.input, proof.dependencies), /already used/);
  assert.deepEqual(proof.dependencies.mutations, [{ method: 'DELETE', path: `/channels/${channelId}`, body: undefined, reason: 'Requested server maintenance' }]);
  assert.equal(proof.clicks.get(proof.input.approval).closed.status, 'answered');
});

test('changed action, resource, reason or payload cannot reuse a clicked approval', async t => {
  const proof = await setup(t);
  await proof.approvals.register(proof.registration);
  await proof.click();
  for (const changes of [{ reason: 'different' }, { action: 'member.ban', userId }, { payload: { hidden: true } }, { channelId: '100000000000000021' }, { guildId: '200000000000000001' }]) {
    await assert.rejects(proof.approvals.authorize({ ...proof.input, ...changes }, { ownerId }), /another/);
  }
  assert.equal(proof.dependencies.mutations.length, 0);
  assert.equal((await administerDiscord(proof.input, proof.dependencies)).status, 'completed');
});

test('cancelled approval never mutates Discord', async t => {
  const proof = await setup(t);
  await proof.approvals.register(proof.registration);
  await proof.click(1);
  assert.equal((await administerDiscord(proof.input, proof.dependencies)).status, 'declined');
  assert.equal(proof.dependencies.mutations.length, 0);
  await assert.rejects(administerDiscord(proof.input, proof.dependencies), /already used/);
});

test('concurrent approval consumers can issue only one mutation', async t => {
  const proof = await setup(t);
  await proof.approvals.register(proof.registration);
  await proof.click();
  const results = await Promise.allSettled([administerDiscord(proof.input, proof.dependencies), administerDiscord(proof.input, proof.dependencies)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(proof.dependencies.mutations.length, 1);
});

test('unknown, expired and unregistered prose approvals are refused', async t => {
  const proof = await setup(t);
  await assert.rejects(proof.approvals.authorize({ ...proof.input, approval: 'yes' }, { ownerId }), /dialog ID/);
  await assert.rejects(proof.approvals.authorize({ ...proof.input, approval: 'f'.repeat(32) }, { ownerId }), /expired or already used/);
  const id = proof.input.approval;
  await proof.pending.patch(id, { expiresAt: 0 });
  await assert.rejects(administerDiscord(proof.input, proof.dependencies), /expired/);
  assert.equal(proof.dependencies.mutations.length, 0);
});

test('consumed approvals cannot replay after the current state no longer requires approval', async t => {
  const proof = await setup(t, request('channel.edit', { channelId, payload: { permission_overwrites: [] } }));
  await proof.approvals.register(proof.registration);
  await proof.click();
  const api = proof.dependencies.api;
  proof.dependencies.api = (method, path, body, reason) => {
    if (method === 'PATCH') proof.dependencies.channels.find(channel => channel.id === channelId).permission_overwrites = body.permission_overwrites;
    return api(method, path, body, reason);
  };
  assert.equal((await administerDiscord(proof.approvals.approvedRequest(proof.input.approval), proof.dependencies)).status, 'completed');
  await assert.rejects(administerDiscord(proof.approvals.approvedRequest(proof.input.approval), proof.dependencies), /already used/);
  assert.equal(proof.dependencies.mutations.length, 1);
});

test('failed mutation consumes approval and cannot be retried with it', async t => {
  const proof = await setup(t);
  await proof.approvals.register(proof.registration);
  await proof.click();
  const api = proof.dependencies.api;
  proof.dependencies.api = (method, ...arguments_) => {
    if (method !== 'GET') throw new Error('Unknown mutation outcome');
    return api(method, ...arguments_);
  };
  await assert.rejects(administerDiscord(proof.input, proof.dependencies), /Unknown mutation/);
  await assert.rejects(administerDiscord(proof.input, proof.dependencies), /already used/);
});
