import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverProtection, discordAccount } from './discord-admin-runtime.mjs';
import { fixture, guildId, protectedId } from '../probes/fixtures/discord-admin.mjs';

function runtime(t) {
  const folder = mkdtempSync(join(tmpdir(), 'discord-admin-runtime-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const primaryHome = join(folder, 'primary');
  const metadata = join(primaryHome, 'workspace/discord');
  mkdirSync(metadata, { recursive: true });
  writeFileSync(join(metadata, 'routes.json'), JSON.stringify({ pot: { channelId: protectedId } }));
  writeFileSync(join(metadata, 'north-star-threads.json'), '{}');
  const dependencies = fixture();
  dependencies.channels.find(channel => channel.id === protectedId).name = 'primary';
  const api = (method, path, ...arguments_) => path === '/users/@me/guilds' ? [{ id: guildId }] : dependencies.api(method, path, ...arguments_);
  return { api, config: { bot: 'Primary', doors: {} }, primaryHome, stateDirectory: join(folder, 'state'), metadata, dependencies };
}

test('protection comes from owning maps and keeps cached pot IDs after renames', async t => {
  const proof = runtime(t);
  const first = await discoverProtection(proof);
  assert.deepEqual(first.channelIds, [protectedId]);
  proof.dependencies.channels.find(channel => channel.id === protectedId).name = 'renamed';
  assert.deepEqual(await discoverProtection(proof), first);
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
