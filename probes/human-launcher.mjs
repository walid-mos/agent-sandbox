import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const workers = new URL('../session/workers.mjs', import.meta.url).href;
const broker = fileURLToPath(new URL('../session/human.mjs', import.meta.url));
const SUPPORTED = '--human-dialog-worker --human-dialog-broker';
const LAUNCHERS = `import { launch } from ${JSON.stringify(workers)};
const worker = name => ({ name, owner: 'proof', worktree: '/tmp/worktree', model: 'group/proof' });
const launched = names => names.forEach(name => launch(worker(name), ['Read the brief.']));`;

const FAKE_HC = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
if (process.argv[2] === 'run') appendFileSync(process.env.PROOF_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(JSON.stringify({ address: 't-proof' }));
`;

function launcher(t, help) {
  const directory = mkdtempSync(join(tmpdir(), 'launcher-proof-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'launches.jsonl');
  const handPath = join(directory, 'pi-help');
  writeFileSync(handPath, `${help}\n`);
  writeFileSync(join(directory, 'pi'), '#!/bin/sh\ncat "$PROOF_HELP"\n', { mode: 0o700 });
  writeFileSync(join(directory, 'hc'), FAKE_HC, { mode: 0o700 });
  function run(body) {
    const script = `${LAUNCHERS}\n${body}`;
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}`, PROOF_LOG: log, PROOF_HELP: handPath },
    });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  return { run };
}

function assertFlags(arguments_, workerName) {
  const workerFlag = arguments_.indexOf('--human-dialog-worker');
  assert.ok(workerFlag > 0, arguments_.join(' '));
  assert.equal(arguments_[workerFlag + 1], workerName);
  assert.equal(arguments_[workerFlag + 2], '--human-dialog-broker');
  assert.equal(arguments_[workerFlag + 3], broker);
  assert.equal(arguments_.includes('--extension'), true);
  assert.equal(arguments_.includes('--session-id'), true);
  assert.equal(arguments_.at(-1), 'Read the brief.');
}

test('a supported installed Pi gets the exact worker and absolute installed broker flags', t => {
  const launcherFixture = launcher(t, SUPPORTED);
  const [arguments_] = launcherFixture.run('launched([\'pots-exact-worker\']);');
  assertFlags(arguments_, 'pots-exact-worker');
});

test('an older Pi gets no unsupported worker flags and the bot bridge remains independent', t => {
  const launcherFixture = launcher(t, '--provider --model');
  const [arguments_] = launcherFixture.run('launched([\'pots-old-pi\']);');
  assert.equal(arguments_.includes('--human-dialog-worker'), false);
  assert.equal(arguments_.includes('--human-dialog-broker'), false);
  assert.equal(arguments_.at(-1), 'Read the brief.');
});

test('one help flag alone never opts a worker in, so no support is guessed', t => {
  const launcherFixture = launcher(t, '--human-dialog-worker --provider');
  const [arguments_] = launcherFixture.run('launched([\'pots-half-pi\']);');
  assert.equal(arguments_.includes('--human-dialog-worker'), false);
  assert.equal(arguments_.includes('--human-dialog-broker'), false);
});

test('a launcher that outlives a Pi upgrade gives the next worker both flags', t => {
  const launcherFixture = launcher(t, '--provider --model');
  const [before, after] = launcherFixture.run(`import { writeFileSync } from 'node:fs';
launched(['pots-before-upgrade']);
writeFileSync(process.env.PROOF_HELP, ${JSON.stringify(`${SUPPORTED}\n`)});
launched(['pots-after-upgrade']);`);
  assert.equal(before.includes('--human-dialog-worker'), false);
  assert.equal(before.includes('--human-dialog-broker'), false);
  assertFlags(after, 'pots-after-upgrade');
});
