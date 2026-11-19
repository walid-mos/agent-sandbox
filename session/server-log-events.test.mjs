import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { channelId, fixture, request } from '../probes/fixtures/discord-admin.mjs';
import { administerDiscord } from './discord-admin-service.mjs';
import { readJson } from './private-json.mjs';
import { renderServerLog, serverLogEvent, SERVER_LOG_EVENT } from './server-log-events.mjs';
import { sourceRefresh, sourceRefreshNotice } from './watch-sources.mjs';

const at = '2026-01-01T12:00:00.000Z';
const clock = () => new Date(at);
const privateText = 'fixture @everyone internal topic and reason';

function watcher(t) {
  const folder = mkdtempSync(join(tmpdir(), 'server-log-fixture-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'source-refresh.json');
  let finish;
  const output = [];
  const run = callback => { finish = callback; };
  const sink = { write: text => output.push(text) };
  const refresh = sourceRefresh({ run, isReady: () => true, stdout: sink, stderr: sink,
    notice: sourceRefreshNotice(path, clock, () => assert.fail('Unexpected fixture write failure')) });
  return { path, output, complete(error) { refresh(); finish(error, privateText, privateText); } };
}

test('a provisioning failure records one safe warning during the incident', t => {
  const source = watcher(t);
  source.complete(new Error(privateText));
  const event = readJson(source.path);
  assert.equal(event?.kind, 'source-refresh.failed');
  assert.equal(statSync(source.path).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(event).includes(privateText), false);
  assert.equal(source.output.includes(privateText), true);
  source.complete(new Error('another failure'));
  assert.deepEqual(readJson(source.path), event);
  assert.deepEqual(renderServerLog(event, 'fixture-pot'), {
    content: 'fixture-pot / pots-sources · WARNING · 2026-01-01T12:00:00.000Z\nImpact: Automatic source provisioning did not complete.\nRecovery: The next scheduled refresh retries. Inspect local service logs if it keeps failing.',
    allowed_mentions: { parse: [] },
  });
});

test('routine refresh success emits no notice and recovery closes the warning episode', t => {
  const source = watcher(t);
  source.complete(undefined);
  assert.equal(readJson(source.path), undefined);
  source.complete(new Error('fixture failure'));
  const first = readJson(source.path);
  assert.equal(first?.kind, 'source-refresh.failed');
  source.complete(undefined);
  assert.deepEqual(readJson(source.path), first);
  source.complete(new Error('fixture failure'));
  assert.notEqual(readJson(source.path)?.id, first.id);
});

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
