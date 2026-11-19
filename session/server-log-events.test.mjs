import assert from 'node:assert/strict';
import test from 'node:test';
import { channelId, fixture, request } from '../probes/fixtures/discord-admin.mjs';
import { administerDiscord } from './discord-admin-service.mjs';
import { renderServerLog, serverLogEvent, SERVER_LOG_EVENT } from './server-log-events.mjs';

const at = '2026-01-01T12:00:00.000Z';
const clock = () => new Date(at);
const privateText = 'fixture @everyone internal topic and reason';

function topicOperation({ previous = 'previous topic', readback, isEnabled = true, isReadbackUnavailable = false, isMutationUnconfirmed = false } = {}) {
  const dependencies = fixture();
  const channel = dependencies.channels.find(item => item.id === channelId);
  channel.topic = previous;
  const api = dependencies.api;
  dependencies.api = async (method, path, ...arguments_) => {
    if (method === 'PATCH') {
      if (isMutationUnconfirmed) throw new Error('fixture PATCH unconfirmed');
      await api(method, path, ...arguments_);
      return { ...channel, topic: privateText };
    }
    if (method === 'GET' && dependencies.mutations.length && path === `/channels/${channelId}`) {
      if (isReadbackUnavailable) throw new Error(privateText);
      return { ...channel, topic: readback };
    }
    return api(method, path, ...arguments_);
  };
  if (isEnabled) dependencies.serverLogClock = clock;
  const input = request('channel.edit', { channelId, reason: privateText, payload: { topic: privateText } });
  return { execute: () => administerDiscord(input, dependencies), mutations: dependencies.mutations };
}

test('a changed topic yields a safe audit receipt only after exact channel readback', async () => {
  const { execute } = topicOperation({ readback: privateText });
  const { serverLogEvent: event } = await execute();
  assert.equal(event?.kind, 'admin.channel-topic-changed');
  assert.equal(JSON.stringify(event).includes(privateText), false);
  assert.equal(JSON.stringify(event).includes(channelId), false);
  assert.equal(renderServerLog(event, 'mastermind').content,
    'mastermind / Discord Admin · AUDIT · 2026-01-01T12:00:00.000Z\nImpact: A Discord channel topic changed.\nStatus: Confirmed by reading back the updated topic.');
});

for (const [reason, options] of Object.entries({ disabled: { isEnabled: false, readback: privateText },
  'unchanged topic': { previous: privateText, readback: privateText }, mismatch: { readback: 'different topic' },
  'failed readback': { isReadbackUnavailable: true } })) {
  test(`Admin emits no audit receipt for ${reason}`, async () => {
    const { execute, mutations } = topicOperation(options);
    const result = await execute();
    assert.equal(result.status, 'completed');
    assert.equal(result.serverLogEvent, undefined);
    assert.equal(mutations.length, 1);
  });
}

test('an uncertain Admin mutation does not yield an audit result', async () => {
  const { execute } = topicOperation({ isMutationUnconfirmed: true });
  await assert.rejects(execute, /fixture PATCH unconfirmed/);
});

test('the renderer rejects unknown events, raw details and unsafe pot labels', () => {
  const event = serverLogEvent(SERVER_LOG_EVENT.sourceRefreshFailed, clock());
  for (const candidate of [{ ...event, detail: privateText }, { ...event, kind: 'routine.success' }, { ...event, at: privateText }]) {
    assert.throws(() => renderServerLog(candidate, 'fixture-pot'), /server-log/);
  }
  assert.throws(() => renderServerLog(event, privateText), /server-log/);
});
