import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { sandboxFixture } from '../probes/fixtures/sandbox.mjs';

const { home, sandbox } = sandboxFixture('pots-idle-');
sandbox.idleWorkerMinutes = 1;
const terminal = { address: 't-owned', name: 'owned', cwd: home, state: 'live', status: 'idle', status_ms: 1_000,
  turn: 1, labels: { 'pots.owner': 'proof', 'pots.launch': 'launch-1' } };
let terminals;
let refuseWake;
let wakes;
let launches;
let sends;
mock.module('./run.mjs', { exports: { WITH_VAULT: '/unused', failureReason: error => error.message, command(binary, args) {
  if (binary === 'pots') {
    if (refuseWake) throw new Error('Pots unavailable');
    wakes.push(JSON.parse(args.at(-1)));
    return '';
  }
  if (binary === 'hc' && args[0] === 'ls') return JSON.stringify({ terminals });
  if (binary === 'hc' && args[0] === 'get') return JSON.stringify(terminals.find(terminal => [terminal.address, terminal.name].includes(args.at(-1))));
  if (binary === 'pi' && args[0] === '--help') return '';
  if (binary === 'hc' && args[0] === 'run') {
    launches.push(args);
    const labels = Object.fromEntries(args.flatMap((value, index) => value === '--label' ? [args[index + 1].split('=')] : []));
    terminals = [{ ...terminal, address: 't-resumed', labels }];
    return '';
  }
  if (binary === 'hc' && args[0] === 'send') return sends.push(args.at(-1));
  throw new Error(`Unexpected command: ${binary} ${args[0]}`);
} } });
const { inspectWorker } = await import('./inspect-worker.mjs');
const { enqueue, queued } = await import('./queue.mjs');
const { serveQueue } = await import('./serve-queue.mjs');
const { createAdmission } = await import('./worker-admission.mjs');
const { healthyWorkerMemory } = await import('../probes/fixtures/worker-memory.mjs');
const { runOperation } = await import('./main.mjs');
const { WorkerRuntime } = await import('./worker-runtime.mjs');
const { receiptPath, statePath } = await import('./worker-lifecycle.mjs');
const { readJson } = await import('./private-json.mjs');
const { save, workers, WORKERS } = await import('./workers.mjs');
const worker = { name: 'owned', owner: 'proof', launchId: 'launch-1', terminal: 't-owned', worktree: home,
  kind: 'task', resultFile: join(home, 'result.md') };
const sessionId = 'exact-id';
const sessionFile = join(home, 'exact.jsonl');
const user = { type: 'message', message: { role: 'user', content: 'Original brief' } };
let runtime;
let context;
let counts;
let branch;
let rawInput;
let shutdowns;
let idleWorkers;

function inspect() {
  const queue = queued();
  return inspectWorker(workers()[0], { terminals, now: Date.now(), monotonicNow: Date.now(), queue,
    pending: new Set(queue.map(request => request.worker)), idleWorkers });
}

beforeEach(t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  rmSync(WORKERS, { force: true, recursive: true });
  process.env.HC_TERMINAL_ID = terminal.address;
  save(worker);
  writeFileSync(sessionFile, `{"type":"session","id":"${sessionId}"}\n`);
  terminals = [terminal];
  refuseWake = false;
  wakes = [];
  launches = [];
  sends = [];
  shutdowns = 0;
  idleWorkers = new Map();
  counts = { asyncRuns: 0, waitSubscriptions: 0, awaited: 0 };
  branch = [user];
  context = { cwd: home, isIdle: () => true, hasPendingMessages: () => false,
    shutdown: () => { shutdowns += 1; }, ui: { getEditorText: () => '', onTerminalInput: handler => { rawInput = handler; return () => {}; } },
    sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => sessionId, getLeafId: () => 'leaf-1', getBranch: () => branch } };
  runtime = new WorkerRuntime({ events: { emit: (_event, request) => { request.result = { version: 1, ...counts }; } } }, worker);
  runtime.start(context);
});
afterEach(() => {
  runtime.stop();
  rmSync(worker.resultFile, { force: true });
});

function measure(timers) {
  timers.tick(5_000);
  inspect();
}

test('an unsettled session closes only after the full idle period and a successful open report', ({ mock: { timers } }) => {
  refuseWake = true;
  timers.tick(5_000);
  assert.throws(inspect, /Pots unavailable/);
  timers.tick(60_000);
  assert.throws(inspect, /Pots unavailable/);
  runtime.finish(context);
  assert.equal(shutdowns, 0);
  assert.equal(readJson(receiptPath(worker)), undefined);
  refuseWake = false;
  inspect();
  timers.tick(59_999);
  inspect();
  runtime.finish(context);
  assert.equal(shutdowns, 0);
  timers.tick(1);
  inspect();
  runtime.finish(context);
  assert.equal(shutdowns, 1);
  assert.equal(readJson(statePath(worker)).closeReason, 'idle');
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].result, undefined);
});

test('watcher restart remeasures idle and preserves intentional closure across reconciliation', ({ mock: { timers } }) => {
  measure(timers);
  timers.tick(59_999);
  idleWorkers = new Map();
  inspect();
  timers.tick(1);
  inspect();
  runtime.finish(context);
  assert.equal(shutdowns, 0);
  timers.tick(59_999);
  inspect();
  runtime.finish(context);
  assert.equal(shutdowns, 1);
  terminals = [];
  idleWorkers = new Map();
  inspect();
  inspect();
  assert.equal(workers()[0].isClosed, true);
  assert.equal(workers()[0].sessionFile, sessionFile);
  assert.equal(workers()[0].sessionId, sessionId);
  assert.deepEqual(queued(), []);
});

test('a dispatcher follow-up during idle shutdown resumes the exact saved session', async ({ mock: { timers } }) => {
  measure(timers);
  timers.tick(60_000);
  inspect();
  runtime.finish(context);
  assert.equal(shutdowns, 1);
  const messageFile = join(home, 'follow-up.md');
  writeFileSync(messageFile, 'Continue in the original conversation.');
  mock.module('./main.mjs', { exports: { runOperation, main: (_module, body) => body() } });
  const originalArgs = process.argv;
  try {
    process.argv = [process.execPath, 'dispatch.mjs', 'send', worker.name, messageFile];
    await import('./dispatch.mjs');
  } finally {
    process.argv = originalArgs;
  }
  const logFailure = (_subject, error) => { throw error; };
  const admission = createAdmission({ logFailure, readText: healthyWorkerMemory });
  serveQueue(terminals, logFailure, admission);
  assert.deepEqual(sends, []);
  terminals = [];
  inspect();
  serveQueue(terminals, logFailure, admission);
  assert.equal(launches.length, 1);
  assert.equal(launches[0][launches[0].indexOf('--session') + 1], sessionFile);
  assert.equal(workers()[0].sessionId, sessionId);
  assert.equal(queued()[0].message, 'Continue in the original conversation.');
});

test('terminal input invalidates the remaining measured idle time and a close receipt', ({ mock: { timers } }) => {
  measure(timers);
  timers.tick(59_999);
  rawInput('a');
  timers.tick(1);
  inspect();
  runtime.finish(context);
  assert.equal(shutdowns, 0);
  measure(timers);
  timers.tick(60_000);
  inspect();
  assert.ok(readJson(receiptPath(worker)));
  rawInput('b');
  runtime.finish(context);
  assert.equal(shutdowns, 0);
  assert.equal(readJson(receiptPath(worker)), undefined);
});

for (const [guard, apply] of Object.entries({
  'explicit keep': () => { terminals = [{ ...terminal, labels: { ...terminal.labels, 'lifecycle.keep': 'yes' } }]; },
  'a changed terminal turn': () => { terminals = [{ ...terminal, turn: terminal.turn + 1 }]; },
  'an unread helper': () => { terminals.push({ address: 't-helper', parent: terminal.address, state: 'finished', finished_ms: 2_000 }); },
  'a pending follow-up': () => enqueue({ worker: worker.name, message: 'Continue' }),
  'an unsent draft': () => { context.ui.getEditorText = () => ' '; },
  'a new task result': () => writeFileSync(worker.resultFile, 'Unread result'),
  'a pending dialog': () => { context.hasPendingMessages = () => true; },
  'pending background work': () => { counts.awaited = 1; },
  'a new goal': () => { branch = [user, { type: 'custom', customType: 'pi-goal-state-v1', data: { items: [{ done: false }] } }]; },
  'assistant output': () => { branch = [user, { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Unread' }] } }]; },
})) {
  test(`${guard} appearing after an idle receipt keeps the terminal open`, ({ mock: { timers } }) => {
    measure(timers);
    timers.tick(60_000);
    inspect();
    assert.ok(readJson(receiptPath(worker)));
    apply();
    runtime.finish(context);
    assert.equal(shutdowns, 0);
  });
}
