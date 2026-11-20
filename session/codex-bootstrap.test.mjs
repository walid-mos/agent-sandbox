import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function bootstrapFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-bootstrap-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binaries = join(directory, 'bin');
  const runtime = join(directory, 'runtime');
  mkdirSync(binaries);
  for (const pot of ['nextnode', 'accor']) {
    const sandbox = join(runtime, 'sandboxes', pot);
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(join(sandbox, 'sandbox.json'), JSON.stringify({ provider: 'colima', launcher: 'docker' }));
  }
  const docker = join(binaries, 'docker');
  writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const directory = path.dirname(path.dirname(process.argv[1]));
const arguments_ = process.argv.slice(2);
fs.appendFileSync(path.join(directory, 'trace'), JSON.stringify(arguments_) + '\\n');
if (arguments_.includes('s6-svc') && fs.existsSync(path.join(directory, 'fail'))) process.exit(7);
if (arguments_.includes('ps')) console.log('fixture-session');
else if (arguments_.includes('s6-svstat')) console.log('true');
else console.log('CODEX_TARGETED_V1: fixture process boundary confirmed');
`);
  chmodSync(docker, 0o755);
  const env = { ...process.env, HOME: directory, POTS_RUNTIME: runtime, SANDBOX: 'nextnode', PATH: binaries + ':' + process.env.PATH };
  const invoke = () => spawnSync(resolve('bin/session-bootstrap'), ['--codex-targeted', '/fixture/private-expected.json'], { env, encoding: 'utf8' });
  const trace = () => existsSync(join(directory, 'trace')) ? readFileSync(join(directory, 'trace'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { directory, env, invoke, trace };
}

test('public Codex bootstrap restores existing services without invoking full seed, installation or Claude answers', t => {
  const fixture = bootstrapFixture(t);
  const result = fixture.invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /gateway and human relay processes up, Claude DEFERRED/u);
  const calls = fixture.trace();
  const restarted = calls.filter(arguments_ => arguments_.includes('s6-svc'));
  assert.deepEqual(restarted.map(arguments_ => arguments_.at(-1)), [
    '/run/service/custom-svc-pots-router', '/run/service/custom-svc-pots-tailnet', '/run/service/custom-svc-pots-gateway',
    '/run/service/custom-svc-pots-watcher', '/run/service/custom-svc-pots-sources', '/run/service/custom-svc-pots-human-relay', '/run/service/custom-svc-pots-discord-human',
  ]);
  assert.equal(restarted.every(arguments_ => arguments_.includes('-wu') && arguments_.includes('20000')), true);
  assert.equal(calls.filter(arguments_ => arguments_.includes('compare')).length, 2);
  assert.doesNotMatch(JSON.stringify(calls), /router-seed|router-answers|chat\/completions|session-credentials|factory-bot|bot.mjs/u);
});

test('public recovery bootstrap refuses Accor before any Docker command and stops the first real service command failure', t => {
  const fixture = bootstrapFixture(t);
  fixture.env.SANDBOX = 'accor';
  assert.equal(fixture.invoke().status, 2);
  assert.deepEqual(fixture.trace(), []);
  fixture.env.SANDBOX = 'nextnode';
  writeFileSync(join(fixture.directory, 'fail'), 'fixture');
  assert.equal(fixture.invoke().status, 7);
  assert.equal(fixture.trace().filter(arguments_ => arguments_.includes('s6-svc')).length, 1);
  assert.equal(fixture.trace().some(arguments_ => arguments_.includes('s6-svstat')), false);
});
