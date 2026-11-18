import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { approval, fixture, git, github, githubState, home, humanStore, openWorkerPR, publishWorker, remoteHeads, save, workers, workerScope } from '../probes/fixtures/worker-publication.mjs';

test('deferred publication rejects pending, negative and old bootstrap scopes without consuming or pushing', async () => {
  const f = fixture();
  const scope = workerScope([f.worker.name]).scope;
  for (const id of [await approval(scope, { isPending: true }), await approval(scope, { label: 'Keep local' }), await approval('Old empty-bootstrap startup scope')]) {
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
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /remote readback did not prove/);
  assert.equal(remoteHeads(f), '');
});

test('an uncertain push response recovers only after exact destination readback and does not push twice', async () => {
  const f = fixture();
  const request = workerScope([f.worker.name]);
  const id = await approval(request.scope);
  const pushes = githubState.pushAttempts;
  const draftURL = 'https://github.invalid/proof/repository/pull/2';
  githubState.afterPush = { url: f.remote, action: () => { githubState.afterPush = undefined; throw new Error('push acknowledgement was lost'); } };
  githubState.pullRequests = [{ url: draftURL, isCrossRepository: false, baseRefName: f.worker.base,
    headRefName: f.worker.branch, isDraft: true, headRefOid: request.head }];
  try {
    assert.equal(await publishWorker([f.worker.name, id, 'Push once']), draftURL);
  } finally {
    githubState.afterPush = undefined;
    githubState.pullRequests = [];
  }
  assert.equal(remoteHeads(f), request.head);
  assert.equal(githubState.pushAttempts, pushes + 1);
  assert.equal(workers().find(worker => worker.name === f.worker.name).publication, 'published');
  assert.equal(humanStore().get(id).consumption.scope, request.scope);
});

test('a later invocation recovers an already consumed receipt after exact remote readback', async () => {
  const f = fixture();
  const request = workerScope([f.worker.name]);
  const id = await approval(request.scope);
  const pushes = githubState.pushAttempts;
  githubState.afterPush = { url: f.remote, action: () => { githubState.afterPush = undefined; throw new Error('push acknowledgement was lost'); } };
  githubState.readback = { url: f.remote, afterPush: pushes + 1, respond: () => { throw new Error('readback unavailable'); } };
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /exact remote readback did not prove recovery/);
  assert.equal(remoteHeads(f), request.head);
  const consumed = humanStore().get(id).consumption;
  assert.equal(workers().find(worker => worker.name === f.worker.name).publication, 'local');
  git(f.checkout, 'checkout', 'main');
  git(f.checkout, 'commit', '--allow-empty', '-m', 'test: moved base after uncertain push');
  git(f.checkout, 'push', 'origin', 'main');
  git(f.checkout, 'checkout', f.worker.branch);
  await publishWorker([f.worker.name, id, 'Push once']);
  assert.equal(githubState.pushAttempts, pushes + 1);
  assert.equal(workers().find(worker => worker.name === f.worker.name).publication, 'published');
  assert.deepEqual(humanStore().get(id).consumption, consumed);
});

test('an uncertain push with a different destination ref stops for inspection', async () => {
  const f = fixture();
  const id = await approval(workerScope([f.worker.name]).scope);
  githubState.beforePush = { url: f.remote, action: () => {
    githubState.beforePush = undefined;
    git(f.checkout, 'push', 'origin', `main:refs/heads/${f.worker.branch}`);
  } };
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /exact remote readback did not prove recovery/);
  assert.equal(remoteHeads(f), git(f.checkout, 'rev-parse', 'main'));
  assert.equal(workers().find(worker => worker.name === f.worker.name).publication, 'local');
  assert.ok(humanStore().get(id).consumption);
});

test('an unverifiable remote readback never records recovery or retries the push', async () => {
  const f = fixture();
  writeFileSync(join(f.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const id = await approval(workerScope([f.worker.name]).scope);
  const pushes = githubState.pushAttempts;
  githubState.readback = { url: f.remote, afterPush: pushes + 1, respond: () => { throw new Error('readback unavailable'); } };
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /exact remote readback did not prove recovery/);
  assert.equal(remoteHeads(f), '');
  assert.equal(githubState.pushAttempts, pushes + 1);
  assert.equal(workers().find(worker => worker.name === f.worker.name).publication, 'local');
  assert.ok(humanStore().get(id).consumption);
});

test('uncertain publication refuses a matching commit reported for a different ref', async () => {
  const f = fixture();
  const request = workerScope([f.worker.name]);
  const id = await approval(request.scope);
  const pushes = githubState.pushAttempts;
  githubState.afterPush = { url: f.remote, action: () => { githubState.afterPush = undefined; throw new Error('push acknowledgement was lost'); } };
  githubState.readback = { url: f.remote, afterPush: pushes + 1, respond: () => `${request.head}\trefs/heads/main` };
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /exact remote readback did not prove recovery/);
  assert.equal(githubState.pushAttempts, pushes + 1);
  assert.equal(workers().find(worker => worker.name === f.worker.name).publication, 'local');
});

test('an earlier matching readback cannot open a draft after the destination advances', async () => {
  const f = fixture();
  const request = workerScope([f.worker.name]);
  const id = await approval(request.scope);
  const previousPRCalls = github.filter(args => args[1] === 'create').length;
  const pushes = githubState.pushAttempts;
  githubState.afterPush = { url: f.remote, action: () => {
    githubState.afterPush = undefined;
    const next = git(f.checkout, 'commit-tree', `${request.head}^{tree}`, '-p', request.head, '-m', 'test: later destination head');
    git(f.checkout, 'push', 'origin', `${next}:refs/heads/${f.worker.branch}`);
    throw new Error('push acknowledgement was lost');
  } };
  githubState.readback = { url: f.remote, afterPush: pushes + 1, respond: () => `${request.head}\trefs/heads/${f.worker.branch}` };
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /readback did not prove the approved head/);
  assert.throws(() => openWorkerPR([f.worker.name]), /readback did not prove the approved head/);
  assert.equal(github.filter(args => args[1] === 'create').length, previousPRCalls);
  assert.equal(githubState.pushAttempts, pushes + 1);
});

test('uncertain publication does not adopt a ready PR for the approved branch', async () => {
  const f = fixture();
  const request = workerScope([f.worker.name]);
  const id = await approval(request.scope);
  githubState.afterPush = { url: f.remote, action: () => { githubState.afterPush = undefined; throw new Error('push acknowledgement was lost'); } };
  githubState.pullRequests = [{ url: 'https://github.invalid/proof/repository/pull/999', isCrossRepository: false,
    baseRefName: f.worker.base, headRefName: f.worker.branch, isDraft: false, headRefOid: request.head }];
  try {
    await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /matching draft/);
    assert.equal(workers().find(worker => worker.name === f.worker.name).publication, 'awaiting-pr');
  } finally {
    githubState.pullRequests = [];
  }
});

test('failed draft creation retries only the PR and never pushes or consumes again', async () => {
  const f = fixture();
  const id = await approval(workerScope([f.worker.name]).scope);
  githubState.failPRHead = f.worker.branch;
  try {
    await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /temporarily unavailable/);
  } finally {
    githubState.failPRHead = undefined;
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
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /remote task branch already exists/);
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
