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
    if (binary === 'git') return ({ branch: 'feat/task', 'rev-parse': 'abcdef1', ...publication })[args[0]];
    throw new Error(`Unexpected boundary command: ${binary} ${args[0]}`);
  },
} });
const { inspectWorker } = await import('./inspect-worker.mjs');
const { queued, dequeue } = await import('./queue.mjs');
const { save, workers, WORKERS } = await import('./workers.mjs');
const { writePrivateJson } = await import('./private-json.mjs');
const { statePath, SETTLED_GRACE_MS } = await import('./worker-lifecycle.mjs');
const sessionFile = join(scratch, 'exact.jsonl');
writeFileSync(sessionFile, '{"type":"session","id":"exact"}\n');
const worker = { name: 'owned', owner: 'nextnode', launchId: 'launch-1', terminal: 't-owned', worktree: scratch, sessionFile };
const terminal = { address: 't-owned', name: 'owned', state: 'live', status: 'idle', cwd: scratch,
  labels: { 'pots.owner': 'nextnode', 'pots.launch': 'launch-1' } };

function inspect(terminals = [terminal], inspector = inspectWorker) {
  inspector(workers()[0], { terminals, now: Date.now(), queue: queued(), pending: new Set(queued().map(request => request.worker)) });
}

function settle(current = worker) {
  writePrivateJson(statePath(current), { ...current, phase: 'settled', generation: current.launchId,
    received: [], settledAt: Date.now() - SETTLED_GRACE_MS });
}

beforeEach(() => {
  rmSync(WORKERS, { force: true, recursive: true });
  save(worker);
  publication = { status: '', 'rev-list': '0' };
  wakes.length = 0;
});
after(() => { mock.restoreAll(); rmSync(scratch, { force: true, recursive: true }); });

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
