import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'pots-inspection-'));
process.env.HOME = scratch;
const wakes = [];
let publication;
let restart = 0;
let mustAvoidGit = false;
mock.module('./sandbox.mjs', { exports: { botId: 'nextnode', sandbox: {} } });
mock.module('./run.mjs', { exports: {
  WITH_VAULT: '/unused-vault',
  command(binary, args) {
    if (binary === 'pots') return wakes.push(JSON.parse(args.at(-1)));
    if (binary === 'hc' && args[0] === 'read') return 'Finished result.';
    if (binary === 'hc' && args[0] === 'get') return JSON.stringify({ labels: { 'pi.session': sessionFile } });
    if (binary === 'git' && mustAvoidGit) throw new Error('Non-repository task invoked Git');
    if (binary === 'git') return ({ branch: 'feat/task', 'rev-parse': 'abcdef1', ...publication })[args[0]];
    throw new Error(`Unexpected boundary command: ${binary} ${args[0]}`);
  },
} });
const { inspectWorker } = await import('./inspect-worker.mjs');
const { WorkerRuntime } = await import('./worker-runtime.mjs');
const { queued, dequeue, enqueue } = await import('./queue.mjs');
const { clearStop, markStopped, recordPublication, save, workers, WORKERS } = await import('./workers.mjs');
const { writePrivateJson } = await import('./private-json.mjs');
const { canFinish, statePath, SETTLED_GRACE_MS } = await import('./worker-lifecycle.mjs');
const { humanStore, HUMAN_HOME } = await import('./human-store.mjs');
const { openDialog, cancelDialog } = await import('./human-dialogs.mjs');
const sessionFile = join(scratch, 'exact.jsonl');
writeFileSync(sessionFile, '{"type":"session","id":"exact"}\n');
const worker = { name: 'owned', owner: 'nextnode', launchId: 'launch-1', terminal: 't-owned', worktree: scratch, sessionFile };
const terminal = { address: 't-owned', name: 'owned', state: 'live', status: 'idle', cwd: scratch,
  labels: { 'pots.owner': 'nextnode', 'pots.launch': 'launch-1' } };
process.env.HC_TERMINAL_ID = terminal.address;

function inspect(terminals = [terminal], inspector = inspectWorker) {
  return inspector(workers()[0], { terminals, now: Date.now(), queue: queued(), resting: new Map(), pending: new Set(queued().map(request => request.worker)) });
}

function settle(current = worker) {
  writePrivateJson(statePath(current), { ...current, phase: 'settled', generation: current.launchId,
    received: [], settledAt: Date.now() - SETTLED_GRACE_MS });
}

beforeEach(() => {
  rmSync(WORKERS, { force: true, recursive: true });
  rmSync(HUMAN_HOME, { force: true, recursive: true });
  save(worker);
  publication = { status: '', 'rev-list': '0' };
  wakes.length = 0;
  mustAvoidGit = false;
});
after(() => { mock.restoreAll(); rmSync(scratch, { force: true, recursive: true }); });

test('repeated settlement keeps the 15-minute deadline until the worker re-enters waiting', t => {  const waitWindow = 15 * 60_000;
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const runtime = new WorkerRuntime({ events: { emit: (_event, request) => { request.result = { version: 1, awaited: 1 }; } } }, worker);
  const context = { ui: { onTerminalInput: () => () => {} },
    sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => 'exact', getLeafId: () => 'leaf-1' } };
  t.after(() => runtime.stop());
  runtime.start(context);
  runtime.settle(context);
  const deadline = Date.now() + waitWindow;

  t.mock.timers.tick(60_000);
  runtime.settle(context);
  assert.equal(inspect(), deadline);
  assert.equal(wakes.length, 0);
  t.mock.timers.tick(deadline - Date.now());
  inspect();
  assert.equal(wakes.length, 1);

  runtime.invalidate(context);
  runtime.settle(context);
  assert.equal(inspect(), deadline + waitWindow);
});

test('a worker waiting on its own work reports once at the 15-minute limit', t => {
  const now = 1_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  writePrivateJson(statePath(worker), { ...worker, phase: 'waiting', generation: 'result-1', received: [], waitingSince: now });
  const deadline = now + 15 * 60_000;
  assert.equal(inspect(), deadline);
  assert.equal(wakes.length, 0);
  t.mock.timers.tick(deadline - now);
  inspect();
  assert.equal(wakes.length, 1);
  inspect();
  assert.equal(wakes.length, 1);
});

test('an unread follow-up holds the idle report for the delivery limit', t => {
  const now = 2_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  save({ ...workers()[0], startedAt: now - 10_000 });
  writePrivateJson(statePath(worker), { ...worker, phase: 'active', generation: 'result-1', received: [] });
  enqueue({ worker: worker.name, message: 'Continue.' });
  assert.equal(inspect(), now + 60_000);
  assert.equal(wakes.length, 0);
  t.mock.timers.tick(60_000);
  inspect();
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].status, 'idle');
});

test('an initial brief not yet begun holds the idle report for the delivery limit', t => {
  const now = 3_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  save({ ...workers()[0], isBriefed: true, startedAt: now });
  writePrivateJson(statePath(worker), { ...worker, phase: 'starting', generation: 'result-1', received: [] });
  assert.equal(inspect(), now + 60_000);
  assert.equal(wakes.length, 0);
  t.mock.timers.tick(60_000);
  inspect();
  assert.equal(wakes.length, 1);
});

test('watcher restart cannot repeatedly relaunch a recovery that crashes before settling', async () => {
  inspect([]);
  assert.equal(queued().length, 1);
  queued().forEach(dequeue);
  save({ ...workers()[0], launchId: 'recovery-launch', terminal: 't-recovery' });
  const restarted = await import(`./inspect-worker.mjs?restart=${++restart}`);
  inspect([], restarted.inspectWorker);
  assert.equal(queued().length, 0);
});

test('observing a settled recovery permits recovery after a later crash', async () => {
  inspect([]);
  queued().forEach(dequeue);
  const recovered = { ...workers()[0], launchId: 'recovered', terminal: 't-recovered' };
  save(recovered);
  settle(recovered);
  inspect([{ ...terminal, address: recovered.terminal, labels: { ...terminal.labels, 'pots.launch': recovered.launchId } }]);
  const restarted = await import(`./inspect-worker.mjs?restart=${++restart}`);
  inspect([], restarted.inspectWorker);
  assert.equal(queued().length, 1);
});

test('a pending published question blocks both watcher collection and runtime closure until settlement', async () => {
  settle();
  const dialog = await openDialog({ kind: 'question', source: { type: 'worker', worker: worker.name, session: sessionFile, call: 'pending' },
    questions: [{ id: 'answer', prompt: 'Continue?' }] });
  const state = { ...worker, phase: 'settled', settledAt: Date.now() - SETTLED_GRACE_MS };
  assert.equal(canFinish(state, terminal, [terminal], Date.now()), false);
  inspect();
  assert.equal(wakes[0].status, 'blocked');
  assert.equal(wakes[0].result, undefined);
  await cancelDialog(dialog.id, 'cancelled', humanStore());
  assert.equal(canFinish(state, terminal, [terminal], Date.now()), true);
  inspect();
  assert.equal(wakes[1].result.state.launchId, worker.launchId);
});

test('a bounded task produces a collectable result without consulting Git', () => {
  mustAvoidGit = true;
  const resultFile = join(scratch, 'report.md');
  const task = { ...worker, kind: 'task', resultFile };
  save(task);
  settle(task);
  inspect();
  assert.equal(wakes[0].result, undefined);
  writeFileSync(resultFile, 'Evidence and conclusion.\n');
  inspect();
  assert.equal(wakes[1].result.state.launchId, worker.launchId);
  assert.equal(wakes[1].resultFile, resultFile);
});

test('a task result must be its own regular file rather than a symlink', () => {
  mustAvoidGit = true;
  const resultFile = join(scratch, 'linked-report.md');
  symlinkSync(sessionFile, resultFile);
  const task = { ...worker, kind: 'task', resultFile };
  save(task);
  settle(task);
  inspect();
  assert.equal(wakes[0].resultReady, false);
  assert.equal(wakes[0].result, undefined);
});

test('local inspection, watcher restart, stop and queued send leave the old startup dialog pending', async () => {
  const local = { ...worker, publication: 'local' };
  const dialog = await openDialog({ kind: 'question', source: { type: 'bot', message: 'old-startup' }, policy: 'push',
    scope: 'Original empty-bootstrap startup only, with no existing worker',
    questions: [{ id: 'push', prompt: 'Publish bootstrap?', options: [{ label: 'Push once' }, { label: 'Keep local' }] }] });
  const original = humanStore().get(dialog.id);
  save(local);
  settle(local);
  inspect();
  assert.equal(wakes[0].publication, 'local');
  assert.equal(wakes[0].result, undefined);
  const restarted = await import(`./inspect-worker.mjs?restart=${++restart}`);
  inspect([terminal], restarted.inspectWorker);
  markStopped(local);
  inspect([]);
  clearStop(local);
  enqueue({ worker: local.name, message: 'Continue local work only.' });
  inspect();
  assert.deepEqual(humanStore().get(dialog.id), original);
  assert.equal(workers()[0].publication, 'local');
  assert.equal(workers()[0].result, undefined);
});

test('an unchanged worker keeps its existing wake ID across watcher deployment', () => {
  publication.status = ' M unfinished.mjs';
  save({ ...worker, lastReport: 'owned-launch-1-0-idle-open' });
  inspect();
  assert.equal(wakes.length, 0);
});

test('publication progress is reported without losing state to a stale watcher write', () => {
  const local = { ...worker, publication: 'local' };
  save(local);
  settle(local);
  inspect();
  const beforePush = workers()[0];
  recordPublication(local, { publication: 'awaiting-pr', publishedHead: 'full-head' });
  save(beforePush);
  inspect();
  assert.equal(wakes[1].publication, 'awaiting-pr');
  assert.equal(wakes[1].result, undefined);
  const beforePR = workers()[0];
  recordPublication(local, { publication: 'published', publishedHead: 'full-head', pullRequest: 'https://github.invalid/pr/1' });
  save(beforePR);
  inspect();
  assert.equal(wakes[2].publication, 'published');
  assert.equal(wakes[2].pullRequest, 'https://github.invalid/pr/1');
  assert.ok(wakes[2].result);
  inspect();
  assert.equal(wakes.length, 3);
});

for (const field of ['status', 'rev-list']) {
  test(`external publication changing ${field} upgrades a prior report to a collectable result once`, () => {
    settle();
    publication[field] = field === 'status' ? ' M task.mjs' : '1';
    inspect();
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].result, undefined);
    publication[field] = field === 'status' ? '' : '0';
    inspect();
    assert.equal(wakes.length, 2);
    assert.equal(wakes[1].result.state.launchId, 'launch-1');
    assert.equal(workers()[0].result.id, wakes[1].result.id);
    inspect();
    assert.equal(wakes.length, 2);
  });
}
