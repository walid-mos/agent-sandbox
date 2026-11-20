import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { approval, fixture, git, github, githubState, humanStore, openWorkerPR, publishWorker, pushWorker, remoteHeads, sandbox, save, workerScope } from '../probes/fixtures/worker-publication.mjs';

const POLICY = 'accor-first-publication';
const LABEL = 'Push once';
const PR = 'https://github.com/proof/repository/pull/42';
const BRANCH = 'refs/heads/feat/probe';

function commit(checkout, file) {
  writeFileSync(join(checkout, file), `${file}\n`);
  git(checkout, 'add', file);
  git(checkout, 'commit', '-m', `feat: add ${file}`);
  return git(checkout, 'rev-parse', 'HEAD');
}

function configureAccor() {
  Object.assign(sandbox, { publicationPolicy: POLICY, rules: '/fixture/rules.md', sources: ['accor'] });
}

function githubFor(f) {
  const pull = { number: 42, html_url: PR, title: f.worker.title, state: 'open', draft: false,
    head: { ref: f.worker.branch, repo: { full_name: f.worker.repository } },
    base: { ref: f.worker.base, repo: { full_name: f.worker.repository } } };
  const state = { pull, created: false, isResponseLost: false };
  const snapshot = () => ({ ...pull, head: { sha: remoteHeads(f), ...pull.head } });
  githubState.respond = args => {
    assert.equal(args.includes('github.com'), true);
    if (args.includes('POST')) {
      assert.equal(args[1], 'repos/proof/repository/pulls');
      assert.deepEqual(args.slice(4), ['--method', 'POST', '-f', 'head=feat/probe', '-f', 'base=main', '-f', 'title=feat: probe', '-f', `body=${f.worker.description}`, '-F', 'draft=false']);
      pull.body = f.worker.description;
      state.created = true;
      if (state.isResponseLost) throw new Error('GitHub response lost');
      return snapshot();
    }
    if (args[1] === 'repos/proof/repository/pulls/42') return snapshot();
    assert.deepEqual(args.slice(4), ['--method', 'GET', '-f', 'head=proof:feat/probe', '-f', 'state=all']);
    return state.created ? [snapshot()] : [];
  };
  return state;
}

async function exactApproval(f) {
  const { commits, scope } = workerScope([f.worker.name]);
  return { commits, scope, id: await approval(scope) };
}

const postCount = () => github.filter(args => args.includes('POST')).length;

afterEach(() => {
  github.length = 0;
  Object.assign(githubState, { pushAttempts: 0, beforePush: undefined, afterPush: undefined, readback: undefined, respond: undefined, localOrigin: undefined });
  Object.assign(sandbox, { publicationPolicy: undefined, rules: undefined, sources: undefined });
});

test('Accor requires real local commits and a checked exact scope before first publication', async () => {
  const f = fixture({ publicationPolicy: POLICY });
  githubFor(f);
  assert.throws(() => workerScope([f.worker.name]), /at least one commit/);
  const first = commit(f.checkout, 'first');
  const second = commit(f.checkout, 'second');
  const { commits, scope } = workerScope([f.worker.name]);
  assert.deepEqual(commits, [first, second]);
  assert.deepEqual(JSON.parse(scope), { operation: 'first-worker-push', repository: f.worker.repository, branch: 'feat/probe', remote: 'origin',
    url: f.remote, base: 'main', baseCommit: git(f.checkout, 'rev-parse', 'main'), commits, head: second, publicationPolicy: POLICY, readyTitle: f.worker.title });
  await assert.rejects(publishWorker([f.worker.name, '0'.repeat(32), LABEL]), /scoped push question/);
  const wrong = await approval(scope.replace(f.remote, `${f.remote}-other`));
  await assert.rejects(publishWorker([f.worker.name, wrong, LABEL]), /scope and receipt/);
  assert.equal(humanStore().get(wrong).consumption, undefined);
  assert.equal(remoteHeads(f), '');
  assert.equal(postCount(), 0);
});

test('one checked Accor receipt creates the exact ready PR and routine pushes need no repeat approval', async () => {
  const f = fixture({ publicationPolicy: POLICY });
  githubFor(f);
  const first = commit(f.checkout, 'first');
  const { id, scope } = await exactApproval(f);
  assert.equal(await publishWorker([f.worker.name, id, LABEL]), PR);
  const receipt = humanStore().get(id).consumption;
  assert.equal(receipt.scope, scope);
  assert.equal(remoteHeads(f), first);
  await assert.rejects(publishWorker([f.worker.name, id, LABEL]), /not waiting for its first approved push/);
  const next = commit(f.checkout, 'follow-up');
  assert.throws(() => pushWorker([f.worker.name]), /current loaded push policy/);
  configureAccor();
  assert.equal(pushWorker([f.worker.name]), PR);
  assert.equal(remoteHeads(f), next);
  assert.equal(githubState.pushAttempts, 2);
  assert.equal(postCount(), 1);
  assert.deepEqual(humanStore().get(id).consumption, receipt);
});

test('uncertain Accor push and PR responses recover by readback without another push or POST', async () => {
  const f = fixture({ publicationPolicy: POLICY });
  const response = githubFor(f);
  const head = commit(f.checkout, 'first');
  const { id } = await exactApproval(f);
  response.isResponseLost = true;
  githubState.afterPush = { url: f.remote, action() { throw new Error('push response lost'); } };
  await assert.rejects(publishWorker([f.worker.name, id, LABEL]), /GitHub response lost/);
  assert.equal(remoteHeads(f), head);
  response.created = false;
  assert.throws(() => openWorkerPR([f.worker.name]), /has not confirmed/);
  response.created = true;
  assert.equal(openWorkerPR([f.worker.name]), PR);
  assert.equal(githubState.pushAttempts, 1);
  assert.equal(postCount(), 1);
});

for (const [name, change] of [
  ['closed', pull => { pull.state = 'closed'; }],
  ['different head repo', pull => { pull.head.repo.full_name = 'other/repository'; }],
  ['different head ref', pull => { pull.head.ref = 'feat/other'; }],
  ['different base repo', pull => { pull.base.repo.full_name = 'other/repository'; }],
  ['different base ref', pull => { pull.base.ref = 'develop'; }],
  ['stale head', pull => { pull.head.sha = 'a'.repeat(40); }],
]) {
  test(`a ${name} PR cannot be adopted or used for follow-up pushes`, async () => {
    const f = fixture({ publicationPolicy: POLICY });
    const response = githubFor(f);
    const first = commit(f.checkout, 'first');
    const { id } = await exactApproval(f);
    response.created = true;
    change(response.pull);
    await assert.rejects(publishWorker([f.worker.name, id, LABEL]), /did not confirm an open ready PR/);
    configureAccor();
    assert.throws(() => pushWorker([f.worker.name]), /no published PR/);
    assert.equal(postCount(), 0);
    save({ ...f.worker, name: `${f.worker.name}-existing`, publication: 'published', pullRequest: PR });
    commit(f.checkout, 'follow-up');
    assert.throws(() => pushWorker([`${f.worker.name}-existing`]), /recorded PR is not open on the expected/);
    assert.equal(remoteHeads(f), first);
  });
}

test('activation permits verified pre-activation PR pushes and cannot enable the same operation in other client pots', () => {
  const f = fixture();
  githubFor(f);
  const initial = git(f.checkout, 'rev-parse', 'HEAD');
  git(f.checkout, 'push', 'origin', 'HEAD');
  const { name, kind, owner, repository, branch, worktree } = f.worker;
  save({ name, kind, owner, repository, branch, worktree, pullRequest: PR });
  githubState.localOrigin = { checkout: f.checkout, url: 'https://github.com/proof/repository.git', remote: f.remote };
  const head = commit(f.checkout, 'next');
  sandbox.rules = '/fixture/other-client.md';
  assert.throws(() => pushWorker([f.worker.name]), /current loaded push policy/);
  assert.equal(remoteHeads(f), initial);
  configureAccor();
  assert.equal(pushWorker([f.worker.name]), PR);
  assert.equal(remoteHeads(f), head);
  assert.equal(postCount(), 0);
});

test('normal follow-up push cannot recreate a branch deleted after the PR check', async () => {
  const f = fixture({ publicationPolicy: POLICY });
  githubFor(f);
  commit(f.checkout, 'first');
  const { id } = await exactApproval(f);
  await publishWorker([f.worker.name, id, LABEL]);
  commit(f.checkout, 'next');
  configureAccor();
  githubState.beforePush = { url: f.remote, action: () => git(f.remote, 'update-ref', '-d', BRANCH) };
  assert.throws(() => pushWorker([f.worker.name]), /Command failed/);
  assert.equal(remoteHeads(f), '');
});

test('the Accor factory cannot take a ready PR or merge it automatically', async () => {
  configureAccor();
  const { watchedRepositories, requireActionable } = await import('./factory-github.mjs');
  assert.deepEqual(watchedRepositories(), []);
  assert.throws(() => requireActionable({ repository: 'proof/repository', number: 42 }), /separate human decision/);
  assert.deepEqual(github, []);
});
