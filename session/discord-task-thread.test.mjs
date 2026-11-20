import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskThreadTarget } from './discord-task-thread.mjs';

const taskId = 'task-37';
const guildId = '100000000000000001';
const channelId = '100000000000000002';
const starterMessageId = '100000000000000003';
const canonicalThreadId = '100000000000000004';
const followUpMessageId = '100000000000000005';
const admitted = { guildId, channelId, starterMessageId };
const registry = task => new Map([[taskId, task]]);

test('chat, decision receipts and route request IDs cannot supply a task by themselves', () => {
  const tasks = registry(admitted);
  for (const input of [undefined, starterMessageId, 'decision-1', 'mastermind.37c46cf293b8f42d', { id: taskId }]) {
    assert.equal(taskThreadTarget(input, tasks), undefined);
  }
});

test('admission without a saved canonical thread or starter gives no creation target', () => {
  assert.equal(taskThreadTarget(taskId, registry({ guildId, channelId })), undefined);
});

test('a saved starter gives the same creation target across reloaded retries', () => {
  const target = { action: 'ensure-from-starter', guildId, channelId, threadId: starterMessageId };
  assert.deepEqual(taskThreadTarget(taskId, registry(admitted)), target);
  assert.deepEqual(taskThreadTarget(taskId, registry(JSON.parse(JSON.stringify(admitted)))), target);
});

test('a saved canonical thread wins on follow-ups and work routed to other pots', () => {
  const tasks = registry({ guildId, channelId, threadId: canonicalThreadId });
  const notifications = [
    { taskId, pot: 'nextnode', request: 'mastermind.37c46cf293b8f42d', messageId: starterMessageId },
    { taskId, pot: 'personal', request: 'mastermind.77c46cf293b8f42d', messageId: followUpMessageId },
  ];
  for (const notification of notifications) {
    assert.deepEqual(taskThreadTarget(notification.taskId, tasks), { action: 'reuse', guildId, channelId, threadId: canonicalThreadId });
  }
});

test('a malformed saved canonical thread cannot fall through to the creation target', () => {
  assert.throws(() => taskThreadTarget(taskId, registry({ ...admitted, threadId: 42 })), /canonical thread ID/);
});

test('malformed Discord coordinates cannot reach the runtime', () => {
  assert.throws(() => taskThreadTarget(taskId, registry({ ...admitted, channelId: 'decisions' })), /guild and parent channel IDs/);
  assert.throws(() => taskThreadTarget(taskId, registry({ ...admitted, starterMessageId: 42 })), /starter message ID/);
});
