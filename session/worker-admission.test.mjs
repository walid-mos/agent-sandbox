import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrange, enqueue, EPOCH, hc, queued, RETRY_MS, statePath, workers, writePrivateJson } from '../probes/fixtures/worker-watcher.mjs';

test('the watcher staggers launches but runs several workers concurrently in arrival order', ({ mock: { timers } }) => {
  const { pass } = arrange(['first', 'second', 'third', 'fourth']);
  pass();
  assert.deepEqual(hc.attempts, ['first']);
  timers.tick(RETRY_MS - 1);
  pass();
  assert.deepEqual(hc.attempts, ['first']);
  timers.tick(1);
  assert.deepEqual(hc.attempts, ['first', 'second']);
  timers.tick(RETRY_MS);
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.terminals.map(terminal => terminal.name), ['first', 'second', 'third', 'fourth']);
  assert.deepEqual(queued(), []);
});

test('pressure queues new starts while live follow-ups still reach Pi, then the timer resumes admission', ({ mock: { timers } }) => {
  const { pass, memory } = arrange(['first', 'second', 'third']);
  pass();
  const first = workers().find(worker => worker.name === 'first');
  writePrivateJson(statePath(first), { ...first, phase: 'active', received: [] });
  memory.some = '5.00';
  timers.tick(RETRY_MS);
  timers.tick(1);
  enqueue({ worker: 'first', message: 'Keep working' });
  pass();
  assert.deepEqual(hc.attempts, ['first']);
  assert.deepEqual(hc.messages.map(({ terminal }) => terminal), ['first']);
  assert.match(hc.messages[0].text, /Keep working/);
  memory.some = '0.00';
  timers.tick(RETRY_MS - 2);
  pass();
  assert.deepEqual(hc.attempts, ['first']);
  timers.tick(1);
  assert.deepEqual(hc.attempts, ['first', 'second']);
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.terminals.map(({ name }) => name), ['first', 'second', 'third']);
  assert.equal(hc.messages.length, 1);
});

test('startup remains gated until the live launch reports its first agent status', ({ mock: { timers } }) => {
  const { pass } = arrange(['first', 'second']);
  hc.startStatus = undefined;
  pass();
  timers.tick(RETRY_MS);
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first']);
  hc.terminals[0].status = 'working';
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first', 'second']);
});

test('a reloaded watcher preserves the remaining spacing even after status arrives', ({ mock: { timers } }) => {
  const { pass, restart } = arrange(['first', 'second']);
  pass();
  timers.reset();
  timers.enable({ apis: ['Date', 'setTimeout'], now: EPOCH + 100 });
  restart()();
  assert.deepEqual(hc.attempts, ['first']);
  timers.tick(RETRY_MS - 101);
  assert.deepEqual(hc.attempts, ['first']);
  timers.tick(1);
  assert.deepEqual(hc.attempts, ['first', 'second']);
});

test('a terminal without status remains live but stops blocking admission after 30 seconds', ({ mock: { timers } }) => {
  const { pass, memory, failures } = arrange(['first', 'second']);
  hc.startStatus = undefined;
  pass();
  for (let elapsed = 0; elapsed < 25_000; elapsed += RETRY_MS) timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first']);
  assert.ok(failures.some(failure => failure.includes('first agent status')));
  memory.available = 0;
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first']);
  memory.available = 2_800_000;
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.terminals.map(({ name }) => name), ['first', 'second']);
});

test('the configured ceiling holds even when memory is healthy', ({ mock: { timers } }) => {
  const { pass } = arrange(['first', 'second', 'third'], { ceiling: 1 });
  pass();
  timers.tick(RETRY_MS);
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first']);
  hc.terminals = [];
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first', 'second']);
});

test('failed memory reads pause starts, log once and retry until a fresh sample succeeds', ({ mock: { timers } }) => {
  const { pass, memory, failures } = arrange(['first']);
  memory.error = new Error('meminfo unavailable');
  pass();
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, []);
  assert.deepEqual(failures, ['memory admission: meminfo unavailable']);
  delete memory.error;
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first']);
});

test('a launch that opened no terminal leaves the next worker eligible', ({ mock: { timers } }) => {
  const { pass } = arrange(['first', 'second']);
  hc.refuse = 'first';
  pass();
  assert.deepEqual(hc.attempts, ['first', 'second']);
  assert.deepEqual(hc.terminals.map(({ name }) => name), ['second']);
});

test('a launch that lost its address after opening still delays the next launch', ({ mock: { timers } }) => {
  const { pass } = arrange(['first', 'second']);
  hc.missingAddress = 'first';
  pass();
  assert.deepEqual(hc.attempts, ['first']);
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.terminals.map(({ name }) => name), ['first', 'second']);
});

test('headroom is recalculated as the guest memory total changes, including on a no-swap pot', ({ mock: { timers } }) => {
  const { pass, memory } = arrange(['first', 'second']);
  Object.assign(memory, { total: 20_480_000, available: 2_000_000, swapTotal: 0, swapFree: 0 });
  pass();
  memory.available = 1_000_000;
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first']);
  memory.total = 8_126_464;
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first', 'second']);
});

for (const [requirement, blocked, recovered] of [
  ['the minimum memory reserve', { total: 2_000_000, available: 262_143 }, { available: 262_144 }],
  ['full PSI at one percent', { some: '1.00', full: '1.00' }, { full: '0.99' }],
  ['malformed MemAvailable', { available: 'unknown' }, { available: 2_800_000 }],
  ['inconsistent memory amounts', { available: 9_000_000 }, { available: 2_800_000 }],
  ['malformed PSI', { full: '101.00' }, { full: '0.00' }],
  ['a denied PSI read', { psiError: Object.assign(new Error('denied'), { code: 'EACCES' }) }, { psiError: undefined }],
]) {
  test(`admission retries after ${requirement} clears`, ({ mock: { timers } }) => {
    const { pass, memory } = arrange(['first']);
    Object.assign(memory, blocked);
    pass();
    assert.deepEqual(hc.attempts, []);
    Object.assign(memory, recovered);
    timers.tick(RETRY_MS);
    assert.deepEqual(hc.attempts, ['first']);
  });
}

for (const code of ['ENOENT', 'EOPNOTSUPP', 'ENOTSUP']) {
  test(`admission uses live available memory when kernel PSI is unavailable (${code})`, ({ mock: { timers } }) => {
    const { pass, memory } = arrange(['first']);
    memory.psiError = Object.assign(new Error('PSI unavailable'), { code });
    pass();
    assert.deepEqual(hc.attempts, ['first']);
  });
}

test('the admission timer survives a transient terminal-list failure', ({ mock: { timers } }) => {
  const { pass } = arrange(['first', 'second']);
  pass();
  hc.listError = true;
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first']);
  hc.listError = false;
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first', 'second']);
});
