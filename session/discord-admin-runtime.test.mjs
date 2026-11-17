import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverProtection, discordAccount } from './discord-admin-runtime.mjs';
import { fixture, guildId, protectedId, threadId } from '../probes/fixtures/discord-admin.mjs';

function runtime(t) {
  const folder = mkdtempSync(join(tmpdir(), 'discord-admin-runtime-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const primaryHome = join(folder, 'primary');
  const metadata = join(primaryHome, 'workspace/discord');
  mkdirSync(metadata, { recursive: true });
  for (const file of ['routes.json', 'north-star-threads.json']) copyFileSync(new URL(`../probes/fixtures/discord-admin-metadata/${file}`, import.meta.url), join(metadata, file));
  const dependencies = fixture();
  dependencies.channels.find(channel => channel.id === protectedId).name = 'primary';
  const api = (method, path, ...arguments_) => path === '/users/@me/guilds' ? [{ id: guildId }] : dependencies.api(method, path, ...arguments_);
  return { api, config: { bot: 'Primary', doors: {} }, primaryHome, stateDirectory: join(folder, 'state'), metadata, dependencies };
}

test('protection comes from owning maps and keeps cached pot IDs after renames', async t => {
  const proof = runtime(t);
  const first = await discoverProtection(proof);
  assert.deepEqual(first.channelIds, [protectedId, threadId]);
  assert.deepEqual(first.threadIds, [threadId]);
  assert.equal(first.channelIds.includes('100000000000000090'), false);
  assert.equal(first.channelIds.includes('100000000000000091'), false);
  assert.equal(first.channelIds.includes('100000000000000092'), false);
  proof.dependencies.channels.find(channel => channel.id === protectedId).name = 'renamed';
  assert.deepEqual(await discoverProtection(proof), first);
});

test('all configured pot channels including Personal are protected and cached by ID', async t => {
  const proof = runtime(t);
  proof.config = { bot: 'Mastermind', doors: { nextnode: 'Development', accor: 'Client', personal: 'Personal' } };
  proof.dependencies.channels.find(channel => channel.id === protectedId).name = 'mastermind';
  const potIds = ['100000000000000071', '100000000000000072', '100000000000000073'];
  Object.keys(proof.config.doors).forEach((name, index) => proof.dependencies.channels.push({ id: potIds[index], guild_id: guildId, type: 0, name }));
  const first = await discoverProtection(proof);
  for (const id of [protectedId, ...potIds]) assert.equal(first.channelIds.includes(id), true);
  proof.dependencies.channels.find(channel => channel.id === potIds[2]).name = 'renamed-personal';
  assert.deepEqual(await discoverProtection(proof), first);
});

test('a deleted and recreated pot channel is found again by its name', async t => {
  const proof = runtime(t);
  await discoverProtection(proof);
  const recreatedId = '100000000000000074';
  const channels = proof.dependencies.channels;
  channels.splice(channels.findIndex(channel => channel.id === protectedId), 1, { id: recreatedId, guild_id: guildId, type: 0, name: 'primary' });
  assert.equal((await discoverProtection(proof)).channelIds.includes(recreatedId), true);
});

test('missing owning thread map prevents administration', async t => {
  const proof = runtime(t);
  rmSync(join(proof.metadata, 'north-star-threads.json'));
  await assert.rejects(discoverProtection(proof), /missing or invalid/);
});

test('ambiguous pot channels and guild membership fail closed', async t => {
  const proof = runtime(t);
  proof.dependencies.channels.push({ id: '100000000000000040', name: 'primary', type: 0 });
  await assert.rejects(discoverProtection(proof), /pot channel/);
  proof.api = () => [{ id: guildId }, { id: '200000000000000001' }];
  await assert.rejects(discoverProtection(proof), /exactly one guild/);
});

for (const invalid of [[], {}, { unrelated: '100000000000000090' }]) {
  test(`unknown routing map shape fails closed: ${JSON.stringify(invalid)}`, async t => {
    const proof = runtime(t);
    writeFileSync(join(proof.metadata, 'routes.json'), JSON.stringify(invalid));
    await assert.rejects(discoverProtection(proof), /metadata|route/);
  });
}

for (const change of [registry => { registry.threads = []; }, registry => { delete registry.posts; }, registry => { registry.threads[0].thread += '/extra'; },
  registry => { registry.overview = registry.overview.replace(guildId, '200000000000000001'); }]) {
  test('invalid or incomplete North Star metadata fails closed', async t => {
    const proof = runtime(t);
    const path = join(proof.metadata, 'north-star-threads.json');
    const registry = JSON.parse(readFileSync(path, 'utf8'));
    change(registry);
    writeFileSync(path, JSON.stringify(registry));
    await assert.rejects(discoverProtection(proof), /metadata|guild/);
  });
}

test('private Discord account selection refuses missing or duplicate accounts', t => {
  const proof = runtime(t);
  const definition = join(proof.primaryHome, 'bot.json');
  writeFileSync(definition, JSON.stringify({ channels: [] }));
  assert.throws(() => discordAccount(proof.primaryHome), /exactly one/);
  const account = { id: 'discord', type: 'discord', secrets: '~/.pots/secrets/existing.env' };
  writeFileSync(definition, JSON.stringify({ channels: [account, account] }));
  assert.throws(() => discordAccount(proof.primaryHome), /exactly one/);
  writeFileSync(definition, JSON.stringify({ channels: [account] }));
  assert.deepEqual(discordAccount(proof.primaryHome), account);
});
