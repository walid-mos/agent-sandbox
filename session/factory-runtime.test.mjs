import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
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

function waitFor(directory, name, signal, isReady = existsSync) {
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, check);
    function stop() {
      watcher.close();
      signal.removeEventListener('abort', abort);
    }
    function abort() { stop(); reject(signal.reason); }
    function check() {
      if (!isReady(join(directory, name))) return;
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

function eventIn(frame) {
  const body = frame.split('\n').find(line => line.startsWith('data: '));
  if (body) return JSON.parse(body.slice(6));
}

async function eventFrom(chunks, condition) {
  let remaining = '';
  for (;;) {
    const { value, done } = await chunks.next();
    assert.equal(done, false, 'event stream closed before expected event');
    remaining += value;
    const frames = remaining.split('\n\n');
    remaining = frames.pop();
    const event = frames.map(eventIn).filter(Boolean).find(condition);
    if (event) return event;
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
  await waitFor(directory, 'events.sock', t.signal, path => (statSync(path, { throwIfNoEntry: false })?.mode & 0o777) === 0o600);
  if (wakeSocket) {
    await waitFor(directory, 'wake.sock', t.signal, path => (statSync(path, { throwIfNoEntry: false })?.mode & 0o777) === 0o660);
  }
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
  const requiredChecks = new Set(['check', 'shellcheck', 'fallow']);
  assert.deepEqual(done.detail.checks.map(check => check.name).filter(name => requiredChecks.has(name)), [...requiredChecks]);
  await waitFor(root, 'wakes', t.signal);
  const wake = JSON.parse(readFileSync(join(root, 'wakes'), 'utf8').trim());
  setFacts({ timelineItems: { nodes: [{ __typename: 'ReadyForReviewEvent', id: 'new-review' }] } });
  const stale = spawn(process.execPath, [join(session, 'factory.mjs'), 'verdict', wake.review, 'PASS'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const errors = [];
  stale.stderr.on('data', bytes => errors.push(bytes));
  assert.equal((await once(stale, 'close'))[0], 1);
  assert.match(Buffer.concat(errors).toString(), /no longer matches this review generation/);
  assert.doesNotMatch(readFileSync(join(root, 'calls'), 'utf8'), /pr (comment|merge)/);
  const calls = readFileSync(join(root, 'calls'), 'utf8');
  assert.equal(calls.match(/^repo list$/gm).length, 1);
  assert.doesNotMatch(calls, /^draft pagination$/m);
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

test('a 35-minute check survives base churn and hands off only the current base', { timeout: fixtureTimeout }, async t => {
  const { root, directory, env, setFacts } = setup(t);
  const cli = (...args) => execFileSync(process.execPath, [join(session, 'factory.mjs'), ...args], { env });
  writeFileSync(join(root, 'check-steps'), JSON.stringify([{ name: 'check', run: ['git', 'rev-parse', 'HEAD'], stableInputs: true }]));
  writeFileSync(join(root, 'gate'), '');
  await controller(t, root, directory, env);
  const socket = join(directory, 'events.sock');
  const events = await stream(socket, t.signal);
  cli('reconcile');
  await waitFor(root, 'blocked', t.signal);
  const gitIn = (path, ...args) => execFileSync('git', ['-C', path, ...args], { env, encoding: 'utf8' }).trim();
  const git = (...args) => gitIn(join(root, 'origin'), ...args);
  const checkout = join(directory, '..', 'runs', '1', 'work', 'repository');
  assert.equal(gitIn(checkout, 'for-each-ref'), '');
  assert.equal(gitIn(checkout, 'remote'), '');
  for (const name of ['next base', 'latest base']) {
    git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', name);
    setFacts({ baseRefOid: git('rev-parse', 'HEAD') });
    cli('reconcile');
    cli('scan');
  }
  rmSync(join(root, 'gate'));
  writeFileSync(join(root, 'release'), '');
  const outcome = await eventFrom(events.iterator(), event => event.type === 'complete' && event.job === 3);
  assert.equal(outcome.detail.stage, 'checked');
  assert.equal(readFileSync(join(root, 'removed'), 'utf8').match(/-check /g).length, 1);
  await waitFor(root, 'wakes', t.signal);
  const wake = JSON.parse(readFileSync(join(root, 'wakes'), 'utf8'));
  assert.equal(wake.baseTip, git('rev-parse', 'HEAD'));
  assert.equal(wake.generation, 3);
});

for (const revision of ['command', 'image', 'helper']) {
  test(`changed ${revision} invalidates an issued verdict and queues the unchanged PR`, { timeout: fixtureTimeout }, async t => {
    const { root, directory, env } = setup(t);
    const cli = (...args) => execFileSync(process.execPath, [join(session, 'factory.mjs'), ...args], { env, stdio: 'pipe' });
    const steps = args => writeFileSync(join(root, 'check-steps'), JSON.stringify([{ name: 'check', run: ['git', ...args] }]));
    steps(['rev-parse', 'HEAD']);
    cpSync(join(session, 'factory-image'), join(root, 'check-helpers'), { recursive: true });
    cli('reconcile');
    cli('scan');
    cli('run-job', '1');
    cli('publish-job', '1');
    const original = JSON.parse(readFileSync(join(root, 'wakes'), 'utf8'));
    if (revision === 'command') steps(['status']);
    if (revision === 'image') writeFileSync(join(root, 'image-id'), JSON.stringify('d'.repeat(64)));
    if (revision === 'helper') writeFileSync(join(root, 'check-helpers', 'fixture-helper'), 'different');
    assert.throws(() => cli('verdict', original.review, 'PASS'), /check inputs changed/);
    assert.doesNotMatch(readFileSync(join(root, 'calls'), 'utf8'), /pr (comment|merge)/);
    cli('reconcile');
    cli('scan');
    cli('run-job', '2');
    await controller(t, root, directory, env);
    const events = await stream(join(directory, 'events.sock'), t.signal);
    const result = await eventFrom(events.iterator(), event => event.type === 'complete' && event.job === 2);
    assert.equal(result.detail.stage, 'checked');
  });
}

function signedReview(t, baseRefName = 'main') {
  const { root, directory, env, setFacts } = setup(t);
  setFacts({ baseRefName });
  writeFileSync(join(root, 'signed-fixture'), '');
  const cli = (...args) => execFileSync(process.execPath, [join(session, 'factory.mjs'), ...args], { env, stdio: 'pipe', encoding: 'utf8' });
  cli('reconcile');
  cli('scan');
  cli('run-job', '1');
  cli('publish-job', '1');
  const wake = JSON.parse(readFileSync(join(root, 'wakes'), 'utf8'));
  return { root, directory, env, cli, wake, setFacts };
}

function beginLandedRetry({ root, cli, wake }) {
  assert.throws(() => cli('verdict', wake.review, 'PASS'), /gh pr comment/);
  assert.equal(existsSync(join(root, 'merged')), false);
  assert.throws(() => cli('verdict', wake.review, 'PASS'), /lost signer response/);
  assert.equal(existsSync(join(root, 'published')), false);
}

test('isolated landing recovers lost comment and signer responses before publishing evidence', { timeout: fixtureTimeout }, t => {
  const fixture = signedReview(t);
  beginLandedRetry(fixture);
  const { root, cli, wake } = fixture;
  cli('reconcile');
  cli('scan');
  const { squashEvidence } = JSON.parse(readFileSync(join(root, 'landing'), 'utf8'));
  assert.equal(squashEvidence.generation, wake.generation);
  assert.equal(squashEvidence.base, wake.baseTip);
  assert.equal(readFileSync(join(root, 'published'), 'utf8'), 'fixture-tag');
  assert.equal(readFileSync(join(root, 'calls'), 'utf8').match(/^pr comment$/gm).length, 1);
});

test('changed inputs after squash record operator recovery once and stop signing', { timeout: fixtureTimeout }, t => {
  const fixture = signedReview(t);
  beginLandedRetry(fixture);
  const { root, cli, wake } = fixture;
  writeFileSync(join(root, 'image-id'), JSON.stringify('d'.repeat(64)));
  const scan = () => { cli('reconcile'); return cli('scan'); };
  scan();
  const recordPath = join(root, '.config/agent-sandbox/factory/heads', `${repository.replace('/', '-')}-${wake.number}-${wake.head}.json`);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(record.stage, 'squash-recovery-required');
  assert.equal(record.squashPublication.landed.head, wake.head);
  const report = JSON.parse(readFileSync(join(root, 'reports'), 'utf8'));
  assert.match(report.text, /check inputs changed/);
  assert.equal(record.pendingWakes.length, 0);
  const calls = join(root, 'channel-calls');
  assert.equal(readFileSync(calls, 'utf8'), 'landing\nreports\n');
  scan();
  assert.equal(readFileSync(calls, 'utf8'), 'landing\nreports\n');
  assert.equal(existsSync(join(root, 'published')), false);
  assert.deepEqual(JSON.parse(readFileSync(recordPath, 'utf8')), record);
});

test('a confirmed open stale squash intent yields to the current review', { timeout: fixtureTimeout }, t => {
  const { root, cli, wake } = signedReview(t);
  writeFileSync(join(root, 'refuse-merge'), '');
  assert.throws(() => cli('verdict', wake.review, 'PASS'), /gh pr comment/);
  assert.throws(() => cli('verdict', wake.review, 'PASS'), /merge readback/);
  assert.equal(existsSync(join(root, 'merged')), false);
  writeFileSync(join(root, 'image-id'), JSON.stringify('d'.repeat(64)));
  const uncertain = join(root, 'uncertain-merge-readback');
  writeFileSync(uncertain, '');
  cli('reconcile');
  assert.throws(() => cli('scan'), /merge readback/);
  cli('run-job', '2');
  assert.throws(() => cli('publish-job', '2'), /prior squash still needs readback/);
  rmSync(uncertain);
  cli('scan');
  cli('publish-job', '2');
  const wakes = readFileSync(join(root, 'wakes'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(wakes.at(-1).generation, 2);
  assert.notEqual(wakes.at(-1).review, wake.review);
  assert.throws(() => cli('verdict', wake.review, 'PASS'), /checked review changed/);
  assert.equal(existsSync(join(root, 'landing')), false);
});

test('confirmed open same-head retarget releases a pending squash for the current review', { timeout: fixtureTimeout }, t => {
  const { root, cli, wake, setFacts } = signedReview(t);
  writeFileSync(join(root, 'refuse-merge'), '');
  assert.throws(() => cli('verdict', wake.review, 'PASS'), /gh pr comment/);
  assert.throws(() => cli('verdict', wake.review, 'PASS'), /merge readback/);
  const recordPath = join(root, '.config/agent-sandbox/factory/heads', `${repository.replace('/', '-')}-${wake.number}-${wake.head}.json`);
  const record = () => JSON.parse(readFileSync(recordPath, 'utf8'));
  const pending = record();
  assert.equal(pending.stage, 'squash-pending');
  setFacts({ baseRefName: 'develop' });
  cli('reconcile');
  cli('scan');
  assert.equal(record().stage, 'squash-superseded');
  assert.deepEqual(record().squashPublication, pending.squashPublication);
  cli('run-job', '2');
  cli('publish-job', '2');
  const current = JSON.parse(readFileSync(join(root, 'wakes'), 'utf8').trim().split('\n').at(-1));
  assert.equal(current.generation, 2);
  assert.match(cli('show', current.review), /into develop/);
  assert.throws(() => cli('show', wake.review), /checked review changed/);
  assert.equal(existsSync(join(root, 'merged')), false);
  assert.equal(existsSync(join(root, 'landing')), false);
});

test('an ordinary verdict on the isolated repository holds the shared record lock', { timeout: fixtureTimeout }, t => {
  const { root, cli, wake } = signedReview(t, 'develop');
  const notes = join(root, 'notes');
  writeFileSync(notes, 'Fixture failed review.');
  assert.match(cli('verdict', wake.review, 'FAIL', notes), /failed/);
  assert.match(JSON.parse(readFileSync(join(root, 'verdict-comment'), 'utf8')), /verdict: FAIL/);
});

function releaseScan(root, directory, phase) {
  writeFileSync(join(root, `release-${phase}`), '');
  const lock = phase === 'ready' ? 'discovery' : 'maintenance';
  execFileSync('flock', ['--wait', '15', join(directory, `${lock}.lock`), 'true']);
}

test('controller recovers a landed squash while the ready listing is stalled', { timeout: fixtureTimeout }, async t => {
  const rig = signedReview(t);
  beginLandedRetry(rig);
  const { root, directory, env, cli } = rig;
  writeFileSync(join(root, 'stall-ready'), '');
  try {
    await controller(t, root, directory, env);
    cli('reconcile');
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]);
    await Promise.all([waitFor(root, 'blocked-ready', signal), waitFor(root, 'reports', signal)]);
    assert.equal(readFileSync(join(root, 'published'), 'utf8'), 'fixture-tag');
  } finally {
    releaseScan(root, directory, 'ready');
    execFileSync('flock', ['--wait', '15', join(directory, 'maintenance.lock'), 'true']);
  }
});

test('controller queues a ready job while squash readback is stalled', { timeout: fixtureTimeout }, async t => {
  const { root, directory, env, cli, wake, setFacts } = signedReview(t);
  writeFileSync(join(root, 'refuse-merge'), '');
  assert.throws(() => cli('verdict', wake.review, 'PASS'), /gh pr comment/);
  assert.throws(() => cli('verdict', wake.review, 'PASS'), /merge readback/);
  setFacts({ baseRefName: 'develop' });
  writeFileSync(join(root, 'stall-recovery'), '');
  try {
    await controller(t, root, directory, env);
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(3500)]);
    const events = await stream(join(directory, 'events.sock'), signal);
    cli('reconcile');
    const [, queued] = await Promise.all([waitFor(root, 'blocked-recovery', signal),
      eventFrom(events.iterator(), event => event.job === 2 && event.type === 'queued')]);
    assert.equal(queued.detail.base, 'develop');
  } finally {
    releaseScan(root, directory, 'recovery');
  }
  await waitFor(root, 'wakes', t.signal, path => readFileSync(path, 'utf8').trim().split('\n').length === 2);
});

test('routine discovery handles a failing repository and checks ready work alongside drafts', { timeout: fixtureTimeout }, async t => {
  const { root, directory, env } = setup(t);
  writeFileSync(join(root, 'failing-repository'), '');
  await controller(t, root, directory, env);
  const events = await stream(join(directory, 'events.sock'), t.signal);
  execFileSync(process.execPath, [join(session, 'factory.mjs'), 'reconcile'], { env });
  const complete = await eventFrom(events.iterator(), event => event.type === 'complete');
  assert.equal(complete.detail.stage, 'checked');
  await waitFor(root, 'calls', t.signal, path => existsSync(path) && readFileSync(path, 'utf8').includes('draft pagination'));
  assert.equal(readFileSync(join(root, 'calls'), 'utf8').match(/^pr list$/gm)?.length, 2);
  await waitFor(root, 'wakes', t.signal);
});

test('discovery requeues the unchanged head after mergeability was briefly unknown at execution', { timeout: fixtureTimeout }, async t => {
  const { directory, env, setFacts } = setup(t);
  const run = (...args) => execFileSync(process.execPath, [join(session, 'factory.mjs'), ...args], { env });
  run('reconcile');
  run('scan');
  setFacts({ mergeable: 'UNKNOWN' });
  run('run-job', '1');
  setFacts({});
  await controller(t, env.HOME, directory, env);
  const events = await stream(join(directory, 'events.sock'), t.signal);
  const complete = await eventFrom(events.iterator(), event => event.type === 'complete' && event.job > 1);
  assert.equal(complete.detail.stage, 'checked');
  await waitFor(env.HOME, 'wakes', t.signal);
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
    if (isCleanupRefused) {
      rmSync(join(root, 'refuse-cleanup'));
      execFileSync(process.execPath, [join(session, 'factory.mjs'), 'recover-job', String(live.job)], { env });
      const recovered = await stream(socketPath, t.signal, done.id);
      const retried = await eventFrom(recovered.iterator(), event => event.type === 'complete');
      assert.notEqual(retried.job, live.job);
      assert.equal(retried.detail.stage, 'checked');
      assert.match(readFileSync(join(root, 'removed'), 'utf8'), /^factory-1-check c{64}\nfactory-2-boundary/m);
      recovered.destroy();
    }
  });
}
