import assert from 'node:assert/strict';
import { acceptDiscordClick } from './discord-clicks.mjs';
import { botId, channelId, guildId, ownerId } from '../probes/fixtures/discord-admin.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { humanStore } from './human-store.mjs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const modulePath = name => fileURLToPath(new URL(name, import.meta.url));
const messageId = '100000000000000020';
const admin = 'discord-admin';
const status = 'session-status';
const fakePots = String.raw`#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const root = process.env.ACTIVATION_FIXTURE;
const bots = join(root, 'bots');
const args = process.argv.slice(2);
if (args[0] === 'status') {
  console.log('gateway: running (process 81)');
  if (existsSync(join(root, 'interrupted'))) process.exit(0);
  for (const id of readdirSync(bots)) {
    const { name, model } = JSON.parse(readFileSync(join(bots, id, 'bot.json'), 'utf8'));
    console.log(id + ': ' + name + ', ' + model + ', idle, channels terminal');
  }
  process.exit(0);
}
if (args[0] !== 'bot' || args[1] !== 'new') process.exit(2);
const home = join(bots, args[4]);
mkdirSync(home);
writeFileSync(join(home, 'bot.json'), JSON.stringify({ name: args[2], model: args[6], channels: [{ type: 'terminal' }] }));
appendFileSync(join(root, 'creations'), JSON.stringify(args) + '\n');
`;

function setup(t, optIn = { [admin]: true, [status]: true }) {
  const root = mkdtempSync(join(tmpdir(), 'bot-activate-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bots'));
  writeFileSync(join(root, 'bot.json'), JSON.stringify({ channels: [{ type: 'discord', id: 'discord', secrets: '/fixture-only' }] }));
  writeFileSync(join(root, 'pots'), fakePots, { mode: 0o700 });
  const configuration = { role: 'mastermind', bot: 'Mastermind', botActivation: optIn };
  const preload = join(root, 'mock.mjs');
  writeFileSync(preload, `import { mock } from 'node:test';
import { readFileSync } from 'node:fs';
mock.module(${JSON.stringify(modulePath('sandbox.mjs'))}, { exports: { sandbox: ${JSON.stringify(configuration)}, botHome: ${JSON.stringify(root)}, potsBotHome: id => ${JSON.stringify(join(root, 'bots'))} + '/' + id } });
mock.module(${JSON.stringify(modulePath('discord-admin-api.mjs'))}, { exports: { discordAdminApi: () => async (method, path) => {
  if (method !== 'GET') throw new Error('Unexpected mutation');
  if (path === '/users/@me/guilds') return [{ id: '${guildId}' }];
  if (path === '/users/@me') return { id: '${botId}' };
  if (path === '/guilds/${guildId}') return { id: '${guildId}', owner_id: '${ownerId}' };
  if (path === '/channels/${channelId}/messages/${messageId}') return JSON.parse(readFileSync(${JSON.stringify(join(root, 'display'))}, 'utf8'));
  throw new Error('Unexpected Discord read ' + path);
} } });
`);
  const env = { ...process.env, HOME: root, ACTIVATION_FIXTURE: root, PATH: `${root}:${process.env.PATH}` };
  const run = (arguments_, input) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-test-module-mocks', '--import', preload, modulePath('bot-activate.mjs'), ...arguments_], { input, env, encoding: 'utf8' });
  const invoke = (arguments_, input) => {
    const result = run(arguments_, input && JSON.stringify(input));
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { root, run, invoke };
}

async function registerAndApprove(proof, bot, prepared) {
  const { approval, message } = prepared;
  const display = { id: messageId, channel_id: channelId, author: { id: botId }, ...message };
  writeFileSync(join(proof.root, 'display'), JSON.stringify(display));
  const registration = { dialog: approval, messages: [{ channelId, messageId }] };
  assert.equal(proof.invoke([bot, 'register'], registration).state, 'acknowledged');
  const components = display.components.map(row => ({ ...row, components: row.components.map(button => ({ ...button, disabled: false })) }));
  const raw = JSON.stringify({ type: 3, guild_id: guildId, channel_id: channelId, member: { user: { id: ownerId } },
    message: { ...display, components }, data: { custom_id: `human:${approval}:0:0` } });
  const clicks = humanStore(join(proof.root, '.config/agent-sandbox/human/discord'));
  assert.equal((await acceptDiscordClick({ raw }, { store: clicks, channelAccount: 'discord' })).status, 'accepted');
}

const preparations = {
  [admin]: { name: 'Discord Admin', files: ['AGENTS.md', 'responsibilities.md'] },
  [status]: { name: 'Session Status', files: ['AGENTS.md'] },
};

function assertScope(bot, prepared) {
  const { scope } = prepared.question;
  const { name, files } = preparations[bot];
  const binding = JSON.parse(scope);
  const args = ['bot', 'new', name, '--id', bot, '--model', 'magpie/group/router', '--judge', 'off'];
  assert.deepEqual(binding.install.slice(0, args.length), args);
  assert.deepEqual(binding.instructions, Object.fromEntries(files.map(file => [file,
    createHash('sha256').update(readFileSync(modulePath(`${bot}/${file}`))).digest('hex')])));
  const { instructions, install, ...authority } = binding;
  assert.deepEqual(authority, { action: 'bot.activate', applicationId: botId, bot, guildId, handler: 'discord-owner-display-v1', ownerId, session: { bot: 'Mastermind', host: hostname() } });
  assert.ok(prepared.message.content.includes(scope));
  return binding;
}

for (const bot of [admin, status]) {
  test(`the public CLI installs ${bot} under its exact registered scope`, async t => {
    const proof = setup(t);
    const prepared = proof.invoke([bot, 'prepare']);
    const binding = assertScope(bot, prepared);
    await registerAndApprove(proof, bot, prepared);
    assert.deepEqual(proof.invoke([bot, 'apply', prepared.approval]), { status: 'activated', approval: prepared.approval });
    assert.equal(proof.invoke([bot, 'status']).status, 'already_active');
    assert.equal(proof.invoke([bot === admin ? status : admin, 'status']).status, 'awaiting_activation');
    assert.deepEqual(JSON.parse(readFileSync(join(proof.root, 'creations'), 'utf8')), binding.install);
    assert.equal(readlinkSync(join(proof.root, 'bots', bot, 'AGENTS.md')), modulePath(`${bot}/AGENTS.md`));
  });
}

test('the public CLI refuses to register or apply another bot’s receipt', async t => {
  const proof = setup(t);
  const prepared = proof.invoke([admin, 'prepare']);
  const wrongRegistration = proof.run([status, 'register'], JSON.stringify({ dialog: prepared.approval, messages: [{ channelId, messageId }] }));
  assert.equal(wrongRegistration.status, 1);
  assert.match(wrongRegistration.stderr, /another/);
  await registerAndApprove(proof, admin, prepared);
  const rejected = proof.run([status, 'apply', prepared.approval]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /another/);
  assert.equal(existsSync(join(proof.root, 'creations')), false);
  assert.equal(proof.invoke([admin, 'apply', prepared.approval]).status, 'activated');
  assert.equal(proof.run([status, 'apply', prepared.approval]).status, 1);
});

test('the public CLI resumes Session Status after creation without creating it twice', async t => {
  const proof = setup(t);
  const prepared = proof.invoke([status, 'prepare']);
  const other = proof.invoke([status, 'prepare']);
  await registerAndApprove(proof, status, other);
  await registerAndApprove(proof, status, prepared);
  const interruption = join(proof.root, 'interrupted');
  writeFileSync(interruption, '');
  const attempt = proof.run([status, 'apply', prepared.approval]);
  assert.equal(attempt.status, 1);
  assert.match(attempt.stderr, /original gateway did not confirm/);
  assert.deepEqual(proof.invoke([status, 'status']), { status: 'installation_pending', approval: prepared.approval });
  rmSync(interruption);
  const wrongReceipt = proof.run([status, 'apply', other.approval]);
  assert.equal(wrongReceipt.status, 1);
  assert.match(wrongReceipt.stderr, /same approval/);
  assert.equal(proof.invoke([status, 'apply', prepared.approval]).status, 'activated');
  assert.equal(proof.invoke([status, 'apply', prepared.approval]).status, 'already_active');
  assert.equal(readFileSync(join(proof.root, 'creations'), 'utf8').trimEnd().split('\n').length, 1);
});

test('the public CLI refuses an unregistered bot and a disabled registered bot', t => {
  const proof = setup(t, { [admin]: true, [status]: false, '../../untrusted': true });
  assert.deepEqual(proof.invoke([status, 'status']), { status: 'disabled' });
  assert.match(proof.run([status, 'prepare']).stderr, /disabled/);
  assert.match(proof.run(['../../untrusted', 'prepare']).stderr, /registered bot/);
  assert.match(proof.run([admin, 'prepare', '--service=arbitrary']).stderr, /usage/i);
  assert.equal(existsSync(join(proof.root, 'creations')), false);
});
