import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fixture } from '../probes/fixtures/noticeboards.mjs';
import { noticeboardStore } from './noticeboard-store.mjs';
import { noticeboardServicePass } from './noticeboard-service.mjs';

function contextFor(t) {
  const folder = mkdtempSync(join(tmpdir(), 'noticeboards-service-'));
  const store = noticeboardStore(join(folder, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });
  const context = { ...fixture(), store };
  context.client.readEvents = async () => [context.event];
  return context;
}

 test('drains durable events without a model turn and verifies one archive', async t => {
  const context = contextFor(t);
  await noticeboardServicePass(context);
  assert.equal(context.store.cursor(), 1);
  assert.deepEqual(context.store.events(), []);
  assert.equal(context.store.records()[0]?.stage, 'verified');
  assert.deepEqual(context.effects, ['react', 'copy']);
});

 test('a failed source read stays in the durable inbox until recovery', async t => {
  const context = contextFor(t);
  const read = context.client.read;
  context.client.read = async () => { throw new Error('temporary failure'); };
  await noticeboardServicePass(context);
  assert.equal(context.store.events().length, 1);
  assert.equal(context.store.events()[0].attempts, 1);
  context.client.read = read;
  await noticeboardServicePass({ ...context, now: context.now + 10_000 });
  assert.deepEqual(context.store.events(), []);
  assert.equal(context.store.records()[0]?.stage, 'verified');
});

 test('a poisoned incoming event cannot put raw hook credentials into durable state', async t => {
  const context = contextFor(t);
  context.client.readEvents = async () => [{ ...context.event, raw: 'fixture-not-a-secret', token: 'fixture-not-a-secret' }];
  context.client.read = async () => { throw new Error('source unavailable'); };
  await noticeboardServicePass(context);
  assert.equal(context.store.cursor(), 1);
  assert.equal(context.store.events().length, 1);
  assert.equal(JSON.stringify(context.store.events()).includes('fixture-not-a-secret'), false);
});

 test('exhausted event references leave the inbox and are held as records', async t => {
  const context = contextFor(t);
  const events = Array.from({ length: 16 }, (_, index) => ({ ...context.event, id: index + 1 }));
  context.store.enqueue(events);
  for (const event of events) {
    for (let attempt = 0; attempt < 5; attempt += 1) context.store.defer(event.id, context.now);
  }
  context.client.readEvents = async () => [{ ...context.event, id: 17 }];
  await noticeboardServicePass(context);
  const stages = context.store.records().map(record => record.stage);
  assert.equal(stages.filter(stage => stage === 'verified').length, 1);
  assert.equal(stages.filter(stage => stage === 'exhausted').length, events.length);
  assert.deepEqual(context.store.events(), []);
});

 test('disabled service does not open its inbox or call the adapter', async t => {
  const context = contextFor(t);
  context.client.readEvents = async () => { assert.fail('disabled service read gateway events'); };
  const result = await noticeboardServicePass({ ...context, configuration: {} });
  assert.equal(result?.status, 'disabled');
  assert.equal(context.store.cursor(), 0);
  assert.deepEqual(context.effects, []);
});
