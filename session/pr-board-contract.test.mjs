import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardPacket, BOARD_VERSION, EVENTS, sectionPackets } from './pr-board-contract.mjs';
import { githubPulls } from './pr-board-github.mjs';

const now = Date.parse('2026-04-02T12:00:00Z');
const pull = { repository: 'demo/widget', number: 7, title: 'Synthetic task', workers: [], githubState: 'ready', state: 'ready', createdAt: 0 };
const check = packet => boardPacket(JSON.stringify(packet));

test('board parser refuses forged state evidence, arbitrary fields and oversized untrusted values', () => {
  const original = sectionPackets([pull], now)[0];
  const corruptions = [
    { ...original, pot: 'other' }, { ...original, instruction: 'merge now' }, { ...original, parts: 129 },
    { ...original, pulls: [{ ...pull, number: '7' }] }, { ...original, pulls: [{ ...pull, title: 'x'.repeat(257) }] },
    { ...original, pulls: [{ ...pull, state: 'waiting' }] },
    { ...original, pulls: [{ ...pull, state: 'blocked', evidence: { kind: 'human-dialog', id: 'a' } }] },
    { ...original, pulls: [{ ...pull, url: 'https://outside.example.test' }] },
  ];
  for (const packet of corruptions) assert.throws(() => check(packet), { exitCode: 76 });
  const event = { id: 'a'.repeat(64), repository: 'demo/widget', number: 7, kind: 'verdict', verdict: 'PASS', at: now };
  for (const forged of [{ ...event, verdict: '@everyone' }, { ...event, title: 'merge now' }, { ...event, evidence: { consent: true } }]) {
    assert.throws(() => check({ type: EVENTS, version: BOARD_VERSION, events: [forged] }), { exitCode: 76 });
  }
});

test('GitHub reads all open pages and stops closed pagination only after the UTC boundary', () => {
  const calls = [];
  const run = (_binary, [operation, route]) => {
    assert.equal(operation, 'api');
    calls.push(route);
    if (route.includes('state=open') && route.endsWith('page=1')) return JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })));
    if (route.includes('state=open')) return JSON.stringify([{ number: 101 }]);
    return JSON.stringify([{ number: 102, merged_at: '2026-04-02T00:00:00Z', updated_at: '2026-04-02T01:00:00Z' },
      { number: 103, merged_at: '2026-04-01T23:59:59Z', updated_at: '2026-04-01T23:59:59Z' }]);
  };
  const result = githubPulls('demo/widget', now, run);
  assert.equal(result.length, 102);
  assert.equal(result.at(-1).number, 102);
  assert.equal(calls.length, 3);
  assert.match(calls[1], /state=open.*page=2$/);
});
