import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const sandboxModule = new URL('./sandbox.mjs', import.meta.url).href;
const installerModule = new URL('./discord-admin-bot.mjs', import.meta.url).href;
const signedInstructions = new URL('./discord-admin/AGENTS.md', import.meta.url).pathname;
const fakePots = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const root = process.env.FIXTURE_ROOT;
const home = join(root, 'discord-admin');
const mode = readFileSync(join(root, 'mode'), 'utf8');
const args = process.argv.slice(2);
if (args[0] === 'status') {
  if (mode === 'down') { console.log('gateway: not running'); process.exit(0); }
  const hasBot = existsSync(join(home, 'bot.json'));
  console.log('gateway: running (process ' + (mode === 'replaced' && hasBot ? 82 : 81) + ')');
  if (hasBot && mode !== 'undiscovered') console.log('discord-admin: Discord Admin, magpie/group/router, idle, channels terminal');
  process.exit(0);
}
appendFileSync(join(root, 'creation'), JSON.stringify(args) + '\\n');
mkdirSync(home);
writeFileSync(join(home, 'bot.json'), JSON.stringify({ name: 'Discord Admin', model: 'magpie/group/router', channels: [{ type: 'terminal' }] }));
`;

function setup(t) {
  const folder = mkdtempSync(join(tmpdir(), 'discord-admin-pots-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const home = join(folder, 'discord-admin');
  const creation = join(folder, 'creation');
  const descriptor = join(folder, 'lock');
  writeFileSync(descriptor, '');
  writeFileSync(join(folder, 'pots'), fakePots, { mode: 0o700 });
  const code = `import { openSync } from 'node:fs'; import { mock } from 'node:test';
mock.module(${JSON.stringify(sandboxModule)}, { exports: { potsBotHome: id => process.env.FIXTURE_ROOT + '/' + id } });
const { installDiscordAdminBot } = await import(${JSON.stringify(installerModule)});
installDiscordAdminBot(openSync(${JSON.stringify(descriptor)}, 'r'));
`;
  const run = mode => {
    writeFileSync(join(folder, 'mode'), mode);
    return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-test-module-mocks', '--input-type=module', '-e', code], {
      encoding: 'utf8', env: { PATH: `${folder}:${process.env.PATH}`, FIXTURE_ROOT: folder },
    });
  };
  return { home, creation, run };
}

test('the installer refuses a stopped gateway before Pots bot new', t => {
  const proof = setup(t);
  const attempt = proof.run('down');
  assert.equal(attempt.status, 1);
  assert.match(attempt.stderr, /gateway is not running/);
  assert.equal(existsSync(proof.creation), false);
});

for (const failure of ['undiscovered', 'replaced']) {
  test(`installation resumes without creating the bot twice after a ${failure} gateway result`, t => {
    const proof = setup(t);
    const attempt = proof.run(failure);
    assert.equal(attempt.status, 1);
    assert.match(attempt.stderr, /original gateway did not confirm/);
    const retry = proof.run('healthy');
    assert.equal(retry.status, 0, retry.stderr);
    const [command] = readFileSync(proof.creation, 'utf8').trimEnd().split('\n');
    assert.deepEqual(JSON.parse(command).slice(0, 9), ['bot', 'new', 'Discord Admin', '--id', 'discord-admin', '--model', 'magpie/group/router', '--judge', 'off']);
    assert.equal(readFileSync(proof.creation, 'utf8').trimEnd().split('\n').length, 1);
    assert.equal(readlinkSync(join(proof.home, 'AGENTS.md')), signedInstructions);
  });
}

test('installation refuses a conflicting bot home before linking instructions', t => {
  const proof = setup(t);
  mkdirSync(proof.home);
  writeFileSync(join(proof.home, 'bot.json'), JSON.stringify({ name: 'Discord Admin', model: 'magpie/group/router', channels: [{ type: 'discord' }] }));
  const attempt = proof.run('healthy');
  assert.equal(attempt.status, 1);
  assert.match(attempt.stderr, /terminal-only/);
  assert.equal(existsSync(join(proof.home, 'AGENTS.md')), false);
  assert.equal(existsSync(proof.creation), false);
});
