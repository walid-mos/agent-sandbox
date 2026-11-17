import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { approval, fixture, git, githubState, home, humanStore, openWorkerPR, publishWorker, remoteHeads, workerScope } from '../probes/fixtures/worker-publication.mjs';

afterEach(() => { githubState.beforePush = undefined; githubState.pullRequests = []; githubState.canCreatePR = true; });

for (const [setting, value] of [['push.followTags', 'true'], ['push.pushOption', 'unapproved'], ['push.recurseSubmodules', 'only']]) {
  test(`first publication ignores ${setting} and sends only the approved branch`, async () => {
    const f = fixture();
    git(f.checkout, 'tag', '-a', 'unapproved', '-m', 'Unapproved tag');
    git(f.checkout, 'config', setting, value);
    const head = git(f.checkout, 'rev-parse', 'HEAD');
    const id = await approval(workerScope([f.worker.name]).scope);
    await publishWorker([f.worker.name, id, 'Push once']);
    assert.equal(remoteHeads(f), head);
    assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/tags'), '');
  });
}

test('a push destination rewritten immediately before Git runs cannot redirect publication', async () => {
  const f = fixture();
  const wrong = join(home, 'raced-origin.git');
  git(home, 'init', '--bare', wrong);
  const id = await approval(workerScope([f.worker.name]).scope);
  githubState.beforePush = () => {
    githubState.beforePush = undefined;
    git(f.checkout, 'config', `url.${wrong}.pushInsteadOf`, f.remote);
  };
  await publishWorker([f.worker.name, id, 'Push once']);
  assert.equal(remoteHeads(f), git(f.checkout, 'rev-parse', 'HEAD'));
  assert.equal(git(wrong, 'for-each-ref', '--format=%(refname)'), '');
});

test('a base advancing during consumption does not burn approval for an unchanged approved head', async () => {
  const f = fixture();
  const request = workerScope([f.worker.name]);
  const id = await approval(request.scope);
  const store = humanStore();
  const changingStore = { ...store, async locked(...args) {
    const receipt = await store.locked(...args);
    const next = git(f.checkout, 'commit-tree', `${f.worker.base}^{tree}`, '-p', f.worker.base, '-m', 'Concurrent base advance');
    git(f.checkout, 'push', 'origin', `${next}:refs/heads/main`);
    return receipt;
  } };
  await publishWorker([f.worker.name, id, 'Push once'], changingStore);
  assert.equal(remoteHeads(f), request.head);
  assert.equal(store.get(id).consumption.scope, request.scope);
});

async function awaitingPR() {
  const f = fixture();
  const id = await approval(workerScope([f.worker.name]).scope);
  githubState.canCreatePR = false;
  await assert.rejects(publishWorker([f.worker.name, id, 'Push once']), /temporarily unavailable/);
  githubState.canCreatePR = true;
  return f;
}

test('PR recovery ignores a fork PR with the same head branch name', async () => {
  const f = await awaitingPR();
  githubState.pullRequests = [{ url: 'https://github.invalid/proof/repository/pull/999', isCrossRepository: true, baseRefName: 'main', headRefName: 'feat/probe' }];
  assert.equal(openWorkerPR([f.worker.name]), 'https://github.invalid/proof/repository/pull/1');
});

test('PR recovery accepts a descendant of the recorded published head without pushing again', async () => {
  const f = await awaitingPR();
  git(f.checkout, 'commit', '--allow-empty', '-m', 'feat: later separately approved work');
  git(f.checkout, 'push', 'origin', 'HEAD');
  writeFileSync(join(f.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  assert.equal(openWorkerPR([f.worker.name]), 'https://github.invalid/proof/repository/pull/1');
});
