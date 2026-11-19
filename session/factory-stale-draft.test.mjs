import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staleDraftWakeId } from './factory-stale-draft.mjs';

const now = Date.parse('2026-11-19T12:00:00Z');
const draft = {
  repository: 'example/fixture', number: 37, headRefOid: 'a'.repeat(40), isDraft: true,
  createdAt: '2026-11-18T11:59:59Z', lastEditedAt: null, title: 'Fixture change', body: '',
};

for (const [requirement, body, isWoken] of [
  ['a future marker with a reason delays the wake', 'Details\r\nBLOCKED UNTIL: 2026-11-20 — Waiting for access\r\nNext step', false],
  ['a valid marker stops delaying at midnight UTC', 'BLOCKED UNTIL: 2026-11-19 — Waiting for access', true],
  ['a date with a blank reason does not delay', 'BLOCKED UNTIL: 2026-11-20 — \t ', true],
  ['a reason without a date does not delay', 'BLOCKED UNTIL: Waiting for access', true],
  ['an impossible calendar date does not delay', 'BLOCKED UNTIL: 2026-11-31 — Waiting for access', true],
  ['a non-ISO date does not delay', 'BLOCKED UNTIL: 2026-11-2 — Waiting for access', true],
  ['an inline or quoted marker does not delay', 'Example BLOCKED UNTIL: 2026-11-20 — Waiting\n> BLOCKED UNTIL: 2026-11-20 — Waiting', true],
]) {
  test(requirement, () => assert.equal(Boolean(staleDraftWakeId({ ...draft, body }, now)), isWoken));
}

test('an unreasoned draft wakes only once it is older than 24 hours', () => {
  assert.equal(staleDraftWakeId({ ...draft, createdAt: '2026-11-18T12:00:01Z' }, now), undefined);
  assert.equal(staleDraftWakeId({ ...draft, createdAt: '2026-11-18T12:00:00Z' }, now), undefined);
  assert.match(staleDraftWakeId(draft, now), /^pr-factory-stale-draft-[0-9a-f]{64}$/);
});

test('a ready pull request is never considered stale', () => {
  assert.equal(staleDraftWakeId({ ...draft, isDraft: false }, now), undefined);
});

test('scanning again and unrelated GitHub activity keep the same wake ID', () => {
  const first = staleDraftWakeId(draft, now);
  const next = Date.parse('2026-11-19T12:05:00Z');
  assert.ok(first);
  assert.equal(staleDraftWakeId({ ...draft, updatedAt: '2026-11-19T12:01:00Z' }, next), first);
});

test('a text edit or a new head re-arms the wake', () => {
  const first = staleDraftWakeId(draft, now);
  assert.notEqual(staleDraftWakeId({ ...draft, body: 'Status changed' }, now), first);
  assert.notEqual(staleDraftWakeId({ ...draft, title: 'New title' }, now), first);
  assert.notEqual(staleDraftWakeId({ ...draft, lastEditedAt: '2026-11-19T11:00:00Z' }, now), first);
  assert.notEqual(staleDraftWakeId({ ...draft, headRefOid: 'b'.repeat(40) }, now), first);
});

test('expiry makes a blocked draft eligible for one stable wake', () => {
  const blocked = { ...draft, body: 'BLOCKED UNTIL: 2026-11-20 — Waiting for access' };
  const deadline = Date.parse('2026-11-20T00:00:00Z');
  assert.equal(staleDraftWakeId(blocked, deadline - 1), undefined);
  const first = staleDraftWakeId(blocked, deadline);
  assert.ok(first);
  assert.equal(staleDraftWakeId(blocked, Date.parse('2026-11-20T00:05:00Z')), first);
});
