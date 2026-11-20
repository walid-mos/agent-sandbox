import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { activationStateId } from './bot-activation.mjs';
import { DISCORD_ADMIN } from './bot-activation-registry.mjs';

const activationId = activationStateId(DISCORD_ADMIN);
const optedIn = { botActivation: { 'discord-admin': true } };
const activated = { ...optedIn, activation: { id: activationId, approval: 'a'.repeat(32), isInstalled: true, scope: { bot: 'discord-admin' },
  authority: { guildId: '100000000000000001', applicationId: '100000000000000002' } } };

function runCommand(t, command, mode, { botActivation, activation, input = '{}' } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'discord-admin-disabled-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const modulePath = name => fileURLToPath(new URL(name, import.meta.url));
  const preload = join(folder, 'preload.mjs');
  if (activation) {
    const state = join(folder, '.config/agent-sandbox/human/bot-activation-state');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, `${activationId}.json`), JSON.stringify(activation));
  }
  writeFileSync(join(folder, 'bot.json'), JSON.stringify({ channels: [{ type: 'discord', secrets: '/test-reference' }] }));
  writeFileSync(preload, `import { mock } from 'node:test';
mock.module(${JSON.stringify(modulePath('sandbox.mjs'))}, { exports: { isMastermind: true, sandbox: ${JSON.stringify({ role: 'mastermind', bot: 'Primary', doors: {}, botActivation })}, botHome: ${JSON.stringify(folder)}, potsBotHome: () => ${JSON.stringify(folder)} } });
mock.module(${JSON.stringify(modulePath('discord-admin-api.mjs'))}, { exports: { discordAdminApi: () => { throw new Error('CREDENTIAL_READ_ATTEMPT'); } } });
mock.module(${JSON.stringify(modulePath('router-bot.mjs'))}, { exports: { routerBotArguments: () => [], ensureRouterBot: () => { throw new Error('BOT_CREATION_ATTEMPT'); } } });
`);
  const modes = Array.isArray(mode) ? mode : [mode];
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-test-module-mocks', '--import', preload, modulePath(command), ...modes], { input, encoding: 'utf8', env: { ...process.env, HOME: folder } });
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
    const run = runCommand(t, 'discord-admin.mjs', 'inspect', { ...activated, input });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /one JSON request/);
    assert.doesNotMatch(run.stderr, /CREDENTIAL_READ_ATTEMPT/);
  });
}

test('actions does not advertise approval to revoke a role from the guild owner', testContext => {
  const run = runCommand(testContext, 'discord-admin.mjs', 'actions', activated);
  assert.equal(run.status, 0, run.stderr);
  const actions = JSON.parse(run.stdout);
  assert.ok(!actions.approvalRules.includes('Removing a role from the guild owner requires approval.'));
  assert.equal(actions.operations['role.revoke'].permission, 'ManageRoles');
});

test('disabled activation prepare refuses before credentials or bot creation', t => {
  const run = disabledCommand(t, 'bot-activate.mjs', ['discord-admin', 'prepare']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /disabled/);
  assert.doesNotMatch(run.stderr, /CREDENTIAL_READ_ATTEMPT|BOT_CREATION_ATTEMPT/);
});

test('a staged opt-in without a durable activation leaves the Admin CLI disabled', t => {
  const run = runCommand(t, 'discord-admin.mjs', 'actions', optedIn);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /registered owner activation/);
});

test('apply refuses an invalid approval before credentials or bot creation', t => {
  const run = runCommand(t, 'bot-activate.mjs', ['discord-admin', 'apply', 'unverified'], optedIn);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /registered activation dialog ID/);
  assert.doesNotMatch(run.stderr, /CREDENTIAL_READ_ATTEMPT|BOT_CREATION_ATTEMPT/);
});
