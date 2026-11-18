import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureCredentialBaseline, compareCredentialBaseline } from './codex-credential-baseline.mjs';

const credentialBytes = () => new Map([
  ['magpie/logins.json', Buffer.from('{"token":"synthetic-a"}\n')],
  ['managed-codex/auth.json', Buffer.from('{"token":"synthetic-b"}\n')],
  ['native-codex/auth.json', Buffer.from('{"token":"synthetic-c"}\n')],
]);

function baselineFixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'codex-credential-baseline-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return join(parent, 'recovery-credential-baseline');
}

test('private recovery baseline retains exact raw credential bytes for later comparison', t => {
  const directory = baselineFixture(t);
  const baseline = credentialBytes();
  assert.equal(captureCredentialBaseline(directory, () => baseline), true);
  assert.equal(compareCredentialBaseline(directory, () => credentialBytes()), true);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, 'magpie--logins.json')).mode & 0o777, 0o600);
});

test('private recovery baseline refuses any credential byte mutation', t => {
  const directory = baselineFixture(t);
  captureCredentialBaseline(directory, () => credentialBytes());
  const changed = credentialBytes();
  changed.set('magpie/logins.json', Buffer.from('{"token":"synthetic-a "}\n'));
  assert.throws(() => compareCredentialBaseline(directory, () => changed), /credential state changed/u);
});
