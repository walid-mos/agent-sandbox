import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBoard, renderEvent } from './pr-board-render.mjs';
import { acceptBoard } from './pr-board-store.mjs';
import { sectionPackets, STALE_MS, DISCORD_LIMIT } from './pr-board-contract.mjs';

const now = Date.parse('2026-04-02T12:00:00Z');
const pull = { repository: 'demo/widget', number: 7, title: 'Synthetic change', workers: ['Fix forms'], githubState: 'draft', state: 'draft', createdAt: now - 3_600_000 };
const configuration = { enabled: true, sources: { alpha: ['demo/widget'], beta: [] } };
const empty = () => ({ sources: {}, events: {}, publisher: {}, discord: {} });
function received(pulls, at = now, initial = empty()) {
  return sectionPackets(pulls, at).reduce((state, packet) => acceptBoard(state, 'alpha', packet, configuration, now), initial);
}

test('rendering neutralizes remote Markdown, mentions, links and line breaks and keeps GitHub provenance', () => {
  const state = received([{ ...pull, title: '**@everyone** [click](https://evil.test)\n# forged', workers: ['<@12345> `worker`'] }]);
  const result = renderBoard(state, configuration, now).join('\n');
  assert.doesNotMatch(result, /@|evil\.test|\*\*@|\n# forged|<@/);
  assert.match(result, /<https:\/\/github.com\/demo\/widget\/pull\/7>/);
  assert.match(result, /GitHub draft/);
  assert.match(result, /alpha/);
  assert.match(result, /1h/);
});

test('a draft entry shows repo and PR, reported checks and hold, then a single link', () => {
  const state = received([{ ...pull, blockedUntil: '2026-04-03', factory: { stage: 'held', checks: 'passed' } }]);
  const text = renderBoard(state, configuration, now).join('\n');
  assert.match(text, /`demo\/widget` #7 Synthetic change\nGitHub draft · Factory held · checks passed · author hold until 2026-04-03 UTC\nalpha \/ Fix forms · 1h · <https:\/\/github.com\/demo\/widget\/pull\/7>/);
  assert.equal(text.match(/https:\/\//g)?.length, 1);
});

test('expired sections hide old rows and show the last publication time', () => {
  const text = renderBoard(received([pull]), configuration, now + STALE_MS + 1).join('\n');
  assert.doesNotMatch(text, /Synthetic change|pull\/7/);
  assert.match(text, /stale.*2026-04-02T12:00:00.000Z/);
  assert.match(text, /beta.*awaiting/);
});

test('large boards split without losing rows and stay within the Discord limit', () => {
  const pulls = Array.from({ length: 100 }, (_, index) => ({ ...pull, number: index + 1, title: 'Synthetic title '.repeat(12) }));
  const pages = renderBoard(received(pulls), configuration, now);
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.length <= DISCORD_LIMIT));
  const text = pages.join('\n');
  for (const item of pulls) assert.ok(text.includes(`/pull/${item.number}>`));
});

test('snapshots install atomically and replays cannot make old sections current', () => {
  const pulls = Array.from({ length: 13 }, (_, index) => ({ ...pull, number: index + 1 }));
  const packets = sectionPackets(pulls, now);
  let state = acceptBoard(empty(), 'alpha', packets[0], configuration, now);
  assert.equal(state.sources.alpha.current, undefined);
  state = acceptBoard(state, 'alpha', packets[1], configuration, now);
  assert.equal(state.sources.alpha.current.pulls.length, 13);
  state = received([], now - 1000, state);
  assert.equal(state.sources.alpha.current.pulls.length, 13);
  const broken = { ...sectionPackets([], now + 1)[0], snapshot: 'a'.repeat(64) };
  assert.throws(() => acceptBoard(state, 'alpha', broken, configuration, now), /digest/);
});

test('events are attributed claims with bounded verdicts and never imply merge permission', () => {
  const text = renderEvent({ pot: 'alpha', claim: { repository: 'demo/widget', number: 7, kind: 'verdict', verdict: 'FAIL', at: now } });
  assert.match(text, /alpha reports factory verdict FAIL/);
  assert.match(text, /<https:\/\/github.com\/demo\/widget\/pull\/7>/);
});
