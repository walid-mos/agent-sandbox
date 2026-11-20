import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { healthyWorkerMemory } from '../probes/fixtures/worker-memory.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'pots-delivery-'));
process.env.HOME = scratch;
const bin = join(scratch, 'bin');
mkdirSync(bin);
process.env.PATH = `${bin}:${process.env.PATH}`;
const boundaryPath = join(scratch, 'boundary.json');
process.env.POTS_TEST_BOUNDARY = boundaryPath;
mock.module('./sandbox.mjs', { exports: { botId: 'nextnode', sandbox: {} } });
const { inspectWorker } = await import('./inspect-worker.mjs');
const { serveQueue } = await import('./serve-queue.mjs');
const { createAdmission } = await import('./worker-admission.mjs');
const { acknowledgeResult } = await import('./worker-results.mjs');
const { enqueue, queued, QUEUE } = await import('./queue.mjs');
const { receiptPath, statePath, SETTLED_GRACE_MS } = await import('./worker-lifecycle.mjs');
const { writePrivateJson } = await import('./private-json.mjs');
const { allTerminals, save, workers, WORKERS } = await import('./workers.mjs');
const sessionFile = join(scratch, 'task', 'exact.jsonl');
mkdirSync(join(scratch, 'task'));
writeFileSync(sessionFile, '{"type":"session","id":"exact"}\n');
writeFileSync(join(scratch, 'task', 'newer.jsonl'), '{"type":"session","id":"wrong-newer"}\n');
const worker = { name: 'owned', owner: 'nextnode', launchId: 'launch-1', terminal: 't-owned', worktree: join(scratch, 'task'),
  sessionFile, startedAt: 1, pullRequest: 'https://example.test/pr/22' };
const terminal = { name: 'owned', address: 't-owned', cwd: worker.worktree, state: 'live', status: 'idle',
  labels: { 'pots.owner': 'nextnode', 'pots.launch': 'launch-1' } };
const boundaryScript = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.POTS_TEST_BOUNDARY;
const boundary = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const binary = path.basename(process.argv[1]);
boundary.calls.push({ binary, args });
if (binary === 'git') {
  const answers = { branch: 'feat/task', 'rev-parse': 'abcdef1', status: '', 'rev-list': '0' };
  process.stdout.write(answers[args[0]]);
} else if (binary === 'hc') {
  if (args[0] === 'ls') process.stdout.write(JSON.stringify({ terminals: boundary.terminals }));
  else if (args[0] === 'get' && boundary.vanishing === args.at(-1)) {
    boundary.terminals = boundary.terminals.filter(terminal => terminal.address !== args.at(-1));
    fs.writeFileSync(file, JSON.stringify(boundary));
    process.exit(1);
  } else if (args[0] === 'get' && boundary.failing === args.at(-1)) process.exit(1);
  else if (args[0] === 'get') process.stdout.write(JSON.stringify(boundary.terminals.find(terminal => [terminal.name, terminal.address].includes(args.at(-1)))));
  else if (args[0] === 'read') process.stdout.write('Finished task report.');
  else if (args[0] === 'run') {
    const name = args[args.indexOf('--name') + 1];
    boundary.terminals.push({ ...boundary.template, name, address: 't-' + name + '-resumed' });
  }
  else if (!['send', 'rm', 'kill'].includes(args[0])) throw new Error('Unexpected hc command');
}
fs.writeFileSync(file, JSON.stringify(boundary));
`;
for (const name of ['hc', 'git', 'pots', 'pi']) writeFileSync(join(bin, name), boundaryScript, { mode: 0o700 });

const boundary = () => JSON.parse(readFileSync(boundaryPath, 'utf8'));
function setTerminals(terminals) {
  writeFileSync(boundaryPath, JSON.stringify({ ...boundary(), terminals }));
}
function settle() {
  writePrivateJson(statePath(worker), { ...worker, phase: 'settled', generation: 'result-1',
    sessionId: 'exact', received: [], settledAt: Date.now() - SETTLED_GRACE_MS });
}
function inspect() {
  inspectWorker(workers()[0], { terminals: boundary().terminals, now: Date.now(), queue: queued(), pending: new Set(), resting: new Map() });
}
function serve() {
  const logFailure = (_subject, error) => { throw error; };
  serveQueue(boundary().terminals, logFailure, createAdmission({ logFailure, readText: healthyWorkerMemory }));
}

beforeEach(() => {
  rmSync(WORKERS, { force: true, recursive: true });
  save(worker);
  writeFileSync(boundaryPath, JSON.stringify({ terminals: [terminal], template: terminal, calls: [] }));
  settle();
});
after(() => { mock.restoreAll(); rmSync(scratch, { force: true, recursive: true }); });

test('reporting preserves an unread result without killing the process', () => {
  inspect();
  const saved = workers()[0];
  assert.equal(readFileSync(saved.result.screen, 'utf8'), 'Finished task report.');
  assert.match(readFileSync(saved.result.transcript, 'utf8'), /"id":"exact"/);
  assert.equal(boundary().calls.some(call => ['kill', 'rm'].includes(call.args[0])), false);
  assert.equal(boundary().calls.filter(call => call.binary === 'pots').length, 1);
  inspect();
  assert.equal(boundary().calls.filter(call => call.binary === 'pots').length, 1);
});

test('input on a reported worker wakes the bot once, and a closing worker not at all', () => {
  inspect();
  for (const generation of ['keystroke-1', 'keystroke-2', 'keystroke-3']) {
    writePrivateJson(statePath(worker), { ...worker, phase: 'active', generation, received: [] });
    inspect();
  }
  assert.equal(boundary().calls.filter(call => call.binary === 'pots').length, 2);
  writePrivateJson(statePath(worker), { ...worker, phase: 'closing', generation: 'closing', received: [] });
  setTerminals([{ ...terminal, status: 'done' }]);
  inspect();
  assert.equal(boundary().calls.filter(call => call.binary === 'pots').length, 2);
});

test('receipt covers only the current result and refuses a queued follow-up', () => {
  inspect();
  const id = workers()[0].result.id;
  assert.throws(() => acknowledgeResult(['owned', 'stale']), /current saved result/);
  enqueue({ worker: worker.name, message: 'New request' });
  assert.throws(() => acknowledgeResult(['owned', id]), /follow-up is queued/);
  assert.deepEqual(readdirSync(QUEUE).filter(file => file.endsWith('.json')).length, 1);
});

test('a finished-idle report can be acknowledged without a Herdr app', () => {
  inspect();
  const id = workers()[0].result.id;
  acknowledgeResult(['owned', id]);
  assert.equal(JSON.parse(readFileSync(receiptPath(worker), 'utf8')).id, id);
});

test('newly active or newly owned helpers invalidate coordinator receipt', () => {
  inspect();
  const id = workers()[0].result.id;
  setTerminals([terminal, { address: 'helper', cwd: worker.worktree, state: 'live', status: 'done' }]);
  assert.throws(() => acknowledgeResult(['owned', id]), /still needs attention/);
});

test('unowned workers and same-name terminals are never closed or resumed', () => {
  save({ ...worker, owner: 'personal' });
  inspect();
  assert.deepEqual(boundary().calls, []);
  save(worker);
  setTerminals([{ ...terminal, labels: { 'pots.owner': 'personal' } }]);
  enqueue({ worker: worker.name, message: 'Do not redirect me' });
  assert.throws(serve, /ownership changed/);
  assert.equal(boundary().calls.some(call => ['send', 'run', 'kill'].includes(call.args[0])), false);
});

test('a stopped worker whose terminal already ended is not closed again', () => {
  writeFileSync(join(WORKERS, `${worker.name}.stopped`), '');
  setTerminals([{ ...terminal, state: 'finished' }]);
  inspect();
  assert.deepEqual(boundary().calls, []);
});

test('a terminal removed while the list is read is left out, and one still listed fails the read', () => {
  const helper = { address: 'helper', cwd: worker.worktree, state: 'finished' };
  writeFileSync(boundaryPath, JSON.stringify({ ...boundary(), terminals: [terminal, helper], vanishing: 'helper' }));
  assert.deepEqual(allTerminals().map(listed => listed.address), ['t-owned']);
  writeFileSync(boundaryPath, JSON.stringify({ ...boundary(), terminals: [terminal, { ...helper, address: 'stuck' }], vanishing: undefined, failing: 'stuck' }));
  assert.throws(allTerminals);
});

test('startup without an agent status stays live regardless of age', () => {
  setTerminals([{ ...terminal, status: undefined }]);
  inspect();
  assert.equal(queued().length, 0);
  assert.deepEqual(boundary().calls, []);
});

test('crash recovery does not reread a terminal the watcher has already swept', () => {
  setTerminals([{ ...terminal, state: 'finished' }]);
  inspect();
  assert.equal(queued()[0].worker, 'owned');
  assert.deepEqual(boundary().calls, []);
});

test('a resumed launch that crashes before it settles is not resumed again', () => {
  setTerminals([{ ...terminal, state: 'finished' }]);
  inspect();
  setTerminals([]);
  serve();
  const resumed = workers()[0];
  assert.notEqual(resumed.launchId, worker.launchId);
  setTerminals([{ ...terminal, address: resumed.terminal, state: 'finished', labels: { 'pots.owner': 'nextnode', 'pots.launch': resumed.launchId } }]);
  inspect();
  assert.equal(queued().length, 0);
});

test('first launch preallocates one exact session identity before starting Pi', () => {
  const first = { ...worker, sessionFile: undefined, sessionId: undefined, launchId: undefined, terminal: undefined,
    startedAt: undefined, brief: '/brief.md' };
  save(first);
  setTerminals([]);
  enqueue({ worker: worker.name });
  serve();
  const saved = workers()[0];
  const launch = boundary().calls.find(call => call.args[0] === 'run').args;
  assert.equal(launch[launch.indexOf('--session-id') + 1], saved.sessionId);
  assert.equal(launch[launch.indexOf('--session-dir') + 1], join(WORKERS, 'sessions', 'owned'));
  assert.equal(launch.includes('@undefined'), false);
  assert.equal(launch.includes('@/brief.md'), true);
  assert.equal(queued().length, 0);
});

test('a queued launch can start alongside a live worker and retains its follow-up', () => {
  const name = 'queued-first';
  save({ name, owner: worker.owner, worktree: worker.worktree, brief: '/brief.md' });
  enqueue({ worker: name });
  enqueue({ worker: name, message: 'Follow up' });
  serve();
  assert.deepEqual(boundary().terminals.map(terminal => terminal.name), [worker.name, name]);
  assert.deepEqual(queued().map(({ worker, message }) => ({ worker, message })), [{ worker: name, message: 'Follow up' }]);
});

test('follow-up stays durable until Pi accepts it and is sent only once per launch', () => {
  enqueue({ worker: worker.name, message: 'Continue' });
  serve();
  const request = queued()[0];
  assert.equal(request.sentTo, worker.launchId);
  serve();
  assert.equal(boundary().calls.filter(call => call.args[0] === 'send').length, 1);
  writePrivateJson(statePath(worker), { ...worker, phase: 'active', received: [request.file] });
  serve();
  assert.equal(queued().length, 0);
});

test('a follow-up Pi accepted before it crashed is not sent again to the resumed launch', () => {
  inspect();
  enqueue({ worker: worker.name, message: 'Continue' });
  serve();
  const request = queued()[0];
  writePrivateJson(statePath(worker), { ...worker, phase: 'active', received: [request.file] });
  setTerminals([{ ...terminal, state: 'finished' }]);
  inspectWorker(workers()[0], { terminals: boundary().terminals, now: Date.now(), queue: queued(), pending: new Set([worker.name]), resting: new Map() });
  assert.equal(queued().some(queuedRequest => queuedRequest.file === request.file), false);
  assert.equal(queued().length, 1);
  assert.equal(queued()[0].message, undefined);
});

test('a follow-up arriving as shutdown starts reopens the exact session, never the newer folder session', () => {
  writePrivateJson(statePath(worker), { ...worker, phase: 'closing', received: [] });
  enqueue({ worker: worker.name, message: 'Follow up after close' });
  serve();
  assert.equal(boundary().calls.some(call => call.args[0] === 'send'), false);
  setTerminals([]);
  serve();
  const launch = boundary().calls.find(call => call.args[0] === 'run').args;
  assert.equal(launch[launch.indexOf('--session') + 1], sessionFile);
  assert.equal(launch.includes('--continue'), false);
  assert.equal(queued().length, 1);
  const resumed = workers()[0];
  setTerminals([{ ...terminal, address: resumed.terminal, labels: { 'pots.owner': 'nextnode', 'pots.launch': resumed.launchId } }]);
  writePrivateJson(statePath(resumed), { ...resumed, phase: 'starting', received: [] });
  serve();
  assert.equal(boundary().calls.filter(call => call.args[0] === 'send').length, 1);
  assert.equal(queued().length, 1);
});
