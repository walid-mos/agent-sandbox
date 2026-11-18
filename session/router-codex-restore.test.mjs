import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { codexProcessFixture } from '../probes/fixtures/codex-process.mjs';

const restore = fixture => spawnSync(process.execPath, [fixture.entry, fixture.seed, fixture.source, fixture.journal], {
  env: fixture.env, encoding: 'utf8', input: 'a'.repeat(48) + '\n',
});
const events = fixture => readFileSync(join(fixture.journal, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('configuration-only public restore preserves credentials and standard wires and never sends an answer or vault sync', t => {
  const fixture = codexProcessFixture(t);
  const result = restore(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /configuration restored and compared, no health requests sent. Claude DEFERRED/u);
  assert.doesNotMatch(result.stdout, /MODEL: COMPLETE|all healthy|fixture-key|fixture-only/u);
  assert.equal(JSON.parse(readFileSync(join(fixture.directory, 'providers.json'))).groups[2].members[0], 'codex/gpt-6.2-sol:high#original');
  assert.equal(statSync(join(fixture.journal, 'before.json')).mode & 0o777, 0o600);
  assert.deepEqual(events(fixture).map(event => [event.step, event.state]), [
    ['private-backup', 'INTENT'], ['private-backup', 'CONFIRMED'], ['restore-configuration', 'INTENT'], ['restore-configuration', 'CONFIRMED'],
  ]);
  assert.equal(readFileSync(join(fixture.directory, 'calls'), 'utf8').includes('sync'), false);
  assert.equal(restore(fixture).status, 1);
  assert.equal(readFileSync(join(fixture.directory, 'calls'), 'utf8').split('\n').filter(command => command === 'restore').length, 1);
});

test('source binding drift refuses the public restore before backup or mutation', t => {
  const fixture = codexProcessFixture(t);
  fixture.candidate.providers.accountBindings.codex = '/replacement';
  writeFileSync(fixture.source, JSON.stringify(fixture.candidate));
  const result = restore(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /incompatible/u);
  assert.equal(existsSync(fixture.journal), false);
  assert.doesNotMatch(readFileSync(join(fixture.directory, 'calls'), 'utf8'), /backup|restore/u);
});

test('interrupted mutation leaves durable INTENT as UNKNOWN and cannot relaunch a completed prefix', t => {
  const fixture = codexProcessFixture(t);
  writeFileSync(join(fixture.directory, 'failure'), 'interrupt');
  const result = restore(fixture);
  assert.equal(result.signal, 'SIGKILL');
  assert.deepEqual(events(fixture).at(-1).state, 'INTENT');
  assert.equal(events(fixture).at(-1).step, 'restore-configuration');
  assert.equal(restore(fixture).status, 1);
  assert.equal(readFileSync(join(fixture.directory, 'calls'), 'utf8').split('\n').filter(command => command === 'restore').length, 1);
});

test('postrestore drift records UNKNOWN, retains private backups and performs one bounded read-only inspection without retry', t => {
  const fixture = codexProcessFixture(t);
  writeFileSync(join(fixture.directory, 'failure'), 'drift');
  const result = restore(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /restore-configuration failed/u);
  assert.equal(events(fixture).find(event => event.step === 'restore-configuration' && event.state === 'UNKNOWN').state, 'UNKNOWN');
  assert.equal(existsSync(join(fixture.journal, 'failure-inspection.json')), true);
  assert.equal(existsSync(join(fixture.journal, 'before.magpie-backup')), true);
  assert.equal(readFileSync(join(fixture.directory, 'calls'), 'utf8').split('\n').filter(command => command === 'restore').length, 1);
});
