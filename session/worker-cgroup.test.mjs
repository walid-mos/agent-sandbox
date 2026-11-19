import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrange, hc, RETRY_MS } from '../probes/fixtures/worker-watcher.mjs';

const CGROUP = '/cgroup mount';
const ANCESTOR = `${CGROUP}/ancestor`;
const LEAF = `${ANCESTOR}/session`;
const MiB = 1024 ** 2;
const MOUNTINFO = '/proc/self/mountinfo';
const MOUNT = String.raw`27 21 0:25 / /cgroup\040mount rw - cgroup2 cgroup rw` + '\n';
const psi = (some, full) => `some avg10=${some}\nfull avg10=${full}\n`;

function arrangeCgroup() {
  const fixture = arrange(['waiting']);
  const { metrics } = fixture;
  metrics.set('/proc/self/cgroup', '0::/ancestor/session\n');
  metrics.set(MOUNTINFO, MOUNT);
  for (const scope of [CGROUP, ANCESTOR, LEAF]) {
    metrics.set(`${scope}/memory.high`, 'max');
    metrics.set(`${scope}/memory.max`, 'max');
    metrics.set(`${scope}/memory.pressure`, psi(0, 0));
  }
  return fixture;
}

test('a tight ancestor memory.high pauses until the timed sample sees reclaimable headroom', ({ mock: { timers } }) => {
  const { pass, metrics } = arrangeCgroup();
  metrics.set(`${ANCESTOR}/memory.high`, String(1024 * MiB));
  metrics.set(`${ANCESTOR}/memory.current`, String(1000 * MiB));
  metrics.set(`${ANCESTOR}/memory.stat`, 'inactive_file 0\n');
  pass();
  assert.deepEqual(hc.attempts, []);
  metrics.set(`${ANCESTOR}/memory.stat`, `inactive_file ${128 * MiB}\n`);
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['waiting']);
});

test('the kernel cgroup root still contributes PSI with no limit files', ({ mock: { timers } }) => {
  const { pass, metrics } = arrangeCgroup();
  metrics.delete(`${CGROUP}/memory.max`);
  metrics.delete(`${CGROUP}/memory.high`);
  metrics.set(`${CGROUP}/memory.pressure`, psi(12, 2));
  pass();
  assert.deepEqual(hc.attempts, []);
  metrics.set(`${CGROUP}/memory.pressure`, psi(0, 0));
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['waiting']);
});

for (const [requirement, path, broken, healthy] of [
  ['a mount hiding an ancestor', MOUNTINFO, MOUNT.replace(' / /cgroup', ' /ancestor /cgroup'), MOUNT],
  ['unsupported v1 memory accounting', '/proc/self/cgroup', '5:memory:/worker\n', '0::/ancestor/session\n'],
  ['a denied limit read', `${ANCESTOR}/memory.high`, Object.assign(new Error('denied'), { code: 'EACCES' }), 'max'],
  ['a malformed hard limit', `${ANCESTOR}/memory.max`, 'invalid', 'max'],
  ['a missing high limit in a memory cgroup', `${ANCESTOR}/memory.high`, undefined, 'max'],
]) {
  test(`admission defers and retries after ${requirement}`, ({ mock: { timers } }) => {
    const { pass, metrics } = arrangeCgroup();
    if (broken === undefined) metrics.delete(path);
    else metrics.set(path, broken);
    pass();
    assert.deepEqual(hc.attempts, []);
    metrics.set(path, healthy);
    timers.tick(RETRY_MS);
    assert.deepEqual(hc.attempts, ['waiting']);
  });
}

test('an absent cgroup pressure file falls back to hard-limit headroom without assuming cache is reclaimable', ({ mock: { timers } }) => {
  const { pass, metrics } = arrangeCgroup();
  metrics.delete(`${ANCESTOR}/memory.pressure`);
  metrics.set(`${ANCESTOR}/memory.max`, String(1024 * MiB));
  metrics.set(`${ANCESTOR}/memory.current`, String(1000 * MiB));
  pass();
  assert.deepEqual(hc.attempts, []);
  metrics.set(`${ANCESTOR}/memory.current`, String(512 * MiB));
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['waiting']);
});

test('cgroup PSI pauses starts even when the guest and the cgroup have plenty of RAM', ({ mock: { timers } }) => {
  const { pass, metrics } = arrangeCgroup();
  metrics.set(`${LEAF}/memory.pressure`, psi(5, 1));
  pass();
  assert.deepEqual(hc.attempts, []);
  metrics.set(`${LEAF}/memory.pressure`, psi(0, 0));
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['waiting']);
});
