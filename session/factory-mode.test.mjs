import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const session = fileURLToPath(new URL('.', import.meta.url));
const fixture = join(session, 'factory-fixture.mjs');
const executionPath = '.config/agent-sandbox/factory/execution';
const repository = 'walid-mos/agent-sandbox';

function setup(t, settings) {
  const root = mkdtempSync(join(tmpdir(), 'factory-mode-'));
  const stops = [];
  t.after(async () => {
    try {
      for (const stop of stops) await stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  mkdirSync(join(root, '.pots/bots/factory'), { recursive: true });
  mkdirSync(join(root, 'session'));
  writeFileSync(join(root, 'sandbox.json'), JSON.stringify({ bot: 'Principal', owners: { 'walid-mos': 'fixture' }, ...settings }));
  const launch = readFileSync(join(session, 'launch.env'), 'utf8');
  writeFileSync(join(root, 'session/launch.env'), launch.replace(/^POTS_SESSION_CONFIGURATION=.*$/m, `POTS_SESSION_CONFIGURATION='${root}'`));
  for (const name of ['gh', 'docker', 'pots']) shim(root, name, `unset NODE_OPTIONS\nexec '${process.execPath}' '${fixture}' ${name} "$@"`);
  shim(root, 'node', `export FACTORY_FIXTURE='${root}' POTS_REPO='${root}' NODE_OPTIONS='--import=${fixture}'\nexport GIT_ALLOW_PROTOCOL=file GIT_CONFIG_COUNT=1\nexport GIT_CONFIG_KEY_0='url.file://${root}/origin.insteadOf' GIT_CONFIG_VALUE_0='https://github.com/${repository}.git'\nexec '${process.execPath}' "$@"`);
  shim(root, 'sleep', 'printf "%s\\n" "$@" > "$HOME/parked"');
  return { root, stops, env: { PATH: `${root}:${process.env.PATH}`, HOME: root, POTS_REPO: root, FACTORY_FIXTURE: root } };
}

function shim(root, name, body) {
  writeFileSync(join(root, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
}

function registerRoutine({ root, env }) {
  execFileSync('node', [join(session, 'factory-bot.mjs')], { env });
  const registration = JSON.parse(readFileSync(join(root, 'routine'), 'utf8'));
  assert.deepEqual(registration.slice(0, 5), ['routine', 'add', 'factory-watch', '--bot', 'factory']);
  return registration.slice(5);
}

function seedPull({ root, env }) {
  const origin = join(root, 'origin');
  execFileSync('git', ['init', '-qb', 'main', origin], { env });
  const git = (...args) => execFileSync('git', ['-C', origin, ...args], { env, encoding: 'utf8' }).trim();
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'facts'), JSON.stringify({ number: 37, title: 'Fixture', state: 'OPEN', isDraft: false,
    headRefName: 'topic', baseRefName: 'main', mergeable: 'MERGEABLE', headRefOid: head, baseRefOid: head, timelineItems: { nodes: [] } }));
  return head;
}

function startController(t, { root, env, stops }) {
  const child = spawn(join(session, 'start-factory'), { env, stdio: ['ignore', 'ignore', 'inherit'] });
  const exit = once(child, 'exit');
  stops.push(async () => { child.kill(); await exit; });
  const directory = join(root, executionPath);
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]);
  return Promise.race([exit.then(([code]) => { throw new Error(`Factory controller stopped with status ${code}`); }),
    waitForPath(root, join(directory, 'events.sock'), signal)]);
}

function waitForPath(root, path, signal) {
  return new Promise((resolve, reject) => {
    const watcher = watch(root, { recursive: true, signal }, ready);
    watcher.once('error', reject);
    watcher.once('close', () => signal.aborted ? reject(signal.reason) : resolve(path));
    function ready() {
      if (existsSync(path)) watcher.close();
    }
    ready();
  });
}

async function completedCheck(socketPath, signal) {
  const stream = await new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, path: '/events', signal }, resolve);
    outgoing.once('error', reject);
    outgoing.end();
  });
  assert.equal(stream.statusCode, 200);
  let received = '';
  for await (const chunk of stream.iterator({ destroyOnReturn: true })) {
    received += chunk;
    if (received.includes('"stage":"checked"')) return received;
  }
  assert.fail('Factory closed the stream before completing the check');
}

test('the installed controller opens the wake socket when durable mode and the socket path are configured', async t => {
  const fixture = setup(t, { factoryDurable: true });
  const wakeSocket = join(fixture.root, 'wake.sock');
  writeFileSync(join(fixture.root, 'factory-wake-socket'), `${wakeSocket}\n`);
  await startController(t, fixture);
  await waitForPath(fixture.root, wakeSocket, t.signal);
  assert.equal(existsSync(join(fixture.root, 'calls')), false);
});

const legacyCadence = ['--every', '1m', '--timeout', '30m', '--run', `${join(session, 'with-vault')} node ${join(session, 'factory.mjs')} scan`];

test('the default installed routine checks synchronously and preserves legacy review commands', { timeout: 15_000 }, t => {
  const fixture = setup(t, {});
  const { root, env } = fixture;
  const head = seedPull(fixture);
  writeFileSync(join(root, 'factory-wake-socket'), `${join(root, 'wake.sock')}\n`);
  execFileSync(join(session, 'start-factory'), { env });
  assert.equal(readFileSync(join(root, 'parked'), 'utf8'), 'infinity\n');
  const routine = registerRoutine(fixture);
  assert.deepEqual(routine, legacyCadence);
  execFileSync('sh', ['-c', routine.at(-1)], { env });
  const checks = readFileSync(join(root, 'legacy-checks'), 'utf8');
  assert.match(checks, /factory-\d+-check\nfactory-\d+-shellcheck\nfactory-\d+-fallow\n/);
  const wake = JSON.parse(readFileSync(join(root, 'wakes'), 'utf8'));
  assert.equal(wake.event, 'checked');
  assert.equal(wake.review, undefined);
  assert.match(execFileSync('sh', ['-c', wake.commands.show], { env, encoding: 'utf8' }), new RegExp(`Head ${head}`));
  assert.equal(existsSync(join(root, executionPath)), false);
  assert.equal(existsSync(join(root, 'wake.sock')), false);
  assert.throws(() => execFileSync('node', [join(session, 'factory.mjs'), 'reconcile'], { env, stdio: 'pipe' }), /usage: factory scan/);
  execFileSync('sh', ['-c', routine.at(-1)], { env });
  assert.equal(readFileSync(join(root, 'legacy-checks'), 'utf8'), checks);
});

test('durable opt-in installs ten-minute reconciliation with private progress and no webhook socket', { timeout: 15_000 }, async t => {
  const fixture = setup(t, { factoryDurable: true });
  const head = seedPull(fixture);
  const socket = await startController(t, fixture);
  const routine = registerRoutine(fixture);
  assert.deepEqual(routine, ['--every', '10m', '--timeout', '15s', '--run', `node ${join(session, 'factory.mjs')} reconcile`]);
  assert.equal(existsSync(join(fixture.root, 'calls')), false);
  assert.equal(existsSync(join(fixture.root, executionPath, 'wake.sock')), false);
  execFileSync('sh', ['-c', routine.at(-1)], { env: fixture.env });
  assert.match(await completedCheck(socket, t.signal), /event: complete/);
  const wakeFile = await waitForPath(fixture.root, join(fixture.root, 'wakes'), t.signal);
  const wake = JSON.parse(readFileSync(wakeFile, 'utf8'));
  assert.match(wake.review, /^[a-f0-9]{64}$/);
  assert.match(execFileSync('sh', ['-c', wake.commands.show], { env: fixture.env, encoding: 'utf8' }), new RegExp(`Head ${head}`));
});

test('a string configuration value keeps the deployed routine', t => {
  const fixture = setup(t, { factoryDurable: 'true' });
  assert.deepEqual(registerRoutine(fixture), legacyCadence);
});
