import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'worker-admission-'));
after(() => rmSync(root, { recursive: true, force: true }));
const control = join(root, 'control');
const lock = join(control, 'admission.lock');
const marker = join(root, 'revision');
mkdirSync(control);
writeFileSync(lock, '');
writeFileSync(marker, 'revision-a\n');
const session = join(root, 'session');
cpSync(import.meta.dirname, session, { recursive: true });
writeFileSync(join(session, 'launch.env'), `POTS_ADMISSION=${control}\nPOTS_RELEASE_ID=${marker}\n`);
const moduleURL = name => pathToFileURL(join(session, `${name}.mjs`));
const { withAdmission, AdmissionDeferred } = await import(moduleURL('admission'));
process.env.HOME = root;
mock.module(moduleURL('sandbox'), { exports: { botId: 'fixture', sandbox: { maxWorkers: 1 } } });
const calls = [];
mock.module(moduleURL('run'), { exports: { WITH_VAULT: '/fixture/with-vault', failureReason: () => '', command(binary, args) {
  calls.push([binary, args]);
  if (binary === 'pi') return '';
  if (binary === 'hc' && args[0] === 'get') return '{"address":"fixture-terminal"}';
  return '';
} } });
const { launch, openTerminal, save } = await import(moduleURL('workers'));
const { enqueue, queued } = await import(moduleURL('queue'));
const { serveQueue } = await import(moduleURL('serve-queue'));

function status(phase, revision) {
  writeFileSync(join(control, 'status.json'), JSON.stringify({ phase, known_good: revision, loaded: revision }));
}

function exclusive(descriptor) {
  return spawnSync('flock', ['--exclusive', '--nonblock', '3'], {
    stdio: ['ignore', 'ignore', 'ignore', descriptor],
  }).status;
}

function withLock(verify) {
  const descriptor = openSync(lock, 'r');
  try {
    verify(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

test('worker admission keeps its shared lock until launch completes', () => {
  status('ready', 'revision-a');
  withAdmission(() => withLock(descriptor => assert.equal(exclusive(descriptor), 1)));
  withLock(descriptor => assert.equal(exclusive(descriptor), 0));
});

test('worker admission defers while switching, while the lock is held, and on stale mounts', () => {
  const attempt = () => withAdmission(() => assert.fail('admission ran queued work'));
  status('switching', 'revision-a');
  assert.throws(attempt, AdmissionDeferred);
  status('ready', 'revision-b');
  assert.throws(attempt, AdmissionDeferred);
  status('ready', 'revision-a');
  withLock(descriptor => {
    assert.equal(exclusive(descriptor), 0);
    assert.throws(attempt, AdmissionDeferred);
  });
});

test('queued fresh work survives deferral and resumes through the same gate as saved work and clean passes', () => {
  const worker = { name: 'queued-worker', owner: 'fixture', repository: 'fixture/project', worktree: root, brief: '/fixture/brief' };
  const saved = join(root, 'worker.jsonl');
  writeFileSync(saved, '{"type":"session","id":"saved"}\n');
  save(worker);
  enqueue({ worker: worker.name });
  const retryDelay = 37;
  const admission = { check: () => undefined, attempted: () => retryDelay };
  status('switching', 'revision-a');
  assert.equal(serveQueue([], assert.fail, admission), retryDelay);
  assert.deepEqual(queued().map(item => item.worker), [worker.name]);
  assert.throws(() => launch({ ...worker, sessionFile: saved }, []), AdmissionDeferred);
  assert.throws(() => openTerminal({ name: 'clean-pass', cwd: root, label: 'pots.pass=review', vaultCommand: [] }), AdmissionDeferred);
  assert.deepEqual(calls, []);
  status('ready', 'revision-a');
  assert.equal(serveQueue([], assert.fail, admission), retryDelay);
  assert.deepEqual(queued(), []);
  assert.equal(calls.filter(([command, args]) => command === 'hc' && args[0] === 'run').length, 1);
});
