import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { sandboxFixture } from '../probes/fixtures/sandbox.mjs';

const gitHome = process.env.HOME;
const { home } = sandboxFixture('worker-publication-');
const { command: realCommand } = await import('./run.mjs');
const github = [];
let canCreatePR = true;
mock.module('./run.mjs', { exports: { WITH_VAULT: '/unused', command(binary, args, options) {
  if (binary !== 'gh') return realCommand(binary, args, { ...options, env: { ...process.env, HOME: gitHome } });
  github.push(args);
  if (args[1] === 'create' && !canCreatePR) throw new Error('GitHub temporarily unavailable');
  return args[1] === 'list' ? '' : 'https://github.invalid/proof/repository/pull/1';
} } });
const { save, workers } = await import('./workers.mjs');
const { openDialog, answerQuestion } = await import('./human-dialogs.mjs');
const { humanStore } = await import('./human-store.mjs');
const { workerScope, publishWorker, openWorkerPR } = await import('./worker-publication.mjs');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, HOME: gitHome }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let sequence = 0;

function fixture() {
  const folder = join(home, `run-${++sequence}`);
  mkdirSync(folder);
  const remote = join(folder, 'origin.git');
  const checkout = join(folder, 'checkout');
  git(folder, 'init', '--bare', remote);
  git(folder, 'init', '-b', 'main', checkout);
  writeFileSync(join(checkout, 'base'), 'base\n');
  git(checkout, 'add', 'base');
  git(checkout, 'commit', '-m', 'test: base');
  git(checkout, 'remote', 'add', 'origin', remote);
  git(checkout, 'push', 'origin', 'main');
  git(checkout, 'checkout', '-b', 'feat/probe');
  git(checkout, 'commit', '--allow-empty', '-m', 'feat: bootstrap');
  const worker = { name: `proof-${sequence}`, kind: 'repository', owner: 'proof', repository: 'proof/repository',
    branch: 'feat/probe', base: 'main', title: 'feat: probe', worktree: checkout, originUrl: remote, publication: 'local' };
  save(worker);
  return { worker, remote, checkout };
}

async function approval(scope, label = 'Push once', shouldAnswer = true) {
  const dialog = await openDialog({ kind: 'question', source: { type: 'bot', message: `approval-${++sequence}` }, policy: 'push', scope,
    questions: [{ id: 'push', prompt: 'Publish these exact commits?', options: [{ label: 'Push once' }, { label: 'Keep local' }] }] });
  if (shouldAnswer) await answerQuestion(dialog.id, { answers: [{ id: 'push', labels: [label], text: '' }] });
  return dialog.id;
}

const remoteHeads = f => git(f.remote, 'for-each-ref', '--format=%(objectname)', 'refs/heads/feat/probe');

test('deferred publication rejects pending, negative and old bootstrap scopes without consuming or pushing', async () => {
  const f = fixture();
  const scope = workerScope([f.worker.name]).scope;
  for (const id of [await approval(scope, 'Push once', false), await approval(scope, 'Keep local'), await approval('Old empty-bootstrap startup scope')]) {
    await assert.rejects(publishWorker([f.worker.name, id, 'Push once']));
    assert.equal(humanStore().get(id).consumption, undefined);
    assert.equal(remoteHeads(f), '');
  }
});

test('implementation commits and changed origin require a new exact receipt', async () => {
  const f = fixture();
  const id = await approval(workerScope([f.worker.name]).scope);
  writeFileSync(join(f.checkout, 'implementation'), 'feature\n');
  git(f.checkout, 'add', 'implementation');
  git(f.checkout, 'commit', '-m', 'feat: implementation');
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /scope/);
  assert.equal(humanStore().get(id).consumption, undefined);
  assert.equal(remoteHeads(f), '');
  git(f.checkout, 'remote', 'set-url', 'origin', join(home, 'wrong-origin.git'));
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /origin/);
  assert.equal(humanStore().get(id).consumption, undefined);
});

test('a different or additional push URL refuses publication before consuming approval', async () => {
  const f = fixture();
  const id = await approval(workerScope([f.worker.name]).scope);
  const otherOrigin = join(f.checkout, '..', 'other-origin.git');
  git(home, 'init', '--bare', otherOrigin);
  git(f.checkout, 'remote', 'set-url', '--push', 'origin', otherOrigin);
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /push destination/);
  assert.equal(humanStore().get(id).consumption, undefined);
  git(f.checkout, 'remote', 'set-url', '--push', 'origin', f.remote);
  git(f.checkout, 'remote', 'set-url', '--add', '--push', 'origin', otherOrigin);
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /push destination/);
  git(f.checkout, 'config', '--unset-all', 'remote.origin.pushurl');
  git(f.checkout, 'config', `url.${otherOrigin}.pushInsteadOf`, f.remote);
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /push destination/);
  assert.equal(humanStore().get(id).consumption, undefined);
  assert.equal(remoteHeads(f), '');
  assert.equal(git(otherOrigin, 'for-each-ref', '--format=%(objectname)', 'refs/heads'), '');
});

test('one checked receipt pushes the exact first head and opens its draft without a second push', async () => {
  const f = fixture();
  const request = workerScope([f.worker.name]);
  const head = git(f.checkout, 'rev-parse', 'HEAD');
  assert.deepEqual(request.commits, [head]);
  const id = await approval(request.scope);
  await publishWorker([f.worker.name, id, 'Push once']);
  assert.equal(remoteHeads(f), head);
  assert.equal(humanStore().get(id).consumption.scope, request.scope);
  assert.equal(workers().find(worker => worker.name === f.worker.name).pullRequest, 'https://github.invalid/proof/repository/pull/1');
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']));
  assert.ok(github.some(args => args.includes('--draft')));
});

test('a failed push burns its receipt and cannot be retried by send or publication', async () => {
  const f = fixture();
  writeFileSync(join(f.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const id = await approval(workerScope([f.worker.name]).scope);
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']));
  assert.ok(humanStore().get(id).consumption);
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /already consumed/);
  assert.equal(remoteHeads(f), '');
});

test('failed draft creation retries only the PR and never pushes or consumes again', async () => {
  const f = fixture();
  const id = await approval(workerScope([f.worker.name]).scope);
  canCreatePR = false;
  try {
    await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /temporarily unavailable/);
  } finally {
    canCreatePR = true;
  }
  const consumption = humanStore().get(id).consumption;
  const head = remoteHeads(f);
  assert.equal(workers().find(worker => worker.name === f.worker.name).publication, 'awaiting-pr');
  writeFileSync(join(f.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  openWorkerPR([f.worker.name]);
  assert.equal(remoteHeads(f), head);
  assert.deepEqual(humanStore().get(id).consumption, consumption);
  assert.equal(workers().find(worker => worker.name === f.worker.name).publication, 'published');
});

test('an existing remote task branch cannot be overwritten even with an answered receipt', async () => {
  const f = fixture();
  const id = await approval(workerScope([f.worker.name]).scope);
  git(f.checkout, 'push', 'origin', `main:refs/heads/${f.worker.branch}`);
  const head = remoteHeads(f);
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /already exists/);
  assert.equal(remoteHeads(f), head);
  assert.equal(humanStore().get(id).consumption, undefined);
});

test('a fresh base change invalidates approval before consumption', async () => {
  const f = fixture();
  const id = await approval(workerScope([f.worker.name]).scope);
  git(f.checkout, 'checkout', 'main');
  git(f.checkout, 'commit', '--allow-empty', '-m', 'test: moved base');
  git(f.checkout, 'push', 'origin', 'main');
  git(f.checkout, 'checkout', f.worker.branch);
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /fresh base/);
  assert.equal(remoteHeads(f), '');
  assert.equal(humanStore().get(id).consumption, undefined);
});

test('a commit made during receipt consumption aborts publication before its first push', async () => {
  const f = fixture();
  const id = await approval(workerScope([f.worker.name]).scope);
  const store = humanStore();
  const changingStore = { ...store, async locked(...arguments_) {
    const receipt = await store.locked(...arguments_);
    git(f.checkout, 'commit', '--allow-empty', '-m', 'test: concurrent commit');
    return receipt;
  } };
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once'], changingStore), /changed after consumption/);
  assert.ok(store.get(id).consumption);
  assert.equal(remoteHeads(f), '');
});

test('non-repository tasks cannot enter either publication operation', async () => {
  const name = 'nonrepo';
  save({ name, kind: 'task', owner: 'proof', worktree: home });
  assert.throws(() => workerScope([name]), /repository/);
  await assert.rejects(publishWorker([name, 'unused', 'Push once']), /repository/);
  assert.throws(() => openWorkerPR([name]), /repository/);
});
