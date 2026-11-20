import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openJobs } from './factory-jobs.mjs';

const pull = { repository: 'example/fixture', number: 31, head: 'a'.repeat(40), base: 'main', baseTip: 'b'.repeat(40), transition: '', mergeable: 'MERGEABLE' };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'factory-jobs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return () => openJobs(directory);
}

test('repeated discovery and a replacement controller see the same live run and durable result', t => {
  const open = fixture(t);
  const controller = open();
  const job = controller.observe(pull);
  assert.equal(controller.claim(job.id), true);
  controller.progress(job.id, 'checking', { step: 'build' });
  controller.close();

  const successor = open();
  t.after(() => successor.close());
  assert.equal(successor.observe(pull).id, job.id);
  assert.equal(successor.claim(job.id), false);
  const events = successor.events(0);
  assert.deepEqual(events.map(event => event.type), ['queued', 'running', 'checking']);
  assert.equal(successor.finish(job.id, 'complete', { checks: [{ name: 'build', isPassed: true }] }), true);
  assert.deepEqual(successor.events(events.at(-1).id).map(event => event.type), ['complete']);
  assert.deepEqual(successor.get(job.id).result, { checks: [{ name: 'build', isPassed: true }] });
});

test('a worker lost after claiming fences later generations for that PR only', t => {
  const jobs = fixture(t)();
  t.after(() => jobs.close());
  const first = jobs.observe(pull);
  jobs.claim(first.id);
  assert.equal(jobs.finish(first.id, 'uncertain', { reason: 'runner disappeared' }), true);
  const next = jobs.observe({ ...pull, head: 'c'.repeat(40) });
  assert.equal(jobs.claim(next.id), false);
  assert.equal(jobs.claim(jobs.observe({ ...pull, number: 32 }).id), true);
  assert.equal(jobs.get(first.id).status, 'uncertain');
});

test('a changed base or same-head review transition replaces the active generation', t => {
  const jobs = fixture(t)();
  t.after(() => jobs.close());
  const first = jobs.observe(pull);
  const moved = jobs.observe({ ...pull, baseTip: 'c'.repeat(40) });
  const ready = jobs.observe({ ...pull, baseTip: 'c'.repeat(40), transition: 'ready-again' });
  assert.equal(jobs.claim(first.id), false);
  assert.equal(jobs.claim(moved.id), false);
  assert.equal(jobs.claim(ready.id), true);
  assert.deepEqual(jobs.current(pull), ready.id);
});
