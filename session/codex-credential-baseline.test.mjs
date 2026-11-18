import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { codexProcessFixture } from '../probes/fixtures/codex-process.mjs';
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

function publicTransferFixture(t) {
  const fixture = codexProcessFixture(t);
  const recoveryDirectory = join(fixture.directory, 'restore');
  mkdirSync(recoveryDirectory, { mode: 0o700 });
  const expected = fixture.candidate;
  writeFileSync(join(fixture.directory, 'providers.json'), JSON.stringify(expected.providers), { mode: 0o600 });
  writeFileSync(join(fixture.directory, 'settings.json'), JSON.stringify(expected.settings), { mode: 0o600 });
  const expectedPath = join(recoveryDirectory, 'expected.json');
  writeFileSync(expectedPath, JSON.stringify(expected), { mode: 0o600 });
  const environment = { HOME: fixture.env.HOME, CODEX_HOME: fixture.env.CODEX_HOME, PATH: fixture.env.PATH };
  const run = action => spawnSync(process.execPath, [resolve('session/router-codex-transfer.mjs'), action, expectedPath], {
    encoding: 'utf8', env: environment,
  });
  return {
    directory: fixture.directory,
    managedCredentialPath: join(fixture.env.HOME, '.local/state/agent-sandbox/codex/auth.json'),
    nativeCredentialPath: join(fixture.env.CODEX_HOME, 'auth.json'),
    run,
  };
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

test('public recovery transfer captures and compares synthetic credentials through its advertised actions', t => {
  const fixture = publicTransferFixture(t);
  const baselineDirectory = join(fixture.directory, 'recovery-credential-baseline');
  const capture = fixture.run('capture-recovery-credentials');
  assert.equal(capture.status, 0, capture.stderr);
  assert.match(capture.stdout, /private recovery credential baseline retained locally/u);
  assert.deepEqual(readdirSync(baselineDirectory).toSorted(), [
    'magpie--logins.json', 'managed-codex--auth.json', 'native-codex--auth.json',
  ]);
  const credentials = [
    ['magpie--logins.json', join(fixture.directory, 'logins.json')],
    ['managed-codex--auth.json', fixture.managedCredentialPath],
    ['native-codex--auth.json', fixture.nativeCredentialPath],
  ];
  for (const [baselineName, credentialPath] of credentials) {
    assert.deepEqual(readFileSync(join(baselineDirectory, baselineName)), readFileSync(credentialPath));
  }
  assert.equal(fixture.run('compare-recovery-credentials').status, 0);
  const inspection = fixture.run('inspect-recovery');
  assert.equal(inspection.status, 0, inspection.stderr);
  assert.match(inspection.stdout, /configuration equal/u);
  writeFileSync(join(fixture.directory, 'logins.json'), '{ "fixture": "changed" }\n', { mode: 0o600 });
  const comparison = fixture.run('compare-recovery-credentials');
  assert.equal(comparison.status, 1);
  assert.match(comparison.stderr, /credential state changed/u);
  assert.doesNotMatch(`${comparison.stdout}${comparison.stderr}`, /fixture-key|synthetic-a/u);
});
