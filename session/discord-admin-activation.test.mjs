import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

function disabledCommand(t, command, mode) {
  const folder = mkdtempSync(join(tmpdir(), 'discord-admin-disabled-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const modulePath = name => fileURLToPath(new URL(name, import.meta.url));
  const preload = join(folder, 'preload.mjs');
  writeFileSync(join(folder, 'bot.json'), JSON.stringify({ channels: [{ type: 'discord', secrets: '/test-reference' }] }));
  writeFileSync(preload, `import { mock } from 'node:test';
mock.module(${JSON.stringify(modulePath('sandbox.mjs'))}, { exports: { isMastermind: true, sandbox: { role: 'mastermind', bot: 'Primary', doors: {} }, botHome: ${JSON.stringify(folder)}, potsBotHome: () => ${JSON.stringify(folder)} } });
mock.module(${JSON.stringify(modulePath('discord-admin-api.mjs'))}, { exports: { discordAdminApi: () => { throw new Error('CREDENTIAL_READ_ATTEMPT'); } } });
mock.module(${JSON.stringify(modulePath('router-bot.mjs'))}, { exports: { ensureRouterBot: () => { throw new Error('BOT_CREATION_ATTEMPT'); } } });
`);
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-test-module-mocks', '--import', preload, modulePath(command), mode], { input: '{}', encoding: 'utf8' });
}

for (const mode of ['operate', 'register', 'approve', 'inspect']) {
  test(`disabled Mastermind ${mode} refuses before credentials or network`, t => {
    const run = disabledCommand(t, 'discord-admin.mjs', mode);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /disabled/);
    assert.doesNotMatch(run.stderr, /CREDENTIAL_READ_ATTEMPT|BOT_CREATION_ATTEMPT/);
  });
}

test('disabled Mastermind bootstrap skips bot creation', t => {
  const run = disabledCommand(t, 'discord-admin-bot.mjs', '');
  assert.equal(run.status, 0);
  assert.match(run.stdout, /disabled/);
  assert.doesNotMatch(run.stderr, /CREDENTIAL_READ_ATTEMPT|BOT_CREATION_ATTEMPT/);
});
