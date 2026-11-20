import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sealSnapshot, openSnapshot } from './router-codex-transfer.mjs';
import { codexProcessFixture } from '../probes/fixtures/codex-process.mjs';

const SYNTHETIC_KEY = 'b'.repeat(64);

test('private transport emits ciphertext and authenticated tampering refuses without disclosing the snapshot', () => {
  const envelope = sealSnapshot({ credentials: 'synthetic-private-value' }, SYNTHETIC_KEY);
  assert.doesNotMatch(JSON.stringify(envelope), /synthetic-private-value/u);
  assert.deepEqual(openSnapshot(envelope, SYNTHETIC_KEY), { credentials: 'synthetic-private-value' });
  envelope.tag = Buffer.alloc(16).toString('base64');
  assert.throws(() => openSnapshot(envelope, SYNTHETIC_KEY), /private transfer unreadable/u);
});

test('public versioned runner refuses its incomplete template before processes or requests can run', t => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-template-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const review = join(directory, 'review.json');
  writeFileSync(review, readFileSync('resources/codex-targeted-v1/review.template.json'), { mode: 0o600 });
  for (const operation of ['plan', 'execute']) {
    const result = spawnSync(process.execPath, ['session/codex-rollout.mjs', operation, review], { encoding: 'utf8', env: { ...process.env, HOME: directory } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /parentApproval .*absent/u);
    assert.doesNotMatch(result.stdout, /MODEL: COMPLETE|all healthy/u);
  }
});

test('private configuration shell metacharacters stay literal through the public restore process', t => {
  const fixture = codexProcessFixture(t);
  const planted = join(fixture.directory, 'planted');
  const annotation = `$(touch ${planted})`;
  fixture.candidate.settings.annotation = annotation;
  const settings = JSON.parse(readFileSync(join(fixture.directory, 'settings.json')));
  settings.annotation = annotation;
  writeFileSync(join(fixture.directory, 'settings.json'), JSON.stringify(settings));
  writeFileSync(fixture.source, JSON.stringify(fixture.candidate));
  writeFileSync(fixture.seed, JSON.stringify(fixture.candidate));
  const result = spawnSync(process.execPath, [fixture.entry, fixture.seed, fixture.source, fixture.journal], {
    env: fixture.env, encoding: 'utf8', input: 'a'.repeat(48) + '\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(planted), false);
  assert.equal(JSON.parse(readFileSync(join(fixture.directory, 'settings.json'))).annotation, annotation);
});
