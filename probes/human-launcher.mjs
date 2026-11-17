import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const workers = new URL('../session/workers.mjs', import.meta.url).href;
const broker = fileURLToPath(new URL('../session/human.mjs', import.meta.url));

function launch(t, help) {
  const directory = mkdtempSync(join(tmpdir(), 'launcher-proof-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'launch.json');
  writeFileSync(join(directory, 'pi'), `#!/bin/sh\nprintf '%s\\n' '${help}'\n`, { mode: 0o700 });
  writeFileSync(join(directory, 'hc'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'run') writeFileSync(process.env.PROOF_LOG, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({address:'t-proof'}));
`, { mode: 0o700 });
  const script = `import { launch } from ${JSON.stringify(workers)};
launch({name:'pots-exact-worker',owner:'proof',worktree:'/tmp/worktree',model:'group/proof'}, ['Read the brief.']);`;
  const result = spawnSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}`, PROOF_LOG: log } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(log, 'utf8'));
}

test('a supported installed Pi gets the exact worker and absolute installed broker flags', t => {
  const arguments_ = launch(t, '--human-dialog-worker --human-dialog-broker');
  const workerFlag = arguments_.indexOf('--human-dialog-worker');
  assert.ok(workerFlag > 0);
  assert.equal(arguments_[workerFlag + 1], 'pots-exact-worker');
  assert.equal(arguments_[workerFlag + 2], '--human-dialog-broker');
  assert.equal(arguments_[workerFlag + 3], broker);
  assert.equal(arguments_.includes('--extension'), true);
  assert.equal(arguments_.includes('--session-id'), true);
  assert.equal(arguments_.at(-1), 'Read the brief.');
});

test('an older Pi gets no unsupported worker flags and the bot bridge remains independent', t => {
  const arguments_ = launch(t, '--provider --model');
  assert.equal(arguments_.includes('--human-dialog-worker'), false);
  assert.equal(arguments_.includes('--human-dialog-broker'), false);
  assert.equal(arguments_.at(-1), 'Read the brief.');
});
