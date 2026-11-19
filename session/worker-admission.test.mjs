import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'pots-admission-'));
const previousHome = process.env.HOME;
process.env.HOME = scratch;
const BOT = 'nextnode';
const RETRY_MS = 5_000;
const EPOCH = 1_800_000_000_000;
let hc;

function runTerminal(args) {
  const option = name => args[args.indexOf(name) + 1];
  const name = option('--name');
  hc.attempts.push(name);
  if (hc.refuse === name) throw new Error('terminal refused');
  const labels = Object.fromEntries(args.flatMap((value, index) => value === '--label' ? [args[index + 1].split('=')] : []));
  hc.terminals.push({ name, address: name, cwd: option('--cwd'), labels, state: 'live', status: hc.startStatus });
  return '';
}

function command(binary, [action, ...args]) {
  if (binary === 'pi' && action === '--help') return '';
  if (binary === 'pots' && action === 'wake') return '';
  if (binary !== 'hc') throw new Error(`Unexpected command: ${binary} ${action}`);
  if (action === 'ls' && hc.listError) throw new Error('hc unavailable');
  if (action === 'ls') return JSON.stringify({ terminals: hc.terminals });
  if (action === 'get' && args.length === 1 && hc.missingAddress === args[0]) throw new Error('address unavailable');
  if (action === 'get') return JSON.stringify(hc.terminals.find(terminal => terminal.address === args.at(-1)));
  if (action === 'run') return runTerminal(args);
  if (action === 'send') return hc.messages.push({ terminal: args[1], text: args[2] });
  throw new Error(`Unexpected hc command: ${action}`);
}

mock.module('./sandbox.mjs', { exports: { botId: BOT, sandbox: {} } });
mock.module('./run.mjs', { exports: { command, failureReason: error => error.message, WITH_VAULT: '/unused' } });
const { createWatcher } = await import('./watcher.mjs');
const { enqueue, queued } = await import('./queue.mjs');
const { statePath } = await import('./worker-lifecycle.mjs');
const { save, workers, WORKERS } = await import('./workers.mjs');
const { writePrivateJson } = await import('./private-json.mjs');

beforeEach(({ mock: { timers } }) => {
  timers.enable({ apis: ['Date', 'setTimeout'], now: EPOCH });
  rmSync(WORKERS, { force: true, recursive: true });
  hc = { terminals: [], attempts: [], messages: [], startStatus: 'working' };
});

after(() => {
  mock.restoreAll();
  process.env.HOME = previousHome;
  rmSync(scratch, { force: true, recursive: true });
});

function arrange(timers, names, options) {
  const memory = { total: 8_126_464, available: 2_800_000, swapTotal: 2_097_152, swapFree: 62_915, some: '0.00', full: '0.00' };
  const failures = [];
  function readText(path) {
    if (path === '/proc/meminfo' && memory.error) throw memory.error;
    if (path === '/proc/meminfo') return `MemTotal: ${memory.total} kB\nMemAvailable: ${memory.available} kB\nSwapTotal: ${memory.swapTotal} kB\nSwapFree: ${memory.swapFree} kB\n`;
    if (path !== '/proc/pressure/memory') throw new Error(`Unexpected memory file: ${path}`);
    if (memory.psiError) throw memory.psiError;
    return `some avg10=${memory.some} avg60=0.00 avg300=0.00 total=100\nfull avg10=${memory.full} avg60=0.00 avg300=0.00 total=5\n`;
  }
  const pass = createWatcher({ readText, now: Date.now, logFailure: (subject, error) => failures.push(`${subject}: ${error.message}`), ...options });
  for (const name of names) {
    timers.tick(1);
    save({ name, owner: BOT, kind: 'task', worktree: join(scratch, name), brief: '/brief.md' });
    enqueue({ worker: name });
  }
  return { pass, memory, failures };
}

test('the watcher staggers launches but runs several workers concurrently in arrival order', ({ mock: { timers } }) => {
  const { pass } = arrange(timers, ['first', 'second', 'third', 'fourth']);
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
  const { pass, memory } = arrange(timers, ['first', 'second', 'third']);
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
  const { pass } = arrange(timers, ['first', 'second']);
  hc.startStatus = undefined;
  pass();
  timers.tick(RETRY_MS);
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first']);
  hc.terminals[0].status = 'working';
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first', 'second']);
});

test('the configured ceiling holds even when memory is healthy', ({ mock: { timers } }) => {
  const { pass } = arrange(timers, ['first', 'second', 'third'], { ceiling: 1 });
  pass();
  timers.tick(RETRY_MS);
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first']);
  hc.terminals = [];
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first', 'second']);
});

test('failed memory reads pause starts, log once and retry until a fresh sample succeeds', ({ mock: { timers } }) => {
  const { pass, memory, failures } = arrange(timers, ['first']);
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
  const { pass } = arrange(timers, ['first', 'second']);
  hc.refuse = 'first';
  pass();
  assert.deepEqual(hc.attempts, ['first', 'second']);
  assert.deepEqual(hc.terminals.map(({ name }) => name), ['second']);
});

test('a launch that lost its address after opening still delays the next launch', ({ mock: { timers } }) => {
  const { pass } = arrange(timers, ['first', 'second']);
  hc.missingAddress = 'first';
  pass();
  assert.deepEqual(hc.attempts, ['first']);
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.terminals.map(({ name }) => name), ['first', 'second']);
});

test('headroom is recalculated as the guest memory total changes, including on a no-swap pot', ({ mock: { timers } }) => {
  const { pass, memory } = arrange(timers, ['first', 'second']);
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
    const { pass, memory } = arrange(timers, ['first']);
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
    const { pass, memory } = arrange(timers, ['first']);
    memory.psiError = Object.assign(new Error('PSI unavailable'), { code });
    pass();
    assert.deepEqual(hc.attempts, ['first']);
  });
}

test('the admission timer survives a transient terminal-list failure', ({ mock: { timers } }) => {
  const { pass } = arrange(timers, ['first', 'second']);
  pass();
  hc.listError = true;
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first']);
  hc.listError = false;
  timers.tick(RETRY_MS);
  assert.deepEqual(hc.attempts, ['first', 'second']);
});
