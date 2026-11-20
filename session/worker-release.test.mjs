import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, mock, test } from 'node:test';
import { sandboxFixture } from '../probes/fixtures/sandbox.mjs';

const { home } = sandboxFixture('pots-release-');
let terminals;
let wakes;
mock.module('./run.mjs', { exports: { WITH_VAULT: '/unused', failureReason: error => error.message, command(binary, args) {
  if (binary === 'docker') return '';
  if (binary === 'pots') return wakes.push(JSON.parse(args.at(-1)));
  if (binary === 'hc' && args[0] === 'ls') return JSON.stringify({ terminals });
  if (binary === 'hc' && args[0] === 'get') return JSON.stringify(terminals.find(terminal => [terminal.address, terminal.name].includes(args.at(-1))));
  throw new Error(`Unexpected command: ${binary} ${args[0]}`);
} } });
const { createWatcher } = await import('./watcher.mjs');
const { receiptPath, statePath } = await import('./worker-lifecycle.mjs');
const { readJson, writePrivateJson } = await import('./private-json.mjs');
const { save, WORKERS } = await import('./workers.mjs');

const PROC = '/proc';
const sessionFile = join(home, 'exact.jsonl');
writeFileSync(sessionFile, '{"type":"session","id":"exact-id"}\n');

function guestMemory(availableKiB) {
  return path => {
    if (path === `${PROC}/meminfo`) return `MemTotal: 1000000 kB\nMemAvailable: ${availableKiB} kB\n`;
    if (path === `${PROC}/pressure/memory`) return 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
    if (path === `${PROC}/self/cgroup`) return '';
    throw new Error(`Unexpected memory file: ${path}`);
  };
}

const SHORT = guestMemory(100_000);
const ROOM = guestMemory(900_000);

function workerFolder(name) {
  const folder = join(home, name);
  mkdirSync(folder, { recursive: true });
  return folder;
}

function worker(name, changes = {}) {
  return { name, owner: 'proof', launchId: `launch-${name}`, terminal: `t-${name}`, worktree: workerFolder(name), kind: 'task',
    resultFile: join(home, `${name}.result.md`), sessionFile,
    ...changes };
}

function workerTerminal(name, activeAt, labels = {}) {
  return { address: `t-${name}`, name, cwd: workerFolder(name), state: 'live', status: 'idle', status_ms: activeAt, turn: 1,
    labels: { 'pots.owner': 'proof', 'pots.launch': `launch-${name}`, ...labels } };
}

function rest(current, changes = {}) {
  writePrivateJson(statePath(current), { ...current, phase: 'resting', sessionId: 'exact-id', leaf: 'leaf-1', received: [], ...changes });
}

const failures = [];
const run = readText => createWatcher({ readText, logFailure: (subject, error) => failures.push(`${subject}: ${error.message}`) });
const released = names => names.filter(name => readJson(receiptPath({ name, launchId: `launch-${name}` })));

beforeEach(t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  rmSync(WORKERS, { force: true, recursive: true });
  wakes = [];
  failures.length = 0;
});

test('the least recently active resting worker is released first while the guest is short', () => {
  const records = [worker('middle'), worker('oldest'), worker('newest')];
  records.forEach(current => { save(current); rest(current); });
  terminals = [workerTerminal('middle', 2_000), workerTerminal('oldest', 1_000), workerTerminal('newest', 3_000)];
  run(SHORT)();
  assert.deepEqual(released(['oldest', 'middle', 'newest']), ['oldest']);
});

test('the next resting worker waits for the released one to leave memory', () => {
  const first = worker('oldest');
  const second = worker('next');
  [first, second].forEach(current => { save(current); rest(current); });
  terminals = [workerTerminal('oldest', 1_000), workerTerminal('next', 2_000)];
  run(SHORT)();
  assert.deepEqual(released(['oldest', 'next']), ['oldest']);
  rest(first, { phase: 'closing' });
  terminals = [workerTerminal('next', 2_000)];
  run(SHORT)();
  assert.deepEqual(released(['oldest', 'next']), ['oldest', 'next']);
});

test('a guest with memory to spare releases no resting worker', () => {
  const current = worker('resting');
  save(current);
  rest(current);
  terminals = [workerTerminal('resting', 1_000)];
  run(ROOM)();
  assert.deepEqual(released(['resting']), []);
});

test('a busy worker stays open even as the least recently active one', () => {
  const kept = worker('kept');
  const unread = worker('unread');
  const busy = worker('busy');
  const free = worker('free');
  [kept, unread, busy, free].forEach(current => { save(current); rest(current); });
  writeFileSync(unread.resultFile, 'Unread result');
  terminals = [workerTerminal('kept', 1_000, { 'lifecycle.keep': 'yes' }), workerTerminal('unread', 2_000),
    workerTerminal('busy', 3_000), workerTerminal('free', 4_000),
    { address: 't-helper', parent: 't-busy', cwd: workerFolder('helper'), state: 'live', status: 'done' }];
  run(SHORT)();
  assert.deepEqual(released(['kept', 'unread', 'busy', 'free']), ['free']);
});

test('an unreadable memory signal releases nothing and names the failure', () => {
  const current = worker('resting');
  save(current);
  rest(current);
  terminals = [workerTerminal('resting', 1_000)];
  run(() => { throw new Error('EACCES: permission denied'); })();
  assert.deepEqual(released(['resting']), []);
  assert.deepEqual(failures, ['memory release: EACCES: permission denied']);
});
