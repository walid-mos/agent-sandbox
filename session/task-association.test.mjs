import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after, beforeEach, mock, test } from 'node:test';
import { join } from 'node:path';

const folder = mkdtempSync(join(tmpdir(), 'task-association-'));
after(() => { mock.restoreAll(); rmSync(folder, { recursive: true, force: true }); });
mock.module('node:os', { exports: { homedir: () => folder } });
const { save, workers, WORKERS } = await import('./workers.mjs');
beforeEach(() => rmSync(WORKERS, { recursive: true, force: true }));

test('a stale watcher save cannot erase the single worker task association', () => {
  const stale = { name: 'synthetic', owner: 'synthetic-bot', launchId: 'synthetic-launch' };
  save(stale);
  save({ ...stale, taskId: 'task-synthetic-001' });
  save({ ...stale, status: 'idle' });
  assert.equal(workers()[0].taskId, 'task-synthetic-001');
  assert.equal(workers()[0].status, 'idle');
});

test('a worker cannot overwrite its original task association', () => {
  const worker = { name: 'synthetic', owner: 'synthetic-bot', taskId: 'task-synthetic-001' };
  save(worker);
  assert.throws(() => save({ ...worker, taskId: 'task-synthetic-002' }), /another task/);
  assert.equal(workers()[0].taskId, 'task-synthetic-001');
});
