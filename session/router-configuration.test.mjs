import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureCredentialBytes, requireCredentialBytesEqual } from './router-configuration.mjs';

function stores(t) {
  const root = mkdtempSync(join(tmpdir(), 'router-credential-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = { magpieDirectory: join(root, 'magpie'), managedCodexHome: join(root, 'managed'), nativeCodexHome: join(root, 'native') };
  for (const directory of Object.values(paths)) mkdirSync(directory, { mode: 0o700 });
  for (const [directory, name, content] of [
    [paths.magpieDirectory, 'providers.json', '{"token":"fixture"}\n'],
    [paths.magpieDirectory, 'logins.json', '{"subscription":"fixture"}\n'],
    [paths.managedCodexHome, 'auth.json', '{ "tokens": {"access_token":"fixture"}}\n'],
    [paths.nativeCodexHome, 'auth.json', '{"tokens":{"access_token":"native-fixture"}}\n'],
  ]) {
    const path = join(directory, name);
    writeFileSync(path, content, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return paths;
}

test('local credential preservation compares original bytes without parsing or exporting them', t => {
  const paths = stores(t);
  const before = captureCredentialBytes(paths);
  const after = captureCredentialBytes(paths);
  assert.equal(requireCredentialBytesEqual(before, after), true);
  writeFileSync(join(paths.nativeCodexHome, 'auth.json'), '{ "tokens":{"access_token":"native-fixture"}}\n', { mode: 0o600 });
  assert.throws(() => requireCredentialBytesEqual(before, captureCredentialBytes(paths)), /credential state changed/u);
  const whitespaceChanged = captureCredentialBytes(paths);
  writeFileSync(join(paths.nativeCodexHome, 'auth.json'), '{ "tokens":{"access_token":"refreshed-fixture"}}\n', { mode: 0o600 });
  assert.throws(() => requireCredentialBytesEqual(whitespaceChanged, captureCredentialBytes(paths)), /credential state changed/u);
});

test('local credential preservation refuses added and removed stores', t => {
  const paths = stores(t);
  const before = captureCredentialBytes(paths);
  const added = new Map(before);
  added.set('magpie/new-login.json', Buffer.from('{}'));
  const removed = new Map(before);
  removed.delete('magpie/logins.json');
  assert.throws(() => requireCredentialBytesEqual(before, added), /credential state changed/u);
  assert.throws(() => requireCredentialBytesEqual(before, removed), /credential state changed/u);
  unlinkSync(join(paths.magpieDirectory, 'logins.json'));
  assert.throws(() => captureCredentialBytes(paths), /credential scope is incomplete/u);
  writeFileSync(join(paths.magpieDirectory, 'logins.json'), '{}', { mode: 0o600 });
  chmodSync(join(paths.nativeCodexHome, 'auth.json'), 0o644);
  assert.throws(() => captureCredentialBytes(paths), /credential scope is incomplete/u);
});
