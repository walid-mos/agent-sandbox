import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approval, fixture, git, humanStore, remoteHeads } from '../probes/fixtures/worker-publication.mjs';
import { consumeDiscordPush } from './human-consume.mjs';

function publication(fixture, subject) {
  const { worker, checkout } = fixture;
  const previous = remoteHeads(fixture);
  git(checkout, 'commit', '--allow-empty', '-m', subject);
  const head = git(checkout, 'rev-parse', 'HEAD');
  const scope = JSON.stringify({ repository: worker.repository, branch: worker.branch, remote: 'origin', url: worker.originUrl, commits: [head] });
  const push = () => git(checkout, 'push', 'origin', `${head}:refs/heads/${worker.branch}`);
  return { previous, head, scope, push };
}

function publishedWorker() {
  const worker = fixture();
  git(worker.checkout, 'push', 'origin', 'HEAD');
  return worker;
}

test('a routine topic push reaches the remote without a broker receipt', () => {
  const worker = publishedWorker();
  const pending = publication(worker, 'test: routine push');
  const before = humanStore().all();
  pending.push();
  assert.equal(remoteHeads(worker), pending.head);
  assert.deepEqual(humanStore().all(), before);
});

test('two client pushes consume separate checked approvals bound to their exact commits', async () => {
  const worker = publishedWorker();
  const first = publication(worker, 'test: first client push');
  const firstId = await approval(first.scope);
  assert.equal(remoteHeads(worker), first.previous);
  await consumeDiscordPush(firstId, { scope: first.scope, label: 'Push once' });
  first.push();
  const second = publication(worker, 'test: second client push');
  await assert.rejects(consumeDiscordPush(firstId, { scope: second.scope, label: 'Push once' }), /scope/);
  assert.equal(remoteHeads(worker), first.head);
  const secondId = await approval(second.scope);
  assert.notEqual(secondId, firstId);
  assert.equal(remoteHeads(worker), first.head);
  await consumeDiscordPush(secondId, { scope: second.scope, label: 'Push once' });
  second.push();
  assert.equal(remoteHeads(worker), second.head);
  assert.equal(humanStore().get(firstId).consumption.scope, first.scope);
  assert.equal(humanStore().get(secondId).consumption.scope, second.scope);
});
