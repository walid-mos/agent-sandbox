import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'pots-reports-'));
process.env.HOME = scratch;
const wakes = [];
mock.module('./sandbox.mjs', { exports: { botId: 'nextnode', sandbox: { bot: 'nextnode', doors: {} } } });
mock.module('./run.mjs', { exports: {
  command(binary, args) {
    if (binary === 'pots') return wakes.push(JSON.parse(args.at(-1)));
    throw new Error(`Unexpected boundary command: ${binary} ${args[0]}`);
  },
  failureReason: error => error?.message ?? '',
} });
const { newReportId, newRequestId, parse, Refusal, REPORT, REQUEST } = await import('./door-messages.mjs');
const { receiveMessage } = await import('./door-deliveries.mjs');
const { all, ANSWERED, ASKED, DELIVERED, find, OPEN, RECEIVED, save, UNKNOWN } = await import('./door-requests.mjs');

const deliver = (caller, wire) => receiveMessage(caller, Buffer.from(wire));
const report = id => `request ${id} 0\nBoundary probe: the job finished.\n`;
const reply = id => `reply ${id}\nAcknowledged.\n`;

beforeEach(() => {
  rmSync(join(scratch, '.config'), { force: true, recursive: true });
  wakes.length = 0;
});
after(() => { mock.restoreAll(); rmSync(scratch, { force: true, recursive: true }); });

test('a report is kept as delivered and wakes the receiving bot once', () => {
  const id = newReportId('probe');
  deliver('probe', report(id));
  assert.equal(find(id).state, DELIVERED);
  assert.deepEqual(wakes.map(wake => wake.kind), ['report']);
  deliver('probe', report(id));
  assert.equal(wakes.length, 1);
});

test('a reply to a report is kept without waking its sender', () => {
  const id = newReportId('probe');
  save({ id, direction: ASKED, pot: 'probe', need: 'The job finished.', kind: REPORT, state: UNKNOWN, at: 0 });
  deliver('probe', reply(id));
  assert.equal(wakes.length, 0);
  assert.equal(find(id).state, ANSWERED);
});

test('a reply to a received report is refused and wakes nobody', () => {
  const id = newReportId('probe');
  deliver('probe', report(id));
  assert.throws(() => deliver('probe', reply(id)), Refusal);
  assert.equal(find(id).state, DELIVERED);
  assert.equal(wakes.length, 1);
});

test('a report takes no unanswered request slot', () => {
  const soup = Array.from({ length: 20 }, (_unused, index) => ({
    id: `probe.${index.toString(16).padStart(16, '0')}`, direction: RECEIVED, pot: 'probe', need: 'Still open.', hop: 0, state: OPEN, at: index }));
  soup.forEach(request => save(request));
  const id = newReportId('probe');
  deliver('probe', report(id));
  assert.equal(find(id).state, DELIVERED);
});

test('a pot keeps a bounded number of delivered reports', () => {
  for (let index = 0; index < 21; index += 1) deliver('probe', report(newReportId('probe')));
  const delivered = all().filter(request => request.pot === 'probe' && request.kind === REPORT);
  assert.equal(delivered.length, 20);
});

test('a report must carry hop 0', () => {
  const id = newReportId('probe');
  assert.throws(() => deliver('probe', `request ${id} 1\nBoundary probe: the job finished.\n`), Refusal);
  assert.equal(find(id), undefined);
});

test('a generated request nonce never spells a report', () => {
  assert.equal(parse(Buffer.from(report(newRequestId('probe')))).kind, REQUEST);
});
