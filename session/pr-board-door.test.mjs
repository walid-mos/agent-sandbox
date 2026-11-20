import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { sandboxFixture } from '../probes/fixtures/sandbox.mjs';
import { BOARD_ACK, sectionPackets } from './pr-board-contract.mjs';

sandboxFixture('board-door-');
const wakes = [];
mock.module('./run.mjs', { exports: {
  command: (...args) => { wakes.push(args); return JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'alpha.example.test' } }); },
  commandOutput: async () => '', commandWithInput: async () => {}, failureReason: () => '',
} });
mock.module('./door-knock.mjs', { exports: { knock: () => undefined, knockAsync: async () => undefined } });
const { sandbox } = await import('./sandbox.mjs');
const { receiveMessage } = await import('./door-deliveries.mjs');
const { find, all, remove, save } = await import('./door-requests.mjs');
const { prepareReply } = await import('./doors.mjs');
const packet = sectionPackets([], 1000)[0];
const incoming = (kind = 'board', body = packet, caller = 'alpha') => receiveMessage(caller, Buffer.from(`${kind} alpha.12345678${kind === 'request' ? ' 0' : ''}\n${JSON.stringify(body)}`));
function reset() {
  all().forEach(record => remove(record.id));
  sandbox.role = 'mastermind';
  sandbox.pullRequestBoard = { enabled: true, sources: { alpha: ['demo/widget'] } };
  wakes.length = 0;
}

test('board deliveries and exact acknowledgements never wake a model or enter dialog state', () => {
  reset();
  incoming();
  assert.equal(find('alpha.12345678').kind, 'board');
  incoming();
  assert.deepEqual(wakes, []);
  assert.throws(() => prepareReply('alpha.12345678', '{"type":"human.answer"}'), { exitCode: 76 });
  prepareReply('alpha.12345678', BOARD_ACK);
  assert.equal(find('alpha.12345678').reply, BOARD_ACK);
  save({ id: 'proof.87654321', kind: 'board', direction: 'asked', pot: 'alpha', state: 'open', need: JSON.stringify(packet), at: 1000 });
  receiveMessage('alpha', Buffer.from(`reply proof.87654321\n${BOARD_ACK}`));
  assert.equal(find('proof.87654321').state, 'answered');
  assert.deepEqual(wakes, []);
});

test('board route refuses disabled switches, foreign repos, forged origin and dialog tunnelling', () => {
  reset();
  sandbox.pullRequestBoard.enabled = false;
  assert.throws(() => incoming(), { exitCode: 76 });
  sandbox.pullRequestBoard.enabled = true;
  assert.throws(() => incoming('board', packet, 'foreign'), { exitCode: 76 });
  assert.throws(() => incoming('dialog'), { exitCode: 76 });
  const pull = { repository: 'other/private', number: 1, title: 'Synthetic task', workers: [], githubState: 'draft', state: 'draft', createdAt: 0 };
  assert.throws(() => incoming('board', sectionPackets([pull], 1000)[0]), { exitCode: 76 });
  sandbox.role = undefined;
  assert.throws(() => incoming(), { exitCode: 76 });
  assert.deepEqual(all(), []);
  assert.deepEqual(wakes, []);
});

test('ordinary board-shaped text stays an ordinary request and wakes the ordinary route', () => {
  reset();
  incoming('request');
  assert.equal(find('alpha.12345678').kind, undefined);
  assert.equal(JSON.parse(wakes[0][1].at(-1)).kind, 'request');
});
