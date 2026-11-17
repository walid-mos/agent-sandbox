import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mock, test } from 'node:test';
import { sandboxFixture } from '../probes/fixtures/sandbox.mjs';

sandboxFixture('board-events-');
const wakes = [];
mock.module('./run.mjs', { exports: { command: (...args) => wakes.push(args), WITH_VAULT: '/synthetic/with-vault' } });
const { sandbox } = await import('./sandbox.mjs');
const { reportToPrincipal } = await import('./factory-reports.mjs');
const { writeRecord } = await import('./factory-records.mjs');
const { factoryEvents } = await import('./pr-board-events.mjs');
const { BOARD_HOME } = await import('./pr-board-store.mjs');
const record = { repository: 'demo/widget', number: 7, head: 'a'.repeat(40), stage: 'judged', verdict: 'PASS' };

test('disabled factory reporting keeps its existing wake and never opens board storage', () => {
  sandbox.pullRequestBoard = undefined;
  reportToPrincipal({ ...record, stage: 'checks-failed' }, 'Synthetic failure');
  assert.equal(wakes.length, 1);
  assert.equal(existsSync(BOARD_HOME), false);
});

test('enabled verdict and merge reporting journals both facts without a coordinator model turn', () => {
  sandbox.pullRequestBoard = { enabled: true };
  wakes.length = 0;
  writeRecord(record);
  reportToPrincipal({ ...record, stage: 'merged', mergeCommit: 'b'.repeat(40) }, 'Synthetic merge');
  const first = factoryEvents();
  assert.equal(first.length, 2);
  assert.deepEqual(first.map(event => event.kind).sort(), ['merge', 'verdict']);
  assert.equal(first.find(event => event.kind === 'verdict').verdict, 'PASS');
  writeRecord(record);
  assert.deepEqual(factoryEvents(), first);
  assert.deepEqual(wakes, []);
});
