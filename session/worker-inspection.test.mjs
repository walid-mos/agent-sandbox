import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'pots-inspection-'));
process.env.HOME = scratch;
const wakes = [];
let publication;
let restart = 0;
mock.module('./sandbox.mjs', { exports: { botId: 'nextnode' } });
mock.module('./run.mjs', { exports: {
  WITH_VAULT: '/unused-vault',
  command(binary, args) {
    if (binary === 'pots') return wakes.push(JSON.parse(args.at(-1)));
    if (binary === 'hc' && args[0] === 'read') return 'Finished result.';
    if (binary === 'hc' && args[0] === 'get') return JSON.stringify({ labels: { 'pi.session': sessionFile } });
    if (binary === 'git') return ({ branch: 'feat/task', 'rev-parse': 'abcdef1', ...publication })[args[0]];
    throw new Error(`Unexpected boundary command: ${binary} ${args[0]}`);
  },
} });
const { inspectWorker } = await import('./inspect-worker.mjs');
const { WorkerRuntime } = await import('./worker-runtime.mjs');
const { queued, dequeue } = await import('./queue.mjs');
const { save, workers, WORKERS } = await import('./workers.mjs');
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
  return inspector(workers()[0], { terminals, now: Date.now(), queue: queued(), pending: new Set(queued().map(request => request.worker)) });
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
});
after(() => { mock.restoreAll(); rmSync(scratch, { force: true, recursive: true }); });

test('repeated settlement keeps the 15-minute deadline until the worker re-enters waiting', t => {
  const waitWindow = 15 * 60_000;
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
