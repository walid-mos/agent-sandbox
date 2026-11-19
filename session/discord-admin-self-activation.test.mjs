import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discordAdminActivation } from './discord-admin-activation.mjs';
import { isDiscordAdminEnabled } from './discord-admin-enabled.mjs';
import { acceptDiscordClick } from './discord-clicks.mjs';
import { humanStore } from './human-store.mjs';
import { botId, channelId, guildId, ownerId, userId } from '../probes/fixtures/discord-admin.mjs';

const messageId = '100000000000000020';
const configuration = { role: 'mastermind', discordAdmin: { enabled: true } };

async function setup(t, install = async () => {}) {
  const folder = mkdtempSync(join(tmpdir(), 'discord-admin-self-activation-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const clicks = humanStore(join(folder, 'clicks'));
  const pending = humanStore(join(folder, 'pending'));
  const state = humanStore(join(folder, 'state'));
  let display;
  let currentOwner = ownerId;
  let failure;
  const api = async (method, path) => {
    assert.equal(method, 'GET');
    if (failure) throw failure;
    if (path === `/guilds/${guildId}`) return { id: guildId, owner_id: currentOwner };
    if (path === '/users/@me/guilds') return [{ id: guildId }];
    if (path === '/users/@me') return { id: botId };
    if (path === `/channels/${channelId}/messages/${messageId}`) return display;
    assert.fail(`Unexpected Discord request ${path}`);
  };
  const open = () => discordAdminActivation({ api, clicks, pending, state, channelAccount: 'discord', install });
  const activation = open();
  const prepared = await activation.prepare();
  const { approval } = prepared;
  display = { id: messageId, channel_id: channelId, author: { id: botId }, ...prepared.message };
  const register = () => activation.register({ dialog: approval, messages: [{ channelId, messageId }] });
  const click = (index = 0, id = ownerId) => {
    const components = display.components.map(row => ({ ...row, components: row.components.map(button => ({ ...button, disabled: false })) }));
    const raw = JSON.stringify({ type: 3, guild_id: guildId, channel_id: channelId, member: { user: { id } },
      message: { ...display, components }, data: { custom_id: `human:${approval}:0:${index}` } });
    return acceptDiscordClick({ raw }, { store: clicks, channelAccount: 'discord' });
  };
  return { activation, open, approval, clicks, pending, state, register, click, changeOwner: id => { currentOwner = id; }, failDiscord: () => { failure = new Error('Discord unavailable'); } };
}

test('the private opt-in alone cannot enable administration', () => {
  assert.equal(isDiscordAdminEnabled(configuration), false);
});

test('a pick saved by an older handler cannot authorize activation', async t => {
  const proof = await setup(t, () => assert.fail('bot installed from unchecked click'));
  await proof.register();
  await proof.click();
  const record = proof.clicks.get(proof.approval);
  const entry = Object.values(record.picks)[0];
  delete entry.ownerDisplayVerified;
  await proof.clicks.patch(proof.approval, { picks: record.picks });
  await assert.rejects(proof.activation.apply(proof.approval), /handler.*verif/i);
  assert.equal(proof.pending.get(proof.approval).consumed, undefined);
});

test('cancellation and a non-owner click leave installation disabled', async t => {
  const proof = await setup(t, () => assert.fail('bot installed without approval'));
  assert.equal((await proof.click()).status, 'unhandled');
  await proof.register();
  await assert.rejects(proof.click(0, userId), /owner/);
  assert.equal((await proof.activation.apply(proof.approval)).status, 'approval_pending');
  await proof.click(1);
  assert.equal((await proof.activation.apply(proof.approval)).status, 'declined');
  assert.equal((await proof.open().apply(proof.approval)).status, 'declined');
  assert.equal(proof.pending.get(proof.approval).consumed.evidence.userId, ownerId);
  assert.equal(proof.state.all().length, 0);
});

test('an interrupted installation resumes with the same consumed receipt and completes once', async t => {
  let installed = 0;
  const proof = await setup(t, () => {
    installed++;
    if (installed === 1) throw new Error('Pots installation interrupted');
  });
  await proof.register();
  await proof.click();
  await assert.rejects(proof.activation.apply(proof.approval), /installation interrupted/);
  const receipt = proof.pending.get(proof.approval).consumed;
  assert.equal(receipt.evidence.userId, ownerId);
  assert.equal(proof.state.all().length, 0);
  assert.deepEqual((await Promise.all([proof.open().apply(proof.approval), proof.open().apply(proof.approval)])).map(result => result.status), ['activated', 'already_active']);
  assert.deepEqual(proof.pending.get(proof.approval).consumed, receipt);
  assert.equal(proof.state.all().length, 1);
  assert.equal(installed, 2);
});

test('Discord failure or an owner change stops activation before installation', async t => {
  const proof = await setup(t, () => assert.fail('installation started without current owner proof'));
  await proof.register();
  await proof.click();
  proof.changeOwner(userId);
  await assert.rejects(proof.activation.apply(proof.approval), /owner changed/);
  proof.failDiscord();
  await assert.rejects(proof.activation.apply(proof.approval), /Discord unavailable/);
  assert.equal(proof.pending.get(proof.approval).consumed, undefined);
  assert.equal(proof.state.all().length, 0);
});
