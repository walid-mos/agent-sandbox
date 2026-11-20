import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectPulls } from './pr-board-source.mjs';

const now = Date.parse('2026-04-02T12:00:00Z');
const pull = { number: 7, title: 'Synthetic task', draft: false, head: { sha: 'a'.repeat(40), ref: 'feat/task' }, created_at: '2026-04-01T00:00:00Z', merged_at: null };
const worker = { name: 'worker-one', repository: 'demo/widget', branch: 'feat/task', pullRequest: 'https://github.com/demo/widget/pull/7', title: 'Task worker', sessionFile: '/synthetic/session-one.jsonl' };
const reads = [];
function sources(changes = {}) {
  return { workers: () => [worker], dialogs: () => [], factory: () => [], isStopped: () => false,
    watched: () => ['demo/widget'], pulls: repository => { reads.push(repository); return [pull]; }, owners: ['demo'], ...changes };
}

test('collector includes worker repositories and factory repositories only through owning credentials', () => {
  reads.length = 0;
  const result = collectPulls(sources({ workers: () => [worker, { ...worker, name: 'second', repository: 'demo/second', branch: 'feat/second', pullRequest: 'https://github.com/demo/second/pull/7' }, { ...worker, repository: 'foreign/private' }] }), now);
  assert.deepEqual(reads.sort(), ['demo/second', 'demo/widget']);
  assert.equal(result.length, 2);
  assert.equal(result.find(item => item.repository === 'demo/widget').workers[0], 'Task worker');
  assert.equal(result[0].state, 'ready');
});

test('only a matching pending human dialog overrides GitHub with waiting for Walid', () => {
  const dialog = { kind: 'question', id: 'b'.repeat(32), source: { type: 'worker', worker: worker.name, session: worker.sessionFile } };
  const waiting = collectPulls(sources({ dialogs: () => [dialog] }), now)[0];
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.githubState, 'ready');
  assert.deepEqual(waiting.evidence, { kind: 'human-dialog' });
  assert.equal(collectPulls(sources({ dialogs: () => [{ ...dialog, result: { status: 'answered' } }] }), now)[0].state, 'ready');
  assert.equal(collectPulls(sources({ dialogs: () => [{ ...dialog, source: { ...dialog.source, session: 'old-session' } }] }), now)[0].state, 'ready');
  assert.equal(collectPulls(sources({ dialogs: () => [{ ...dialog, kind: 'secret' }] }), now)[0].state, 'ready');
});

test('a fork with the same branch does not inherit an unlinked worker hold', () => {
  const source = sources({ workers: () => [{ ...worker, pullRequest: undefined }], isStopped: () => true,
    pulls: () => [{ ...pull, head: { ...pull.head, repo: { full_name: 'foreign/widget' } } }] });
  const [row] = collectPulls(source, now);
  assert.deepEqual(row.workers, []);
  assert.equal(row.state, 'ready');
});

test('recorded holds and current-head factory stops override state but stale records do not', () => {
  assert.equal(collectPulls(sources({ isStopped: () => true }), now)[0].state, 'blocked');
  const record = { repository: 'demo/widget', number: 7, head: pull.head.sha, stage: 'checks-failed' };
  assert.equal(collectPulls(sources({ factory: () => [record] }), now)[0].state, 'blocked');
  assert.equal(collectPulls(sources({ factory: () => [{ ...record, head: 'c'.repeat(40) }] }), now)[0].state, 'ready');
});

test('projects only bounded Factory facts from the current head even while a worker is held', () => {
  const record = { repository: 'demo/widget', number: 7, head: pull.head.sha, stage: 'checks-failed', checks: [{ isPassed: false, log: '/private/check.log' }], note: 'private note' };
  const [row] = collectPulls(sources({ factory: () => [record], isStopped: () => true }), now);
  assert.deepEqual(row.factory, { stage: 'checks-failed', checks: 'failed' });
  assert.deepEqual(row.evidence, { kind: 'worker-hold' });
  assert.equal(collectPulls(sources({ factory: () => [{ ...record, head: 'c'.repeat(40) }] }), now)[0].factory, undefined);
});

test('an active draft marker sends its date without its body or reason and expires at midnight UTC', () => {
  const draft = { ...pull, draft: true, body: 'BLOCKED UNTIL: 2026-04-03 — private reason' };
  const source = sources({ pulls: () => [draft] });
  const [row] = collectPulls(source, now);
  assert.equal(row.blockedUntil, '2026-04-03');
  assert.equal(row.state, 'draft');
  assert.doesNotMatch(JSON.stringify(row), /private reason/);
  assert.equal(collectPulls(source, Date.parse('2026-04-03T00:00:00Z'))[0].blockedUntil, undefined);
  assert.equal(collectPulls(sources({ pulls: () => [{ ...draft, draft: false }] }), now)[0].blockedUntil, undefined);
});

test('merged today follows UTC and ignores local exceptional states for merged pulls', () => {
  const merged = { ...pull, merged_at: '2026-04-02T00:00:00Z' };
  assert.equal(collectPulls(sources({ pulls: () => [merged], isStopped: () => true }), now)[0].state, 'merged-today');
  assert.deepEqual(collectPulls(sources({ pulls: () => [{ ...merged, merged_at: '2026-04-01T23:59:59Z' }] }), now), []);
});
