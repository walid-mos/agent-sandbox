import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

function runCommand(t, command, mode, { discordAdmin, input = '{}' } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'discord-admin-disabled-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const modulePath = name => fileURLToPath(new URL(name, import.meta.url));
  const preload = join(folder, 'preload.mjs');
  writeFileSync(join(folder, 'bot.json'), JSON.stringify({ channels: [{ type: 'discord', secrets: '/test-reference' }] }));
  writeFileSync(preload, `import { mock } from 'node:test';
mock.module(${JSON.stringify(modulePath('sandbox.mjs'))}, { exports: { isMastermind: true, sandbox: ${JSON.stringify({ role: 'mastermind', bot: 'Primary', doors: {}, discordAdmin })}, botHome: ${JSON.stringify(folder)}, potsBotHome: () => ${JSON.stringify(folder)} } });
mock.module(${JSON.stringify(modulePath('discord-admin-api.mjs'))}, { exports: { discordAdminApi: () => { throw new Error('CREDENTIAL_READ_ATTEMPT'); } } });
mock.module(${JSON.stringify(modulePath('router-bot.mjs'))}, { exports: { ensureRouterBot: () => { throw new Error('BOT_CREATION_ATTEMPT'); } } });
`);
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-test-module-mocks', '--import', preload, modulePath(command), mode], { input, encoding: 'utf8' });
}

const disabledCommand = (t, command, mode) => runCommand(t, command, mode);

for (const mode of ['operate', 'register', 'approve', 'inspect']) {
  test(`disabled Mastermind ${mode} refuses before credentials or network`, t => {
    const run = disabledCommand(t, 'discord-admin.mjs', mode);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /disabled/);
    assert.doesNotMatch(run.stderr, /CREDENTIAL_READ_ATTEMPT|BOT_CREATION_ATTEMPT/);
  });
}

for (const input of ['null', '[]', '"inspect"']) {
  test(`enabled command refuses a non-object request before credentials: ${input}`, t => {
    const run = runCommand(t, 'discord-admin.mjs', 'inspect', { discordAdmin: { enabled: true }, input });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /one JSON request/);
    assert.doesNotMatch(run.stderr, /CREDENTIAL_READ_ATTEMPT/);
  });
}

test('actions does not advertise approval to revoke a role from the guild owner', testContext => {
  const run = runCommand(testContext, 'discord-admin.mjs', 'actions', { discordAdmin: { enabled: true } });
  assert.equal(run.status, 0, run.stderr);
  const actions = JSON.parse(run.stdout);
  assert.ok(!actions.approvalRules.includes('Removing a role from the guild owner requires approval.'));
  assert.equal(actions.operations['role.revoke'].permission, 'ManageRoles');
});

test('disabled Mastermind bootstrap skips bot creation', t => {
  const run = disabledCommand(t, 'discord-admin-bot.mjs', '');
  assert.equal(run.status, 0);
  assert.match(run.stdout, /disabled/);
  assert.doesNotMatch(run.stderr, /CREDENTIAL_READ_ATTEMPT|BOT_CREATION_ATTEMPT/);
});
