import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { renderServerLog } from './server-log-events.mjs';
import { SOURCE_REFRESH_CAPACITY, sourceRefreshIncidents } from './source-refresh-incidents.mjs';
import { sourceRefresh, sourceRefreshNotice } from './watch-sources.mjs';

const failedAt = '2026-01-01T12:00:00.000Z';
const recoveredAt = '2026-01-01T12:05:00.000Z';
const later = '2026-01-01T12:10:00.000Z';
const privateText = 'fixture @everyone raw provisioning details';
const failure = new Error(privateText);

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'source-refresh-fixture-'));
  const path = join(folder, 'server-log', 'source-refresh.sqlite');
  const stores = new Set();
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(folder, { recursive: true, force: true });
  });
  return { path, open() {
    const store = sourceRefreshIncidents(path);
    stores.add(store);
    return { ...store, close() { store.close(); stores.delete(store); } };
  } };
}

function watcher(store) {
  let finish;
  let now;
  const output = [];
  const reports = [];
  const notice = sourceRefreshNotice(() => store, () => new Date(now), reason => reports.push(reason));
  const sink = { write: text => output.push(text) };
  const refresh = sourceRefresh({ run: callback => { finish = callback; }, isReady: () => true, stdout: sink, stderr: sink, notice });
  return { output, reports, observe(at, error) {
    now = at;
    finish = undefined;
    refresh();
    if (!finish) return 'paused';
    finish(error, privateText, privateText);
    return 'ran';
  } };
}

test('unread incidents retain distinct identities and recovery times across episodes', t => {
  const store = fixture(t).open();
  const source = watcher(store);
  source.observe(failedAt);
  assert.deepEqual(store.readPending(), []);
  source.observe(failedAt, failure);
  const [first] = store.readPending();
  source.observe(recoveredAt);
  source.observe(later, failure);
  const incidents = store.readPending();
  assert.equal(incidents.length, 2);
  assert.deepEqual(incidents[0], { warning: first.warning, recoveredAt });
  assert.equal(incidents[1].warning.at, later);
  assert.equal(incidents[1].recoveredAt, null);
  assert.notEqual(incidents[1].warning.id, first.warning.id);
});

test('watcher restart and repeated provisioning failure reuse the active identity', t => {
  const repository = fixture(t);
  const original = repository.open();
  watcher(original).observe(failedAt, failure);
  const snapshot = original.readPending();
  original.close();
  const reopened = repository.open();
  const restarted = watcher(reopened);
  restarted.observe(recoveredAt, failure);
  assert.deepEqual(reopened.readPending(), snapshot);
  restarted.observe(later);
  reopened.close();
  assert.deepEqual(repository.open().readPending(), [{ warning: snapshot[0].warning, recoveredAt: later }]);
});

test('failed recovery write retries with the original time before another refresh starts', t => {
  const store = fixture(t).open();
  let canWrite = false;
  const source = watcher({ ...store, recordRecovery(now) {
    if (!canWrite) throw new Error(privateText);
    store.recordRecovery(now);
  } });
  source.observe(failedAt, failure);
  source.observe(recoveredAt);
  assert.equal(source.observe(later, failure), 'paused');
  assert.equal(store.readPending()[0].recoveredAt, null);
  assert.deepEqual(source.reports, ['unavailable', 'unavailable']);
  canWrite = true;
  assert.equal(source.observe(later, failure), 'ran');
  assert.equal(store.readPending().length, 2);
  assert.equal(store.readPending()[0].recoveredAt, recoveredAt);
});

test('stale and duplicate acknowledgements cannot remove a recovery or another incident', t => {
  const repository = fixture(t);
  const source = watcher(repository.open());
  const collector = repository.open();
  source.observe(failedAt, failure);
  const [active] = collector.readPending();
  source.observe(recoveredAt);
  source.observe(later, failure);
  const [closed, next] = collector.readPending();
  assert.equal(collector.acknowledge(active), false);
  assert.equal(collector.acknowledge({ ...closed, warning: { ...closed.warning, at: later } }), false);
  assert.deepEqual(collector.readPending(), [closed, next]);
  assert.equal(collector.acknowledge(closed), true);
  assert.equal(repository.open().acknowledge(closed), false);
  assert.deepEqual(collector.readPending(), [next]);
});

test('an acknowledged active warning stays deduplicated and its recovery becomes unread', t => {
  const repository = fixture(t);
  const collector = repository.open();
  watcher(repository.open()).observe(failedAt, failure);
  const [active] = collector.readPending();
  assert.equal(collector.acknowledge(active), true);
  assert.equal(collector.acknowledge(active), false);
  const restarted = watcher(repository.open());
  restarted.observe(failedAt, failure);
  assert.deepEqual(collector.readPending(), []);
  restarted.observe(recoveredAt);
  assert.deepEqual(collector.readPending(), [{ warning: active.warning, recoveredAt }]);
});

test('capacity preserves every unread record and allows the last active incident to recover', t => {
  const store = fixture(t).open();
  const source = watcher(store);
  for (let episode = 1; episode < SOURCE_REFRESH_CAPACITY; episode += 1) {
    assert.equal(source.observe(failedAt, failure), 'ran');
    assert.equal(source.observe(recoveredAt), 'ran');
  }
  assert.equal(source.observe(failedAt, failure), 'ran');
  assert.equal(source.observe(recoveredAt), 'ran');
  const full = store.readPending();
  assert.equal(full.length, SOURCE_REFRESH_CAPACITY);
  assert.equal(full.at(-1).recoveredAt, recoveredAt);
  assert.equal(source.observe(later, failure), 'paused');
  assert.deepEqual(source.reports, ['capacity']);
  assert.deepEqual(store.readPending(), full);
  assert.equal(store.acknowledge(full[0]), true);
  assert.equal(source.observe(later, failure), 'ran');
  assert.deepEqual(store.readPending().slice(0, -1), full.slice(1));
  assert.equal(store.readPending().at(-1).warning.at, later);
});

test('the private store and rendered warning exclude raw provisioning output', t => {
  const repository = fixture(t);
  const store = repository.open();
  const source = watcher(store);
  source.observe(failedAt, failure);
  source.observe(recoveredAt);
  const [snapshot] = store.readPending();
  assert.equal(statSync(dirname(repository.path)).mode & 0o777, 0o700);
  assert.equal(statSync(repository.path).mode & 0o777, 0o600);
  assert.equal(readFileSync(repository.path).includes(privateText), false);
  assert.equal(source.output.includes(privateText), true);
  assert.deepEqual(renderServerLog(snapshot.warning, 'fixture-pot'), {
    content: 'fixture-pot / pots-sources · WARNING · 2026-01-01T12:00:00.000Z\nImpact: Automatic source provisioning did not complete.\nRecovery: The next scheduled refresh retries. Inspect local service logs if it keeps failing.',
    allowed_mentions: { parse: [] },
  });
  chmodSync(repository.path, 0o644);
  assert.throws(() => repository.open(), /private regular file/);
});
