import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { sandboxFixture } from '../probes/fixtures/sandbox.mjs';

sandboxFixture('worker-agent-');
const { default: workerAgent } = await import('./worker-agent.mjs');
const { save, workers } = await import('./workers.mjs');
const { statePath } = await import('./worker-lifecycle.mjs');

for (const recordLaunch of [undefined, 'another-launch']) {
  test(`a launch with ${recordLaunch ?? 'no record'} stops instead of running without lifecycle reporting`, () => {
    const worker = { name: `stale-${recordLaunch ?? 'missing'}`, owner: 'proof', launchId: 'environment-launch' };
    process.env.POTS_WORKER = worker.name;
    process.env.POTS_OWNER = worker.owner;
    process.env.POTS_LAUNCH = worker.launchId;
    process.env.HC_TERMINAL_ID = 't-stale';
    if (recordLaunch) save({ ...worker, launchId: recordLaunch });
    const before = workers();
    const handlers = new Map();
    workerAgent({ on: (event, handler) => handlers.set(event, handler) });
    let shutdowns = 0;
    const notices = [];
    handlers.get('session_start')({}, { mode: 'tui', shutdown: () => { shutdowns += 1; }, ui: { notify: text => notices.push(text) } });
    assert.equal(shutdowns, 1);
    assert.match(notices[0], /matching worker record/);
    assert.equal(existsSync(statePath(worker)), false);
    assert.deepEqual(workers(), before);
  });
}
