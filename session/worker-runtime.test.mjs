import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, mock, test } from 'node:test';

mock.module('./sandbox.mjs', { exports: { sandbox: {} } });
const scratch = mkdtempSync(join(tmpdir(), 'pots-runtime-'));
process.env.HOME = scratch;
process.env.HC_TERMINAL_ID = 't-owned';
const bin = join(scratch, 'bin');
mkdirSync(bin);
const boundaryPath = join(scratch, 'boundary.json');
process.env.POTS_TEST_BOUNDARY = boundaryPath;
process.env.PATH = `${bin}:${process.env.PATH}`;
const { WorkerRuntime } = await import('./worker-runtime.mjs');
const { receiptPath, resultId, SETTLED_GRACE_MS, statePath } = await import('./worker-lifecycle.mjs');
const { readJson, writePrivateJson } = await import('./private-json.mjs');
const { enqueue, QUEUE } = await import('./queue.mjs');
const worker = { name: 'owned', owner: 'nextnode', launchId: 'launch-1' };
const terminal = { address: 't-owned', name: 'owned', cwd: '/work/task', state: 'live', status: { state: 'idle' },
  labels: { 'pots.owner': 'nextnode', 'pots.launch': 'launch-1' } };
const final = { id: 'leaf-1', type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Ready.' }] } };
const boundaryScript = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.POTS_TEST_BOUNDARY;
const boundary = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (path.basename(process.argv[1]) === 'git') {
  if (boundary.gitFailures) {
    boundary.gitFailures -= 1;
    fs.writeFileSync(file, JSON.stringify(boundary));
    process.exit(1);
  }
  process.stdout.write(args[0] === 'status' ? boundary.dirty : boundary.unpushed);
} else if (args[0] === 'ls') {
  process.stdout.write(JSON.stringify({ terminals: boundary.terminals }));
} else if (args[0] === 'get') {
  process.stdout.write(JSON.stringify(boundary.terminals.find(terminal => terminal.address === args.at(-1))));
} else { throw new Error('Unexpected boundary command'); }
fs.writeFileSync(file, JSON.stringify(boundary));
`;
writeFileSync(join(bin, 'hc'), boundaryScript, { mode: 0o700 });
writeFileSync(join(bin, 'git'), boundaryScript, { mode: 0o700 });
let runtime;
let context;
let counts;
let shutdowns;
let rawInput;
let branch;
let boundary;

function publishBoundary(changes = {}) {
  boundary = { ...boundary, ...changes };
  writeFileSync(boundaryPath, JSON.stringify(boundary));
}

beforeEach(t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  rmSync(QUEUE, { force: true, recursive: true });
  counts = { asyncRuns: 0, waitSubscriptions: 0, awaited: 0 };
  shutdowns = 0;
  branch = [final];
  publishBoundary({ terminals: [terminal], dirty: '', unpushed: '0', gitFailures: 0 });
  context = { cwd: scratch, isIdle: () => true, hasPendingMessages: () => false,
    shutdown: () => { shutdowns += 1; }, ui: { getEditorText: () => '', onTerminalInput: handler => { rawInput = handler; return () => {}; } },
    sessionManager: { getSessionFile: () => '/saved/exact.jsonl', getSessionId: () => 'exact-id', getLeafId: () => 'leaf-1', getBranch: () => branch } };
  runtime = new WorkerRuntime({ events: { emit: (_event, request) => { request.result = { version: 1, ...counts }; } } }, worker);
  runtime.start(context);
});
afterEach(() => runtime.stop());
after(() => rmSync(scratch, { recursive: true, force: true }));

function acknowledge(t) {
  runtime.settle(context);
  const state = readJson(statePath(worker));
  writePrivateJson(receiptPath(worker), { id: resultId(state) });
  t.mock.timers.tick(SETTLED_GRACE_MS);
}

test('an unread final result keeps its live process until exact coordinator receipt', t => {
  runtime.settle(context);
  t.mock.timers.tick(SETTLED_GRACE_MS);
  runtime.finish(context);
  assert.equal(shutdowns, 0);
  const state = readJson(statePath(worker));
  assert.equal(state.sessionFile, '/saved/exact.jsonl');
  writePrivateJson(receiptPath(worker), { id: 'stale-result' });
  runtime.finish(context);
  assert.equal(shutdowns, 0);
  writePrivateJson(receiptPath(worker), { id: resultId(state) });
  runtime.finish(context);
  assert.equal(shutdowns, 1);
  assert.equal(readJson(statePath(worker)).phase, 'closing');
});

test('an exact receipt written by atomic rename wakes a settled done worker without manual finish', { timeout: 5_000 }, async t => {
  publishBoundary({ terminals: [{ ...terminal, status: { state: 'done' } }] });
  const closed = new Promise(resolve => { context.shutdown = resolve; });
  acknowledge(t);
  await closed;
  assert.equal(readJson(statePath(worker)).phase, 'closing');
});

test('prompt timing saved after settlement does not strand an acknowledged result', t => {
  publishBoundary({ terminals: [{ ...terminal, status: { state: 'done' } }] });
  acknowledge(t);
  branch = [final, { id: 'timing-1', parentId: final.id, type: 'custom', customType: 'pi-hud-telemetry-prompt-timing-v2' }];
  context.sessionManager.getLeafId = () => 'timing-1';
  runtime.finish(context);
  assert.equal(shutdowns, 1);
});

test('a transient inspection failure retries the exact receipt and closes once', t => {
  acknowledge(t);
  publishBoundary({ gitFailures: 1 });
  runtime.finish(context);
  assert.equal(shutdowns, 0);
  t.mock.timers.tick(1000);
  assert.equal(shutdowns, 1);
  t.mock.timers.tick(60000);
  assert.equal(shutdowns, 1);
});

test('persistent inspection failure has bounded automatic retries', t => {
  acknowledge(t);
  publishBoundary({ gitFailures: 100 });
  runtime.finish(context);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    t.mock.timers.tick(1000);
    runtime.finish(context);
  }
  assert.equal(shutdowns, 0);
  assert.equal(JSON.parse(readFileSync(boundaryPath, 'utf8')).gitFailures, 97);
});

for (const pending of ['input', 'question', 'cancel', 'queue', 'ownership', 'receipt', 'helper', 'background', 'branch']) {
  test(`${pending} after a failed inspection prevents retry shutdown`, t => {
    acknowledge(t);
    publishBoundary({ gitFailures: 1 });
    runtime.finish(context);
    const arrive = {
      input: () => rawInput('x'),
      question: () => publishBoundary({ gitFailures: 0, terminals: [{ ...terminal, labels: { ...terminal.labels, 'agent.waiting': 'human' } }] }),
      cancel: () => runtime.stop(),
      queue: () => enqueue({ worker: worker.name, message: 'Continue' }),
      ownership: () => publishBoundary({ gitFailures: 0, terminals: [{ ...terminal, labels: {} }] }),
      receipt: () => writePrivateJson(receiptPath(worker), { id: 'stale' }),
      helper: () => publishBoundary({ gitFailures: 0, terminals: [terminal, { address: 'helper', parent: 't-owned', state: 'live' }] }),
      background: () => { counts.awaited = 1; },
      branch: () => { context.sessionManager.getLeafId = () => 'leaf-2'; },
    };
    arrive[pending]();
    t.mock.timers.tick(60000);
    assert.equal(shutdowns, 0);
    assert.notEqual(readJson(statePath(worker)).phase, 'closing');
  });
}

for (const status of ['idle', 'done']) {
  test(`acknowledged finished ${status} shuts down without a UI service`, t => {
    publishBoundary({ terminals: [{ ...terminal, status: { state: status } }] });
    acknowledge(t);
    runtime.finish(context);
    assert.equal(shutdowns, 1);
  });
}

for (const field of ['asyncRuns', 'waitSubscriptions', 'awaited']) {
  test(`${field} keeps a worker that has given a final reply`, t => {
    acknowledge(t);
    counts[field] = 1;
    runtime.finish(context);
    assert.equal(shutdowns, 0);
  });
}

test('unknown pending-work contracts fail closed', t => {
  runtime.stop();
  runtime = new WorkerRuntime({ events: { emit: () => {} } }, worker);
  runtime.start(context);
  acknowledge(t);
  runtime.finish(context);
  assert.equal(shutdowns, 0);
});

for (const pending of ['question', 'editor', 'working', 'goal', 'helper', 'dirty', 'unpushed']) {
  test(`${pending} arriving after receipt prevents shutdown`, t => {
    acknowledge(t);
    const arrive = {
      question: () => { context.hasPendingMessages = () => true; },
      editor: () => { context.ui.getEditorText = () => 'draft'; },
      working: () => { context.isIdle = () => false; },
      goal: () => { branch = [{ type: 'custom', customType: 'pi-goal-state-v1', data: { items: [{ done: false }] } }, final]; },
      helper: () => publishBoundary({ terminals: [terminal, { address: 'helper', parent: 't-owned', state: 'live', status: { state: 'done' } }] }),
      dirty: () => publishBoundary({ dirty: ' M task.mjs' }),
      unpushed: () => publishBoundary({ unpushed: '2' }),
    };
    arrive[pending]();
    runtime.finish(context);
    assert.equal(shutdowns, 0);
  });
}

test('a session branch change after receipt preserves the process', t => {
  acknowledge(t);
  context.sessionManager.getLeafId = () => 'leaf-2';
  runtime.finish(context);
  assert.equal(shutdowns, 0);
});

test('a queued follow-up wins against an acknowledged close', t => {
  acknowledge(t);
  enqueue({ worker: worker.name, message: 'Continue' });
  runtime.finish(context);
  assert.equal(shutdowns, 0);
});

test('new terminal input invalidates the old result receipt', t => {
  acknowledge(t);
  rawInput('x');
  runtime.finish(context);
  assert.equal(shutdowns, 0);
  assert.equal(readJson(receiptPath(worker)), undefined);
});

test('a burst of terminal input republishes a result once', t => {
  acknowledge(t);
  rawInput('x');
  const { generation } = readJson(statePath(worker));
  rawInput('y');
  rawInput('z');
  assert.equal(readJson(statePath(worker)).generation, generation);
  assert.equal(readJson(statePath(worker)).phase, 'active');
});

test('hc input is durably received and invalidates an earlier close', t => {
  acknowledge(t);
  const transformed = runtime.input({ text: '<hc from="bot"><pots-follow-up id="100-a.json">\nAgain\n</pots-follow-up></hc>' }, context);
  assert.equal(transformed.text, '<hc from="bot">Again</hc>');
  assert.deepEqual(readJson(statePath(worker)).received, ['100-a.json']);
  runtime.finish(context);
  assert.equal(shutdowns, 0);
});
