import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launchController } from './factory-fixture.mjs';
import { createFactoryReceiver, signalFactory } from './factory-webhook.mjs';

const session = fileURLToPath(new URL('.', import.meta.url));
const fixture = join(session, 'factory-fixture.mjs');
const repository = 'walid-mos/agent-sandbox';
const signingKey = 'ab'.repeat(32);
const host = 'factory.example.com';
const fixtureTimeout = 20_000;
const teardown = new WeakMap();

function waitFor(directory, name, signal) {
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, check);
    function stop() {
      watcher.close();
      signal.removeEventListener('abort', abort);
    }
    function abort() { stop(); reject(signal.reason); }
    function check() {
      if (!existsSync(join(directory, name))) return;
      stop();
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
}

function fixtureEnvironment(root) {
  const env = { PATH: `${root}:${process.env.PATH}`, HOME: root, POTS_REPO: join(session, '..'), FACTORY_FIXTURE: root,
    NODE_OPTIONS: `--import=${fixture}`, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${root}/origin.insteadOf`, GIT_CONFIG_VALUE_0: `https://github.com/${repository}.git` };
  for (const binary of ['gh', 'docker', 'pots']) {
    writeFileSync(join(root, binary), `#!/bin/sh\nunset NODE_OPTIONS\nexec '${process.execPath}' '${fixture}' ${binary} "$@"\n`, { mode: 0o700 });
  }
  return env;
}

function gitFixture(root, env) {
  const git = (...args) => execFileSync('git', args, { env, encoding: 'utf8' }).trim();
  const origin = join(root, 'origin');
  git('init', '--quiet', '-b', 'main', origin);
  git('-C', origin, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '--quiet', '-m', 'fixture');
  return git('-C', origin, 'rev-parse', 'HEAD');
}

function stream(socketPath, signal, last) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, path: '/events', signal, headers: last ? { 'Last-Event-ID': last } : {} }, response => {
      assert.equal(response.statusCode, 200);
      response.setEncoding('utf8');
      resolve(response);
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

async function eventFrom(chunks, condition) {
  let remaining = '';
  for (;;) {
    const { value, done } = await chunks.next();
    assert.equal(done, false, 'event stream closed before expected event');
    remaining += value;
    const frames = remaining.split('\n\n');
    remaining = frames.pop();
    for (const frame of frames) {
      const body = frame.split('\n').find(line => line.startsWith('data: '));
      if (body) {
        const event = JSON.parse(body.slice(6));
        if (condition(event)) return event;
      }
    }
  }
}

function delivery(port, { method = 'POST', path = '/github/factory', key = signingKey, body, signature, signal } = {}) {
  const bytes = body ?? JSON.stringify({ action: 'ready_for_review', repository: { full_name: repository, private: false }, number: 37, pull_request: { number: 37 } });
  const headers = { host, 'Content-Length': Buffer.byteLength(bytes), 'X-GitHub-Event': 'pull_request', 'X-GitHub-Delivery': '00000000-0000-0000-0000-000000000001' };
  if (signature !== null) headers['X-Hub-Signature-256'] = signature ?? `sha256=${createHmac('sha256', key).update(bytes).digest('hex')}`;
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path, method, headers, signal }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    outgoing.once('error', reject);
    outgoing.end(bytes);
  });
}

async function controller(t, root, directory, env, wakeSocket) {
  const { child, stop: terminate } = launchController(root, join(session, 'factory-controller.mjs'), env, wakeSocket);
  const exited = once(child, 'exit');
  let hasStopped = false;
  const stop = () => {
    if (!hasStopped) terminate();
    hasStopped = true;
    return exited;
  };
  teardown.get(t).push(stop);
  await waitFor(root, 'intervals', t.signal);
  await waitFor(join(directory, '..'), 'execution', t.signal);
  await waitFor(directory, 'events.sock', t.signal);
  return stop;
}

async function receiver(t, wakeSocket) {
  const server = createFactoryReceiver({ host, key: signingKey, repositories: [repository], wake: () => signalFactory(wakeSocket) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return server.address().port;
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-runtime-'));
  const directory = join(root, '.config/agent-sandbox/factory/execution');
  const env = fixtureEnvironment(root);
  const head = gitFixture(root, env);
  const facts = { number: 37, state: 'OPEN', isDraft: false, headRefOid: head, headRefName: 'topic', baseRefOid: head,
    baseRefName: 'main', mergeable: 'MERGEABLE', timelineItems: { nodes: [] } };
  const setFacts = overrides => writeFileSync(join(root, 'facts'), JSON.stringify({ ...facts, ...overrides }));
  setFacts({});
  teardown.set(t, []);
  t.after(async () => {
    try {
      for (const stop of teardown.get(t).reverse()) await stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  return { root, directory, env, setFacts };
}

test('authenticated wake starts one check that survives discovery and controller exit, then replays completion', { timeout: fixtureTimeout }, async t => {
  const { root, directory, env, setFacts } = setup(t);
  writeFileSync(join(root, 'gate'), '');
  const wakeSocket = join(directory, 'wake.sock');
  const stop = await controller(t, root, directory, env, wakeSocket);
  const socketPath = join(directory, 'events.sock');
  const port = await receiver(t, wakeSocket);
  const initial = await stream(socketPath, t.signal);
  assert.deepEqual(readFileSync(join(root, 'intervals'), 'utf8').trim().split('\n').sort(), ['15000', '600000']);
  assert.equal(await delivery(port, { method: 'GET', signal: t.signal }), 404);
  assert.equal(await delivery(port, { path: '/github/factory?extra', signal: t.signal }), 404);
  assert.equal(await delivery(port, { body: 'x'.repeat(1024 * 1024 + 1), signal: t.signal }), 413);
  assert.equal(await delivery(port, { signature: null, signal: t.signal }), 401);
  assert.equal(await delivery(port, { key: 'wrong', signal: t.signal }), 401);
  assert.equal(existsSync(join(root, 'calls')), false);
  assert.equal(await delivery(port, { signal: t.signal }), 202);
  assert.equal(await delivery(port, { signal: t.signal }), 204);
  const started = await eventFrom(initial.iterator({ destroyOnReturn: false }), event => event.type === 'step-start' && event.detail.step === 'check');
  await waitFor(root, 'blocked', t.signal);
  initial.destroy();
  await stop();
  for (const path of [socketPath, wakeSocket]) rmSync(path);
  await controller(t, root, directory, env);
  assert.equal(existsSync(wakeSocket), false);
  const resumed = await stream(socketPath, t.signal, started.id);
  writeFileSync(join(root, 'release'), '');
  const done = await eventFrom(resumed.iterator(), event => event.type === 'complete');
  assert.equal(done.job, started.job);
  assert.equal(done.detail.stage, 'checked');
  assert.deepEqual(done.detail.checks.map(check => check.name), ['check', 'shellcheck', 'fallow']);
  await waitFor(root, 'wakes', t.signal);
  const wake = JSON.parse(readFileSync(join(root, 'wakes'), 'utf8').trim());
  setFacts({ timelineItems: { nodes: [{ __typename: 'ReadyForReviewEvent', id: 'new-review' }] } });
  const stale = spawn(process.execPath, [join(session, 'factory.mjs'), 'verdict', wake.review, 'PASS'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const errors = [];
  stale.stderr.on('data', bytes => errors.push(bytes));
  assert.equal((await once(stale, 'close'))[0], 1);
  assert.match(Buffer.concat(errors).toString(), /no longer matches this review generation/);
  assert.doesNotMatch(readFileSync(join(root, 'calls'), 'utf8'), /pr (comment|merge)/);
  assert.equal(readFileSync(join(root, 'calls'), 'utf8').match(/^repo list$/gm).length, 1);
  resumed.destroy();
});

test('a successful exit after the step deadline records failure and confirms removal', { timeout: fixtureTimeout }, async t => {
  const { root, directory, env } = setup(t);
  writeFileSync(join(root, 'late'), '');
  await controller(t, root, directory, env);
  assert.equal(existsSync(join(directory, 'wake.sock')), false);
  const events = await stream(join(directory, 'events.sock'), t.signal);
  const routine = spawn(process.execPath, [join(session, 'factory.mjs'), 'reconcile'], { env });
  assert.equal((await once(routine, 'close'))[0], 0);
  const done = await eventFrom(events.iterator(), event => event.type === 'complete');
  assert.equal(done.detail.stage, 'checks-failed');
  assert.deepEqual(done.detail.checks.map(check => [check.name, check.outcome]), [['check', 'deadline']]);
  assert.equal(existsSync(join(root, 'container')), false);
  assert.match(readFileSync(join(root, 'removed'), 'utf8'), /^factory-1-check c{64}$/m);
  await waitFor(root, 'wakes', t.signal);
  events.destroy();
});

for (const isCleanupRefused of [false, true]) {
  const requirement = isCleanupRefused ? 'fences the PR when exact removal fails' : 'confirms exact container removal before retry';
  test(`a killed runner ${requirement}`, { timeout: fixtureTimeout }, async t => {
    const { root, directory, env } = setup(t);
    writeFileSync(join(root, 'gate'), '');
    if (isCleanupRefused) writeFileSync(join(root, 'refuse-cleanup'), '');
    const wakeSocket = join(directory, 'wake.sock');
    await controller(t, root, directory, env, wakeSocket);
    const socketPath = join(directory, 'events.sock');
    const events = await stream(socketPath, t.signal);
    await signalFactory(wakeSocket);
    const live = await eventFrom(events.iterator({ destroyOnReturn: false }), event => event.type === 'running');
    await waitFor(root, 'blocked', t.signal);
    assert.equal(JSON.parse(readFileSync(join(root, 'blocked'))).job, String(live.job));
    process.kill(live.detail.runner, 'SIGKILL');
    rmSync(join(root, 'gate'));
    const resultStream = await stream(socketPath, t.signal, live.id);
    const expected = isCleanupRefused ? 'uncertain' : 'complete';
    const done = await eventFrom(resultStream.iterator(), event => event.type === expected);
    const removed = readFileSync(join(root, 'removed'), 'utf8');
    if (isCleanupRefused) {
      assert.equal(done.job, live.job);
      assert.doesNotMatch(removed, /^factory-1-check/m);
      writeFileSync(join(root, 'release'), '');
    } else {
      assert.equal(done.detail.stage, 'checked');
      assert.notEqual(done.job, live.job);
      assert.match(removed, /^factory-1-check c{64}\nfactory-2-boundary/m);
    }
    await waitFor(root, 'wakes', t.signal);
    events.destroy();
    resultStream.destroy();
  });
}
